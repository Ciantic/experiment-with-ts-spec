# Queries

Reading is a product decision, not a mapping of the spec. `packages/spec/src/queries/`
holds the query **arguments** as `@query`-annotated type aliases; a generator turns
those into the typed read interfaces and their wiring in the backend; one
hand-written resolver turns a selection into SQL. See "Why the resolver is hand-written".

- `packages/spec/src/queries/selection.ts` — `Selection`/`Selected`, the
  column-limiting types. Hand-written.
- `packages/spec/src/queries/<Entity>Queries.ts` — the `@query`-annotated argument
  aliases. Hand-written.
- `packages/backend/scripts/generate-query-metadata.ts` — the generator.
- `packages/backend/src/db/queries/` — generated: `model.ts` (metadata),
  `<entity>Queries.ts` (interface + factory), `index.ts` (barrel).
- `packages/backend/src/db/resolvers.ts` — the reader. Hand-written.
- `packages/validation/src/queries/` — generated `@query` argument schemas. See
  `docs/validation.md`.

- `pnpm generate:queries` — writes the generated modules.
- `pnpm generate:queries --out <dir>` — writes elsewhere. A missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand.

## Why a separate directory

`operations/` is where a mutation contract lives; `queries/` is its read
counterpart. Both sit outside `domain/`, so neither is read as an entity:

- The generators parse entities from `domain/**` and type aliases from all of
  `src/**` (`DEFAULT_SPEC_GLOB` vs `SPEC_GLOB` in
  `packages/spec/scripts/spec-model.ts`).
- The linter scans interfaces from `domain/**` only, and type aliases from all
  of `src/**`. A type alias outside `domain/` is therefore scanned — which is
  what lets `@query` be validated — while an interface there is a contract, not
  an entity.

`@query` sits on a **type alias**, not an interface, for exactly that reason: the
linter scans type aliases everywhere, so the tag gets validated for free. A
field-bearing interface in `queries/` would be linted as an entity; a type alias
is not.

## `@query`

```
@query Invoice many
```

A `@query <Entity> [one|many]` alias declares one read. Its name becomes the
method name (first letter lower-cased); its object type is the arguments. `one`
returns `Selected<…> | undefined`, `many` a list, with `many` the default. The
namespace and method are separate: the tag's entity is the source table, the
alias name the operation.

```ts
/**
 * @query Invoice many
 */
export type ListInvoices = {
    customerId?: CustomerId;
};
```

The linter rejects a missing entity, an unknown cardinality, extra tokens, a
non-object-literal type, and an entity that is not an interface in `domain/`.

## Selection

A query does not return a whole entity by default. It returns the fields the
caller asks for, narrowed in the type system. `Selection` describes what may be
asked; `Selected` is the result.

```ts
/** The fields a caller wants: `true` for a scalar, a nested `Selection` for a branch. */
export type Selection<E> = {
    [K in keyof E]?: Scalar<E[K]> extends true ? true : true | Selection<ElementOf<E[K]>>;
};

/** The result of `E` under selection `S`: only the selected keys, each optional. */
export type Selected<E, S> = {
    [K in keyof S & keyof E]?: NonNullable<S[K]> extends true
        ? E[K]
        : IsArray<E[K]> extends true
            ? Selected<ElementOf<E[K]>, NonNullable<S[K]>>[]
            : Selected<ElementOf<E[K]>, NonNullable<S[K]>>;
};
```

A scalar is selected with `true`; a branch (a child collection or a relation) is
selected either with `true` — every scalar of the branch — or with a nested
`Selection`. Properties not named are absent from the result, not `undefined`.

What counts as a scalar is decided by `Scalar`, which reads the zod `$brand`
that `@primitive` already puts on every primitive:

```ts
type Scalar<T> =
    NonNullable<T> extends string | number | boolean | bigint | Date | $brand<any> ? true : false;
```

The brand is load-bearing. A structural `extends object` test cannot tell a
scalar from an entity: `Money`, `InvoiceId`, and `Version` are branded
primitives and all satisfy `extends object`, exactly like `InvoiceRow`. Without
the brand, `select: { totalAmount: { … } }` would type-check and recurse into a
decimal.

## A query, generated

From the alias above and a `@query Invoice one` `GetInvoice`, the generator emits:

```ts
export interface InvoiceQueries {
    getInvoice<S extends Selection<Invoice>>(opts: GetInvoice & { select: S }): Promise<Selected<Invoice, S> | undefined>;
    listInvoices<S extends Selection<Invoice>>(opts: ListInvoices & { select: S }): Promise<Selected<Invoice, S>[]>;
}

const resolver = createResolver(queryModel);

export function invoiceQueries(db: SqlExecutor): InvoiceQueries {
    return {
        getInvoice: <S extends Selection<Invoice>>(opts: GetInvoice & { select: S }) => {
            const { select, ...args } = opts;
            return resolver.resolveOne<Invoice, S>(db, "invoice", args, { select });
        },
        listInvoices: <S extends Selection<Invoice>>(opts: ListInvoices & { select: S }) => {
            const { select, ...args } = opts;
            return resolver.resolveMany<Invoice, S>(db, "invoice", args, { select });
        },
    };
}
```

A read takes **one argument**: the `@query` alias's fields are the filters, and
`select` is intersected in by the generator. The factory then splits it back
apart for the resolver, whose signature keeps filters and projection explicit.

A call site narrows exactly:

```ts
const [invoice] = await invoiceQueries(db).listInvoices({
    customerId,
    select: { id: true, number: true, totalAmount: true, rows: { description: true, totalAmount: true } },
});
// invoice.rows![0].totalAmount  ✓
// invoice.rows![0].taxAmount    ✗  not selected
// invoice.notes                 ✗  not selected
```

The compiler rejects a field that is not on the entity, a nested selection on a
scalar, and a field not named in the selection.

The generator emits the **contract and the wiring**, never SQL. It reads only
annotations: `@query` for the entity and cardinality, the existing table model
for the columns, and the branch tags below. No domain name is hardcoded, so a
new `@query` alias and a new entity flow through with no generator edit.

## What is generated, and what is not

| Artifact | Source |
| --- | --- |
| `<Entity>Queries` interface + factory | generated |
| `queryModel` (tables, fields, branches) | generated |
| `resolveOne` / `resolveMany` | hand-written, once |

`queryModel` is the physical model: for each table its key, its scalar fields,
and a descriptor per branch (see below). The resolver reads that data plus the
runtime `args`/`select`, and builds the SQL. The generated factories carry no
logic — they name a table as a string and delegate.

## Selecting a branch means three different things

`Invoice.rows`, `Invoice.customer`, and `InvoiceSent.customer` nest identically
at the call site and are not the same storage:

| Nested field | Annotation | Storage | SQL |
| --- | --- | --- | --- |
| `Invoice.rows` | `@children` | child table, FK `invoiceId` | join |
| `Invoice.customer` | `@relation` | FK `customerId` | join to the **live** row |
| `InvoiceSent.customer` | `@inlined` | flattened `customerName`, `customerEmail`, … | no join, prefix columns |

An inlined branch is not a join: its columns are already on the row. The
freshness differs too — a relation reads the current record, an inlined value is
the frozen snapshot — and the call site cannot tell them apart. See
`docs/invoice-snapshotting.md`.

The generator records the distinction in `queryModel`, from the branch tags the
table model already carries (`packages/backend/scripts/postgres-model.ts`):

```ts
customer: { kind: "relation", table: "customer", column: "customerId" }
rows:     { kind: "children", table: "invoice_row", column: "invoiceId" }
snapshot: { kind: "inlined", table: "customer", columns: { name: "customerName" } }
```

Relation and inlined columns are excluded from the table's selectable `fields`;
they are reached through their branch. A scalar foreign key such as
`InvoiceRow.invoiceId` stays a field, because it is a real spec field.

## The resolver reads one query per branch

`resolveOne`/`resolveMany` (`packages/backend/src/db/resolvers.ts`) build
the SQL at run time from `queryModel` plus the selection:

- **Scalars** — projected into the root query.
- **`@inlined`** — projected from the same row, aliased per target field. No query.
- **`@relation`** — one batched `where target.key in (…)` for every distinct
  foreign key, attached back by key.
- **`@children`** — one batched `where child.fk in (…)`, grouped in memory.

There is **no JSON aggregation**. A branch costs one extra query, batched over
all parents at that level; nested branches recurse the same way, one query per
branch per level. The resolver holds no domain knowledge — it only reads
`queryModel`, so a new entity and `@query` alias need no resolver change.

Arguments filter by equality: a scalar field (`id`) or a relation's foreign-key
column (`customerId`) both work. An unknown filter field throws rather than
silently dropping a clause. `String`, `Date`, and `decimal` values pass through
unchanged.

`resolveOne` fetches and returns the first row; there is no `limit 1`.

## Gotchas

- **Every selected key is optional.** All spec fields are optional, so
  `Selected<Invoice, { number: true }>` is `{ number?: string }`; an absent key
  and a selected-but-null value are indistinguishable. Selection narrows the type
  only — the runtime object simply lacks the key.
- **`true` on a branch selects scalars only.** It does not recurse into nested
  branches, so a default selection cannot fan out into unbounded joins.
- **A filter reads columns the selection may omit.** `select` governs the
  projection; the `args` still read whatever they name.
- **Filters are equality only.** `issuedFrom`/`issuedTo` (a range) would need
  `>=`/`<=`, which the resolver does not implement. Range operators need arg
  annotations (a `@gte`/`@lte` tag) and a linter pass over type-literal members;
  until then, keep args to equality.
- **Only one `@query` per alias.** A duplicate tag is a lint error like any other.
- **The zod `$brand` is an internal.** `Scalar` imports it from `zod`; the spec
  package already depends on zod for `@primitive`. If that import ever moves,
  the fallback is separate `select` (scalars) and `with` (branches) keys, which
  needs no brand but reads worse.
- **A branch `true` on an entity with no relations is safe; a cycle is not.**
  `InvoiceRow.invoiceId` is a scalar alias, not a `@relation`, so today's
  recursion terminates. A `@relation` back to the parent would need a depth cap
  in both `Selection` and the resolver.
- **`queries/` is exported.** The spec exports map lists `./queries/*.js`, so the
  resolver and the generated modules can import `Selection`/`Selected` and the
  args aliases.

## Why the resolver is hand-written

The SELECT depends on the runtime `select` object, and the WHERE on the runtime
`args`; neither is known at build time, so a generator cannot emit the SQL the
way `generate-repositories.ts` emits an INSERT. What the generator *can* emit is
mechanical: the interface, the factory, and the physical model. The interpreter
is written once, holds no domain names, and reads generated data — which is what
`AGENTS.md` asks for. Generating a resolver per entity would copy identical
logic N times.

Writing the WHERE per query is the alternative — the args shape is known at
build time, so a generator could emit `[["customerId", "=", args.customerId]]`
and leave only projection and shaping to the resolver. That is a reasonable
middle ground if the args logic grows past equality.

## Deliberately not implemented

- **Range and pattern filters.** Equality only; see the gotcha above.
- **Per-branch arguments.** A branch cannot carry `orderBy`/`limit`; `rows:
  { description: true }` has nowhere to put them. The extension point is to
  widen a branch from `Selection<E>` to `{ select?: Selection<E>; orderBy?: …;
  limit?: number }` and recurse into `.select`.
- **Pagination and ordering at the top level.** No `limit`/`offset`/`orderBy`.
- **`@projection` generation.** If static read SQL is ever wanted, the hook is a
  `@projection` tag on a `Pick<Entity, "…">` alias, emitting a view or a column
  list. It is not built.
- **Returning a whole entity in one call.** There is no `select: true` shorthand
  for the entire interface; a caller names the fields.
- **A transaction around a multi-query read.** A batched branch and its root are
  separate statements, so a concurrent write can be observed between them.
