# Queries

Reading is derived from the spec. Every entity in `packages/spec/src/domain/`
gets a generated `query<Entity>` read; a caller that wants a single row takes the
first result. A generator emits the typed functions and the physical model; one
hand-written resolver turns a selection into SQL. See "Why the resolver is
hand-written".

- `packages/spec/src/selection.ts` — `Selection`/`Selected` (the
  column-limiting types) and `Filters` (the filter arguments). Hand-written. It
  sits in the spec because the generated REST client shares it;
  `packages/backend/src/db/selection.ts` re-exports it. See `docs/rest-api.md`.
- `packages/backend/scripts/generate-queries.ts` — the generator.
- `packages/backend/src/db/queries/` — generated: `model.ts` (metadata),
  `query<Entity>.ts` (a `query<Entity>` per entity), `index.ts` (barrel).
- `packages/backend/src/db/resolvers.ts` — the reader. Hand-written.
- `packages/validation/src/queries/` — generated read argument
  schemas. See `docs/validation.md`.

- `pnpm generate:queries` — writes the generated modules.
- `pnpm generate:queries --out <dir>` — writes elsewhere. A missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand.

## One query per entity

There is no query alias to write. The generator walks the entities and emits
`query<Entity>`:

```ts
export function queryInvoice<S extends Selection<Invoice>>(
    db: SqlExecutor,
    opts: {
        filter?: Filters<Invoice, "id" | "customerId" | "sellerId">;
        order?: Order<"createdAt" | "updatedAt">[];
        limit?: number;
        offset?: number;
        select: S;
    },
): Promise<Selected<Invoice, S>[]> {
    return resolver.resolveMany<Invoice, S>(db, "invoice", opts.filter ?? {}, {
        select: opts.select,
        order: opts.order,
        limit: opts.limit,
        offset: opts.offset,
    });
}
```

No domain name is hardcoded: a new entity flows through with no generator edit.
`Customer`, `InvoiceRow`, `InvoiceSent`, and `Seller` get `queryCustomer`,
`queryInvoiceRow`, `queryInvoiceSent`, and `querySeller` the same way.

To read one row, take the first result — there is no `get`. A filter set that
matches several rows yields them in the order the read names (or the entity
default), at most `limit` of them, in pages of `offset`.

## `@queryfilter`

```
@queryfilter
```

A bare marker on a **scalar** field. It adds the field as a filter of the
entity's reads. `id` is a filter **without the tag**, because every entity has
one, so `queryInvoice` accepts `filter: { id }` out of the box:

```ts
const invoices = await queryInvoice(db, {
    filter: { id: [firstId, secondId] },
    select: { number: true, totalAmount: true },
});

const [invoice] = await queryInvoice(db, {
    filter: { id: [id] },
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
carrying `@primaryKey`; a generator reads the tag and never the name. Because the
default is the only spelling, writing `@queryfilter` on a `@primaryKey` field is
a lint finding. A composite key contributes one filter per key column, so each
part of the key filters on its own.

A field without `@queryfilter` is not filterable. Branch fields
(`@relation`/`@children`/`@inlined`) may not carry it; a relation is filtered
through its `@foreignKey` field, which is a scalar like any other.

### Filters are sets, combined with `and`

Every filter is an array and every clause is `in (…)`, so a single value is
written as a one-element array. An array matches any of its values, and an empty
array matches nothing.

Several filters are combined with **`and`**: `{ id: […], customerId: […] }`
requires both. A filter left `undefined` is dropped, so `queryInvoice(db, { select })`
lists every row.

The generated type makes every filter optional:

```ts
type Filters<E, K extends keyof E> = Partial<{ [P in K]: NonNullable<E[P]>[] }>;
```

So `queryInvoice(db, { select })` lists every row, and a one-element array names a
single value.

## `@queryorderby`

```
@queryorderby
@queryorderby default asc
```

A bare marker on a **scalar** field whitelists it as an ordering key. The
`order` option then accepts clauses that name those fields:

```ts
const invoices = await queryInvoice(db, {
    filter: { customerId: [customerId] },
    order: [["createdAt", "desc"]],
    select: { number: true },
});
```

`order` is an array of `[field, direction]` tuples, so several clauses sort with
the first breaking ties, each column matching SQL `ORDER BY`. Only whitelisted
fields may order — an unknown field is a **type error** and, over HTTP, a 400 —
so a field simply cannot reach the `ORDER BY`.

```ts
/** The ordering of a read: `[field, direction]` per sort key. See docs/queries.md. */
export type Order<K extends PropertyKey> = [field: K, direction: Direction];
export type Direction = "asc" | "desc";
```

### The default ordering

`@queryorderby default asc|desc` (at most one field per entity) additionally
makes that field the **entity default**: a read that names no `order` sorts by
it.

```ts
/**
 * @fieldName Created at
 * @queryorderby default asc
 * @widget date
 */
createdAt?: Date;

/**
 * @fieldName Updated at
 * @queryorderby
 * @widget date
 */
updatedAt?: Date;
```

An entity with no `@queryorderby` field takes no `order` (its opts type omits
the key) and is returned in database order. Ordering is a root-only feature:
a branch cannot carry `order` any more than it can carry `filter`.

## `@where`

```
@where gte lte
```

`@queryfilter` matches a **set** (`in (…)`). A comparison cannot be a set, so it
has its own tag and its own option: `@where` on a scalar field whitelists the
operators that field may be narrowed with, and the read's `where` key carries
them.

```ts
const invoices = await queryInvoice(db, {
    where: { issueDate: { gte: from, lte: to } },
    select: { number: true },
});
```

The operator list is **required**: a bare `@where` is a lint finding. The
vocabulary is `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, mapped to `=`, `<>`, `>`,
`>=`, `<`, `<=`. Each operator takes one value; several operators on one field
AND together, so `{ gte, lte }` **is** a range and no `between` operator is
needed. An operator the field does not declare is a **type error** and, over
HTTP, a 400.

```ts
/** The comparison arguments of a read. See docs/queries.md. */
export type Where<E, O extends Partial<Record<keyof E, PropertyKey>>> = {
    [K in keyof O & keyof E]?: { [P in Extract<NonNullable<O[K]>, PropertyKey>]?: NonNullable<E[K]> };
};
export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
```

`filter` stays for membership: an `in (…)` is index-friendly and reads a whole
set in one comparison, so a read may use both — `filter` to narrow cheaply, then
`where` for the range. The two are independent and combine with `and`.

```ts
/**
 * @fieldName Issue date
 * @where gte lte
 * @widget date
 */
issueDate?: Date;
```

A field may carry `@queryfilter`, `@where`, and `@queryorderby` at once — they
are separate read facets. An entity with no `@where` field takes no `where` (its
opts type omits the key). Like `order`, comparisons are a **root-only** feature:
a branch fetch never carries them.

## `limit` and `offset`

Every read pages. `limit` bounds how many rows a read returns and `offset` skips
leading rows, both applied to the **root** query only — a batched branch is never
cut, so a parent's children come back whole.

```ts
const page = await queryInvoice(db, {
    filter: { customerId: [customerId] },
    order: [["createdAt", "desc"]],
    limit: 25,
    offset: 50,
    select: { number: true },
});
```

`limit` defaults to **1000** and `offset` to **0**, so a read that names neither
returns the first 1000 matching rows. The default is the resolver's
`DEFAULT_LIMIT`; pass a larger `limit` to widen the window, or a smaller one to
want less.

A non-positive `limit` or a negative `offset` is a **type error** and, over
HTTP, a 400; the resolver re-checks both, because a decoded number reaches the
SQL unchecked. There is no cursor pagination and no `limit: null` escape hatch:
`limit` is always a positive integer, the default cap included.

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

What counts as a scalar is decided by `Scalar`, which reads the `Brand`
that `@primitive` already puts on every primitive:

```ts
type Scalar<T> =
    NonNullable<T> extends string | number | boolean | bigint | Date | Brand<any> ? true : false;
```

The brand is load-bearing. A structural `extends object` test cannot tell a
scalar from an entity: `Money`, `InvoiceId`, and `Version` are branded
primitives and all satisfy `extends object`, exactly like `InvoiceRow`. Without
the brand, `select: { totalAmount: { … } }` would type-check and recurse into a
decimal.

## A read, generated

A read takes **two arguments**: the executor `db` first, then an options object
that carries the filter and the selection. The generator keeps them as separate
keys — `{ filter, select }` — so a data field can never collide with `select`,
and passes the filter object straight to the resolver, whose signature already
keeps filters and projection explicit.

A call site narrows exactly:

```ts
const [invoice] = await queryInvoice(db, {
    filter: { id: [id] },
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
| `query<Entity>` functions | generated |
| `queryModel` (tables, fields, branches) | generated |
| `resolveMany` | hand-written, once |

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

Relation and inlined columns are not the same here. Inlined columns are excluded
from the table's selectable `fields`, because the spec never declares them. A
relation's foreign key *is* excluded from nothing: it is the `@foreignKey` field
the interface declares, so `Invoice.customerId` is a selectable field and — with
`@queryfilter` — an ordinary filter. `InvoiceRow.invoiceId` is the same thing.

## The resolver reads one query per branch

`resolveMany` (`packages/backend/src/db/resolvers.ts`) builds the SQL at run
time from `queryModel` plus the selection:

- **Scalars** — projected into the root query.
- **`@inlined`** — projected from the same row, aliased per target field. No query.
- **`@relation`** — one batched `where target.key in (…)` for every distinct
  foreign key, attached back by key.
- **`@children`** — one batched `where child.fk in (…)`, grouped in memory.

A projected scalar is copied only when its column is not `null`, and a to-one
branch whose foreign key is `null` is left out. A `null` column and an absent
key therefore look the same on the wire, matching the optional spec fields.

There is **no JSON aggregation**. A branch costs one extra query, batched over
all parents at that level; nested branches recurse the same way, one query per
branch per level. The resolver holds no domain knowledge — it only reads
`queryModel`, so a new entity and `@queryfilter` field need no resolver change.

Arguments filter by set membership: the generated filters are the scalar fields
that carry `@queryfilter` (plus every `@primaryKey` field), and a relation's
`@foreignKey` field is one of them. An unknown filter field throws rather than
silently dropping a clause, as does a non-array value. `String`, `Date`, and
`decimal` values pass through unchanged.

A filter value is always an array, so a lookup names a one-element set and an
empty set matches nothing. Multiple filters are ANDed. The linter rejects
`@queryfilter` on a branch field, so a filter always names a scalar column.

Ordering, paging, and comparisons are applied the same way: the resolver reads
the table's `order`/`defaultOrder` and `where` whitelists from `queryModel`,
refuses a field or operator that is not on them, and validates the direction and
operator before they reach the SQL, where every value is parameterized. It fills
in `limit` (default 1000) and `offset` (default 0) and rejects a value that is
not a positive integer or a non-negative integer. Only the root query is
ordered, paged, and compared; a batched branch keeps its own order so grouping
stays stable and is never truncated or filtered.

## Gotchas

- **Every selected key is optional.** All spec fields are optional, so
  `Selected<Invoice, { number: true }>` is `{ number?: string }`. A `null` column
  is omitted rather than carried as `null`, so a value is present only when the
  column has one: selection narrows the type, and the runtime object lacks a key
  it did not select or that was `null`.
- **`true` on a branch selects scalars only.** It does not recurse into nested
  branches, so a default selection cannot fan out into unbounded joins.
- **A filter reads columns the selection may omit.** `select` governs the
  projection; the `args` still read whatever they name, and so do `order` and
  `where`.
- **Set membership, or the `@where` operators.** A `filter` is an array matched
  with `in (…)`; an empty set matches nothing, and a non-array value throws. A
  comparison goes through `where`, whose operators are whitelisted per field.
  A range is `{ gte, lte }`, not a `between`.
- **`eq` overlaps `filter`.** `where: { id: { eq } }` says what
  `filter: { id: [value] }` already says; `eq` exists for symmetry and `ne` is
  the operator `filter` cannot express.
- **Filters come only from `@queryfilter`, plus the primary key.** A field
  without the tag is not filterable, each `@primaryKey` field is a filter without
  it, and a branch field may not carry it; filtering by a relation is not
  implemented.
- **A composite key has no single row key for branch attachment.** The resolver
  identifies a row by one column, so an entity whose `@primaryKey` is several
  fields cannot be the target of a `@foreignKey` — and so cannot be reached by a
  `@relation` or own a `@children` collection, both of which need one column to
  point at it. The generator reports that rather than emitting a partial join.
  Such an entity is therefore root-only, and `queryModel.key` names its first key
  column purely as the alias a row is projected under; no join reads it, because
  nothing can name the table as a branch target. Grouping children by a full
  composite key is not implemented.
- **The brand is an internal.** `Scalar` reads the spec's `Brand` alias, whose
  only dependency is a type-only Zod import. The fallback, if that ever moves, is
  separate `select` (scalars) and `with` (branches) keys, which needs no brand
  but reads worse.
- **A branch `true` on an entity with no relations is safe; a cycle is not.**
  `InvoiceRow.invoiceId` is a scalar alias, not a `@relation`, so today's
  recursion terminates. A `@relation` back to the parent would need a depth cap
  in both `Selection` and the resolver.
- **Ordering comes only from `@queryorderby`.** A field without the tag cannot
  order, and a direction is `asc` or `desc`. Like a filter, ordering is a root
  concern: a branch field may not carry the tag.
- **A read is capped by default.** `limit` defaults to 1000, so a filter that
  matches more rows returns the first 1000 unless the caller asks for more.
  There is no `limit: null` for "all rows"; a page is always bounded.
- **`offset` is not a cursor.** A concurrent insert or delete can shift a row
  across pages between calls. Stable paging over a mutable table needs a keyset
  cursor, which is not implemented.
- **The read types are in the spec, the reader is not.** `Selection`,
  `Selected`, `Filters`, `Order`, and `Where` are pure types with no query in
  them, so
  they live in `packages/spec/src/selection.ts` and both the backend and the
  generated REST client import them from there. The SQL, the resolver, and the
  metadata stay in the backend.

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

- **Comparisons on a branch.** `@where` is scalar-only, so `queryInvoice` cannot
  compare a related record's columns, such as `customer.name`.
- **Filters on a branch.** `@queryfilter` is scalar-only, so `queryInvoice`
  cannot filter on a related record's columns, such as `customer.name`. The
  foreign key is a scalar field, so `customerId` is filterable.
- **More comparison operators.** The vocabulary is `eq ne gt gte lt lte`. `like`,
  `isNull`, and a case-insensitive match would each be another entry.
- **Comparisons across fields.** A `where` value is a literal, not a column
  reference, so `totalAmount > netAmount` is not expressible.
- **A row at most, not exactly one.** There is no `limit 1` shorthand; a caller
  takes the first result, which fetches a whole page.
- **Per-branch arguments.** A branch cannot carry `order`/`where`/`limit`/
  `offset`; `rows: { description: true }` has nowhere to put them. The extension
  point is to widen a branch from `Selection<E>` to `{ select?: Selection<E>;
  order?: …; where?: …; limit?: number; offset?: number }` and recurse into
  `.select`.
- **Cursor pagination and a total count.** `limit`/`offset` page a read, but
  there is no keyset cursor and no way to ask how many rows matched.
- **`@projection` generation.** If static read SQL is ever wanted, the hook is a
  `@projection` tag on a `Pick<Entity, "…">` alias, emitting a view or a column
  list. It is not built.
- **Returning a whole entity in one call.** There is no `select: true` shorthand
  for the entire interface; a caller names the fields.
- **A transaction around a multi-query read.** A batched branch and its root are
  separate statements, so a concurrent write can be observed between them.
