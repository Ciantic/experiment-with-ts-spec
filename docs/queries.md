# Queries

Reading is derived from the spec. Every entity in `packages/spec/src/domain/`
gets a generated `list<Entity>` read, and — when it marks a `@queryfilter` field —
a matching `get<Entity>`. A generator emits the typed functions and the physical
model; one hand-written resolver turns a selection into SQL. See "Why the
resolver is hand-written".

- `packages/backend/src/db/selection.ts` — `Selection`/`Selected` (the
  column-limiting types) and `Filters`/`AtLeastOne` (the filter arguments).
  Hand-written.
- `packages/backend/scripts/generate-queries.ts` — the generator.
- `packages/backend/src/db/queries/` — generated: `model.ts` (metadata),
  `<entity>Queries.ts` (a `list<Entity>` and maybe a `get<Entity>` per entity),
  `index.ts` (barrel).
- `packages/backend/src/db/resolvers.ts` — the reader. Hand-written.
- `packages/backend/src/validation/queries/` — generated read argument
  schemas. See `docs/validation.md`.

- `pnpm generate:queries` — writes the generated modules.
- `pnpm generate:queries --out <dir>` — writes elsewhere. A missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand.

## One list, and one get, per entity

There is no query alias to write. The generator walks the entities and emits
`list<Entity>`, plus `get<Entity>` when the entity has a filter:

```ts
export function listInvoice<S extends Selection<Invoice>>(
    db: SqlExecutor,
    opts: Filters<Invoice, "id"> & { select: S },
): Promise<Selected<Invoice, S>[]> {
    const { select, ...args } = opts;
    return resolver.resolveMany<Invoice, S>(db, "invoice", args, { select });
}

export function getInvoice<S extends Selection<Invoice>>(
    db: SqlExecutor,
    opts: AtLeastOne<Filters<Invoice, "id">> & { select: S },
): Promise<Selected<Invoice, S> | undefined> {
    const { select, ...args } = opts;
    return resolver.resolveOne<Invoice, S>(db, "invoice", args, { select });
}
```

No domain name is hardcoded: a new entity flows through with no generator edit.
`Customer`, `InvoiceRow`, `InvoiceSent`, and `Seller` get `listCustomer`,
`listInvoiceRow`, `listInvoiceSent`, and `listSeller` the same way.

A **getter needs something to name a row with**, so it is emitted only when the
entity has a filter. In practice that is always: `id` is a filter by default, so
every entity gets both reads. The rule still holds at the generator, which reads
whatever annotations produced — an entity whose `id` were removed would lose its
getter rather than gain one that returns an arbitrary row. `get` returns the
first row — there is no `limit 1` — so a filter set that matches several rows
yields one of them, deterministically ordered only if the query is.

## `@queryfilter`

```
@queryfilter
```

A bare marker on a **scalar** field. It adds the field as a filter of the
entity's reads. `id` is a filter **without the tag**, because every entity has
one, so `listInvoice` and `getInvoice` accept `{ id }` out of the box:

```ts
const invoices = await listInvoice(db, {
    id: [firstId, secondId],
    select: { number: true, totalAmount: true },
});

const invoice = await getInvoice(db, {
    id: [id],
    select: { number: true, totalAmount: true },
});
```

The tag is what adds a filter *besides* `id`. `Invoice.number` would become
filterable by marking it:

```ts
/**
 * @fieldName Invoice number
 * @generated
 * @unique
 * @widget text
 * @queryfilter
 */
number?: string;
```

The default lives in `spec-model.ts`, which sets the tag when it parses a field
named `id`; a generator reads the tag and never the name. Because the default is
the only spelling, writing `@queryfilter` on `id` is a lint finding.

A field without `@queryfilter` is not filterable. Branch fields
(`@relation`/`@children`/`@inlined`) may not carry it; filtering by a relation is
not implemented.

### Filters are sets, combined with `and`

Every filter is an array and every clause is `in (…)`, so a single value is
written as a one-element array. An array matches any of its values, and an empty
array matches nothing.

Several filters are combined with **`and`**: `{ id: […], customerId: […] }`
requires both. A filter left `undefined` is dropped, so `listInvoice(db, { select })`
lists every row.

The generated types encode the difference between the two reads:

```ts
type Filters<E, K extends keyof E> = Partial<{ [P in K]: NonNullable<E[P]>[] }>;

type AtLeastOne<T> = {
    [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>>;
}[keyof T];
```

`list` takes `Filters` — every filter optional. `get` takes
`AtLeastOne<Filters>` — a union in which one filter is required and the rest are
optional, so `getInvoice(db, { select })` does not compile.

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

## A read, generated

A read takes **two arguments**: the executor `db` first, then the filters, with
`select` intersected in by the generator. The function then splits the filters
back apart for the resolver, whose signature keeps filters and projection
explicit.

A call site narrows exactly:

```ts
const [invoice] = await listInvoice(db, {
    id: [id],
    select: { id: true, number: true, totalAmount: true, rows: { description: true, totalAmount: true } },
});
// invoice.rows![0].totalAmount  ✓
// invoice.rows![0].taxAmount    ✗  not selected
// invoice.notes                 ✗  not selected
```

The compiler rejects a field that is not on the entity, a nested selection on a
scalar, a field not named in the selection, and a non-array filter.

The generator emits the **contract and the wiring**, never SQL. It reads only
annotations: `@queryfilter` for the filters, the existing table model for the
columns, and the branch tags below. No domain name is hardcoded, so a new
`@queryfilter` field and a new entity flow through with no generator edit.

## What is generated, and what is not

| Artifact | Source |
| --- | --- |
| `list<Entity>` / `get<Entity>` functions | generated |
| `queryModel` (tables, fields, branches) | generated |
| `resolveMany` / `resolveOne` | hand-written, once |

`queryModel` is the physical model: for each table its key, its scalar fields,
and a descriptor per branch (see below). The resolver reads that data plus the
runtime `args`/`select`, and builds the SQL. The generated functions carry no
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

`resolveMany`/`resolveOne` (`packages/backend/src/db/resolvers.ts`) build
the SQL at run time from `queryModel` plus the selection:

- **Scalars** — projected into the root query.
- **`@inlined`** — projected from the same row, aliased per target field. No query.
- **`@relation`** — one batched `where target.key in (…)` for every distinct
  foreign key, attached back by key.
- **`@children`** — one batched `where child.fk in (…)`, grouped in memory.

There is **no JSON aggregation**. A branch costs one extra query, batched over
all parents at that level; nested branches recurse the same way, one query per
branch per level. The resolver holds no domain knowledge — it only reads
`queryModel`, so a new entity and `@queryfilter` field need no resolver change.

Arguments filter by set membership: the generated filters are scalar fields
(`id`), and the resolver also accepts a relation's foreign-key column
(`customerId`) if a future annotation emits one. An unknown filter field throws
rather than silently dropping a clause, as does a non-array value. `String`,
`Date`, and `decimal` values pass through unchanged.

A filter value is always an array, so a lookup names a one-element set and an
empty set matches nothing. Multiple filters are ANDed. The linter rejects
`@queryfilter` on a branch field, so a filter always names a scalar column.

`resolveOne` fetches and returns the first row of the same query; there is no
`limit 1`.

## Gotchas

- **Every selected key is optional.** All spec fields are optional, so
  `Selected<Invoice, { number: true }>` is `{ number?: string }`; an absent key
  and a selected-but-null value are indistinguishable. Selection narrows the type
  only — the runtime object simply lacks the key.
- **`true` on a branch selects scalars only.** It does not recurse into nested
  branches, so a default selection cannot fan out into unbounded joins.
- **A filter reads columns the selection may omit.** `select` governs the
  projection; the `args` still read whatever they name.
- **Set membership only.** A filter is an array matched with `in (…)`; an empty
  set matches nothing, and a non-array value throws. A range
  (`issuedFrom`/`issuedTo`) would need `>=`/`<=`, which the resolver does not
  implement; a range operator needs its own annotation (a `@gte`/`@lte` tag) and
  a resolver clause.
- **`get` needs a filter.** It is generated only for an entity that marks one,
  and its type requires at least one. It returns the first match, not a unique
  row: nothing enforces that the filters identify one row, and a nullable or
  non-unique column can return any of several.
- **Filters come only from `@queryfilter`, plus `id`.** A field without the tag
  is not filterable, `id` is a filter without it, and a branch field may not
  carry it; filtering by a relation is not implemented.
- **The zod `$brand` is an internal.** `Scalar` imports it from `zod`; the
  backend already depends on zod for the generated validation schemas. If that
  import ever moves, the fallback is separate `select` (scalars) and `with`
  (branches) keys, which needs no brand but reads worse.
- **A branch `true` on an entity with no relations is safe; a cycle is not.**
  `InvoiceRow.invoiceId` is a scalar alias, not a `@relation`, so today's
  recursion terminates. A `@relation` back to the parent would need a depth cap
  in both `Selection` and the resolver.
- **`selection.ts` is backend-only.** The spec no longer carries read types; the
  resolver and the generated modules import `Selection`/`Selected` from
  `packages/backend/src/db/selection.ts`.

## Why the resolver is hand-written

The SELECT depends on the runtime `select` object, and the WHERE on the runtime
`args`; neither is known at build time, so a generator cannot emit the SQL the
way `generate-repositories.ts` emits an INSERT. What the generator *can* emit is
mechanical: the per-entity functions and the physical model. The interpreter
is written once, holds no domain names, and reads generated data — which is what
`AGENTS.md` asks for. Generating a resolver per entity would copy identical
logic N times.

Writing the WHERE per query is the alternative — the args shape is known at
build time, so a generator could emit `[["customerId", "=", args.customerId]]`
and leave only projection and shaping to the resolver. That is a reasonable
middle ground if the args logic grows past equality.

## Deliberately not implemented

- **Set and range filters.** Set membership only; see the gotcha above.
- **Relation filters.** `@queryfilter` is scalar-only, so `listInvoice` cannot
  filter by a relation's foreign key today.
- **A row at most, not exactly one.** `resolveOne` fetches every match and takes
  the first; a `limit 1` would need a per-read contract the generator does not
  have.
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
