# Queries

`packages/spec/src/queries/` holds the read contracts for the spec: interfaces a
caller reads through, with no implementation. An implementation belongs in
`packages/backend/`, satisfied the same way `InvoiceOperations` is — as a
contract, not behaviour.

- `packages/spec/src/queries/selection.ts` — `Selection`/`Selected`, the
  column-limiting types.
- `packages/spec/src/queries/<Entity>Queries.ts` — one interface per read
  surface, such as `InvoiceQueries`.

Nothing is generated and nothing is committed to the database. Queries are
hand-written, like `packages/spec/src/operations/`. See "Why not generated".

## Why a separate directory

`operations/` is where a mutation contract lives; `queries/` is its read
counterpart. Both sit outside `domain/`, so neither is read as an entity:

- The generators parse entities from `domain/**` and type aliases from all of
  `src/**` (`DEFAULT_SPEC_GLOB` vs `SPEC_GLOB` in
  `packages/spec/scripts/spec-model.ts`).
- The linter scans interfaces from `domain/**` only, and type aliases from all
  of `src/**`. A method-only interface outside `domain/` is therefore a contract
  by construction, not by accident — it is not asked for `@fieldName`/`@widget`.

A field-bearing `interface` in `queries/` would still be linted if it were read
as an entity; it is not, because it is not under `domain/`. Use a type alias for
a filter (object-literal members are not linted) and keep entities in `domain/`.

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

## A query

```ts
export interface InvoiceQueries {
    getInvoice<S extends Selection<Invoice>>(
        id: InvoiceId,
        opts: GetInvoiceOptions<S>,
    ): Promise<Selected<Invoice, S> | undefined>;

    listInvoices<S extends Selection<Invoice>>(
        opts: ListInvoicesOptions<S>,
    ): Promise<Selected<Invoice, S>[]>;
}
```

A call site narrows exactly:

```ts
const [invoice] = await queries.listInvoices({
    filter: { customerId },
    select: { id: true, number: true, totalAmount: true, rows: { description: true, totalAmount: true } },
});
// invoice.rows![0].totalAmount  ✓
// invoice.rows![0].taxAmount    ✗  not selected
// invoice.notes                 ✗  not selected
```

The compiler rejects a field that is not on the entity, a nested selection on a
scalar, and a field not named in the selection.

## Selecting a branch means three different things

`Invoice.rows`, `Invoice.customer`, and `InvoiceSent.customer` nest identically
at the call site and are not the same storage:

| Nested field | Annotation | Storage | SQL |
| --- | --- | --- | --- |
| `Invoice.rows` | `@children InvoiceRow` | child table, FK `invoiceId` | join |
| `Invoice.customer` | `@relation Customer` | FK `customerId` | join to the **live** row |
| `InvoiceSent.customer` | `@inlined Customer` | flattened `customerName`, `customerEmail`, … | no join, prefix columns |

An inlined branch is not a join: its columns are already on the row. The
freshness differs too — a relation reads the current record, an inlined value is
the frozen snapshot — and the call site cannot tell them apart. See
`docs/invoice-snapshotting.md`. A runtime resolver should read the same table
model the generators do (`packages/backend/scripts/postgres-model.ts`), whose
columns already carry `references`, inlined prefixes, and rollups, so no domain
name is hardcoded.

## Gotchas

- **Every selected key is optional.** All spec fields are optional, so
  `Selected<Invoice, { number: true }>` is `{ number?: string }`; an absent key
  and a selected-but-null value are indistinguishable. Selection narrows the type
  only — the runtime object simply lacks the key.
- **`true` on a branch selects scalars only.** It does not recurse into nested
  branches, so a default selection cannot fan out into unbounded joins.
- **A filter reads columns the selection may omit.** `select` governs the
  projection; `filter`/ordering still read whatever they name.
- **The zod `$brand` is an internal.** `Scalar` imports it from `zod`; the spec
  package already depends on zod for `@primitive`. If that import ever moves,
  the fallback is separate `select` (scalars) and `with` (branches) keys, which
  needs no brand but reads worse.
- **No cycle today.** `InvoiceRow.invoiceId` is a scalar alias, not a
  `@relation`, so the recursion terminates. A `@relation` back to the parent
  would need a depth cap in both `Selection` and the resolver.
- **`queries/` is not exported.** Like `packages/spec/src/operations/`, the
  package exports map (`./domain/*.js`, `./primitives/*.js`, `./scripts/*.js`)
  does not list it, so nothing can import the contract yet.

## Why not generated

Reading is a product decision, not a mapping of the spec (`docs/repositories.md`).
Joins, filters, ordering, and pagination are not derivable from a type, so a
query generator would either hardcode domain names — which `AGENTS.md` forbids —
or grow into a query builder. The contract stays hand-written; only the
selection *type* is shared machinery.

## Deliberately not implemented

- **An implementation.** Nothing in `packages/backend/` satisfies these
  interfaces yet.
- **Per-branch arguments.** A branch cannot carry `orderBy`/`limit`; `rows:
  { description: true }` has nowhere to put them. The extension point is to
  widen a branch from `Selection<E>` to `{ select?: Selection<E>; orderBy?: …;
  limit?: number }` and recurse into `.select`.
- **Pagination and ordering at the top level.** `limit`/`offset`/`orderBy` are
  not in `ListInvoicesOptions`.
- **`@projection` generation.** If read SQL is ever wanted, the hook is a
  `@projection` tag on a `Pick<Entity, "…">` alias, parsed generically like the
  schema generator, emitting a view or a column list. It is not built.
- **Returning a whole entity in one call.** There is no `select: true` shorthand
  for the entire interface; a caller names the fields, or reads them through a
  branch.
