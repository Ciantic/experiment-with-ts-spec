# Queries

Reading is derived from the spec. Every entity that carries `@queries query` in
`packages/spec/src/` gets a generated `query<Entity>` read; a caller that
wants a single row takes the first result. A generator emits the typed functions
and the physical model; one hand-written resolver turns a selection into SQL.
See "Why the resolver is hand-written".

- `packages/validation/src/selection.ts` — `Selection`/`Selected` (the
  column-limiting types), `Filters` (the filter arguments), and the `Order` and
  `Where` clauses. Hand-written; the resolver and the generated REST client
  import their types from it, so the read contract has one definition. See
  `docs/rest-api.md`.
- `packages/backend/scripts/generate-queries.ts` — the generator.
- `packages/backend/src/db/queries/` — generated: `model.ts` (metadata),
  `query<Entity>.ts` (a `query<Entity>` per `@queries` entity), `index.ts` (barrel).
- `packages/backend/src/db/resolvers.ts` — the reader. Hand-written.
- `packages/validation/src/queries/` — generated read argument
  schemas. See `docs/validation.md`.

- `pnpm generate:queries` — writes the generated modules.
- `pnpm generate:queries --out <dir>` — writes elsewhere. A missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand. A
regeneration also removes a module the spec no longer declares, so an entity that
drops `@queries query` leaves no stale file behind.

## One query per entity

An entity declares its read with `@queries <operation>…`; `@query` is the only
operation today, so the tag is written `@queries query`. An entity that declares
no read gets no `query<Entity>` and no read route — the generator writes a
module only for the tables the tag names. The tag is a list rather than a bare
marker because a second kind of read would be a token in it, not a new tag. See
`docs/spec-annotations.md`.

There is no query alias to write. The generator walks the tables and emits
`query<Entity>`:

```ts
export function queryInvoice<S extends Selection<Invoice>>(
    db: SqlExecutor,
    opts: {
        filter: Filters<Invoice, "id" | "tenantId" | "customerId" | "sellerId", "tenantId">;
        order?: Order<"createdAt" | "updatedAt">[];
        where?: Where<Invoice, { issueDate: "gte" | "lte" }>;
        limit?: number;
        offset?: number;
        select: S;
    },
): Promise<Selected<Invoice, S>[]> {
    return resolver.resolveMany<Invoice, S>(db, "invoice", opts.filter ?? {}, {
        select: opts.select,
        order: opts.order,
        where: opts.where,
        limit: opts.limit,
        offset: opts.offset,
    });
}
```

No domain name is hardcoded: a new entity flows through with no generator edit.
`Customer`, `InvoiceRow`, `InvoiceSent`, and `Seller` get `queryCustomer`,
`queryInvoiceRow`, `queryInvoiceSent`, and `querySeller` the same way.

`model.ts` names every table, whether or not the entity reads: a read may select
into a table that has no read of its own, so the resolver needs its key, fields,
and branches. Dropping a table from the model would break the read that navigates
into it.

To read one row, take the first result — there is no `get`. A filter set that
matches several rows yields them in the order the read names (or the entity
default), at most `limit` of them, in pages of `offset`.

## `@queryFilter`

```
@queryFilter
@queryFilter required
@queryFilter default=<value>
```

A bare marker on a **scalar** field. It adds the field as a filter of the
entity's reads. `id` is a filter **without the tag**, because every entity has
one, so `queryInvoiceRow` accepts `filter: { id }` out of the box:

```ts
const rows = await queryInvoiceRow(db, {
    filter: { tenantId: [tenantId], id: [firstId, secondId] },
    select: { description: true, totalAmount: true },
});

const [row] = await queryInvoiceRow(db, {
    filter: { tenantId: [tenantId], id: [rowId] },
    select: { description: true, totalAmount: true },
});
```

The tag is what adds a filter *besides* `id`. `Invoice.number` would become
filterable by marking it:

```ts
/**
 * @fieldName Invoice number
 * @unique
 * @widget text
 * @queryFilter
 */
number?: string;
```

The default lives in `spec-model.ts`, which sets the tag when it parses a field
carrying `@primaryKey`; a generator reads the tag and never the name. `required`
is the one thing that default cannot say, so writing `@queryFilter` on a
`@primaryKey` field is a lint finding unless it writes `required`. A composite key
contributes one filter per key column, so each part of the key filters on its own.

A field without `@queryFilter` is not filterable. Branch fields
(`@relation`/`@children`/`@inlined`) may not carry it; a relation is filtered
through its `@foreignKey` field, which is a scalar like any other.

A filter's value is a **set** by default, but a nullable field also takes a null
test instead. That is how a read names the rows a default would hide:

```ts
// Live invoices: the default fills in `is null`.
const live = await queryInvoice(db, { filter: { tenantId: [tenantId] }, select: { number: true } });

// Deleted invoices: the null test replaces the default.
const deleted = await queryInvoice(db, {
    filter: { tenantId: [tenantId], deletedAt: { isNotNull: true } },
    select: { number: true, deletedAt: true },
});

// Invoices with no customer.
const unassigned = await queryInvoice(db, {
    filter: { tenantId: [tenantId], customerId: { isNull: true } },
    select: { number: true },
});
```

`{ isNull: true }` and `{ isNotNull: true }` take no value. They are offered only
for an optional field, whose column can hold null; a null test on a not-null
column would match every row or none, so the linter rejects
`@queryWhere isNull|isNotNull` there and the generated schema does not accept the
test on a required filter. See "Filters are sets" below.

### A required filter

`@queryFilter required` makes the filter **mandatory**: every read of the entity
has to name it. Each tenant-owned entity marks its `tenantId` that way, because a
read that forgets it would cross tenants. See `docs/tenancy.md`.

```ts
/**
 * @fieldName Tenant ID
 * @queryFilter required
 * @foreignKey Tenant
 * @widget text
 */
tenantId: TenantId;
```

The generated args type then requires the filter object itself, and the field
inside it:

```ts
export function queryInvoiceRow<S extends Selection<InvoiceRow>>(db: SqlExecutor, opts: {
    filter: Filters<InvoiceRow, "id" | "tenantId", "tenantId">;
    limit?: number;
    offset?: number;
    select: S;
}): Promise<Selected<InvoiceRow, S>[]>;
```

`Filters<E, K, R>` takes the possible keys and the required ones separately, so
`filter` is mandatory with `filter.tenantId`, and `filter.id` stays optional — a
read that leaves the tenant out does not compile.

The requirement holds at run time too: the generated args schema makes the field
mandatory, so a read over HTTP that omits it is a **400**, and the resolver throws
for a caller that reaches it with an untyped object, the same guard it puts on an
unknown filter field. See "The resolver reads one query per branch".

A required filter scopes what a read may **see**. What a write may **link** is a
separate annotation: `@foreignKey Invoice scope=tenantId` makes the reference
composite, so a row cannot point at another tenant's invoice, and the interface it
points at declares that column with `@tenantOwned`. See `docs/tenancy.md`.

### A defaulted filter

`@queryFilter default=<value>` gives the filter a value to match when a read
omits it. The value is one of the null-test keywords `isNull` and `isNotNull`, a
boolean, a number, or a string. A bare token is a string, so a date or an enum
value needs no quotes (`default=2024-01-01`, `default=draft`), and quotes are
also accepted (`default="draft"`). A quoted keyword is a string too, so a text
column can default to the text `isNull`.

```ts
/**
 * @fieldName Deleted at
 * @deletedAt
 * @queryFilter default=isNull
 * @widget date
 */
deletedAt?: Date;
```

A read that leaves `deletedAt` out matches only the rows where the column is
`null`, because `isNull` compiles to `is null`. That is how soft deletion is
modelled: the column is an ordinary nullable field, `update` sets the moment,
and every read hides trashed rows unless it names the filter. The `@deletedAt`
marker adds no behaviour of its own; it only makes the linter check that shape.
See `docs/soft-delete.md`.

A default is not a set: it is one value, compared with `=` or a null test. A
read that names the filter overrides it — with a set or a null test — so the
default only fills a hole. Defaults combine with the other filters and with
`where`, all with `and` — but a `where` condition on the same field counts as
naming it, so it replaces the default rather than narrowing it.

- **A null test needs a nullable field.** `default=isNull` and
  `default=isNotNull` read a nullable column; on a not-null one the first would
  never match and the second would match everything, so the linter reports both.
  A literal works on either.
- **A default never makes a filter required.** The filter stays optional in the
  generated type, the wire schema, and the SDK; a read that names it wins, and a
  read that omits it gets the declared value.
- **A default applies to branches too.** A branch narrows through the same
  resolver, so a `@children` or `@relation` branch over a defaulted entity hides
  the defaulted rows unless its own arguments name the filter or compare the
  field.
- **A required filter cannot be defaulted.** Its default would never apply, so
  the two are a lint finding together.

### Filters are sets, combined with `and`

Every filter is an array and every clause is `= any($n)`, so a single value is
written as a one-element array. An array matches any of its values, and an empty
array matches nothing. A filter whose field is nullable also takes a null test,
`{ isNull: true }` or `{ isNotNull: true }`, because a set cannot say either.

Several filters are combined with **`and`**: `{ tenantId: […], customerId: […] }`
requires both. A filter left `undefined` is dropped — unless it declares a
default, which is applied in its place — so a read that names only the tenant
returns every row of that tenant, and an entity with no required filter, such as
`Tenant`, lists everything when `filter` is left out.

The generated type makes every filter optional except the ones the tag marks
required:

```ts
type NullFilter = { isNull: true } | { isNotNull: true };
type FilterValue<T> = readonly NonNullable<T>[] | (undefined extends T ? NullFilter : never);

type Filters<E, K extends keyof E, R extends K = never> = { [P in R]: FilterValue<E[P]> } & Partial<{
    [P in Exclude<K, R>]: FilterValue<E[P]>;
}>;
```

The third parameter is `never` for an entity whose filters are all optional, so
`queryTenant(db, { select })` lists every row, and a one-element array names a
single value.

## `@queryOrderBy`

```
@queryOrderBy
@queryOrderBy default asc
```

A bare marker on a **scalar** field whitelists it as an ordering key. The
`order` option then accepts clauses that name those fields:

```ts
const invoices = await queryInvoice(db, {
    filter: { tenantId: [tenantId], customerId: [customerId] },
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

`@queryOrderBy default asc|desc` (at most one field per entity) additionally
makes that field the **entity default**: a read that names no `order` sorts by
it.

```ts
/**
 * @fieldName Created at
 * @queryOrderBy default asc
 * @widget date
 */
createdAt?: Date;

/**
 * @fieldName Updated at
 * @queryOrderBy
 * @widget date
 */
updatedAt?: Date;
```

An entity with no `@queryOrderBy` field takes no `order` (its opts type omits
the key) and is returned in database order. A branch carries its own `order`
inside its read arguments, the same way it carries a `filter`; the target's
whitelist is what an order clause is checked against, so a branch orders only by
its own entity's fields.

## `@queryWhere`

```
@queryWhere gte lte
```

`@queryFilter` matches a **set** (`= any($n)`). A comparison cannot be a set, so it
has its own tag and its own option: `@queryWhere` on a scalar field whitelists the
operators that field may be narrowed with, and the read's `where` key carries
them.

```ts
const invoices = await queryInvoice(db, {
    filter: { tenantId: [tenantId] },
    where: { issueDate: { gte: from, lte: to } },
    select: { number: true },
});
```

The operator list is **required**: a bare `@queryWhere` is a lint finding. The
vocabulary is `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, mapped to `=`, `<>`, `>`,
`>=`, `<`, `<=`, plus the null tests `isNull` and `isNotNull`. Every operator
except the last two takes one value; several operators on one field AND together,
so `{ gte, lte }` **is** a range and no `between` operator is needed. The null
tests take `true` and bind no parameter. An operator the field does not declare
is a **type error** and, over HTTP, a 400.

```ts
/** The comparison arguments of a read. See docs/queries.md. */
type NullOp = "isNull" | "isNotNull";

export type Where<E, O extends Partial<Record<keyof E, PropertyKey>>> = {
    [K in keyof O & keyof E]?: {
        [P in Extract<NonNullable<O[K]>, PropertyKey>]?: P extends NullOp ? true : NonNullable<E[K]>;
    };
};
export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | NullOp;
```

A null test is also a filter's job when the field declares `@queryFilter`, but
`where` keeps the alternative for a field that is comparable and not filterable,
and it combines with a `filter` on the same field. A null test on a not-null
column matches everything or nothing, so the linter rejects it there.

`filter` stays for membership: an `= any($n)` is index-friendly and reads a whole
set in one comparison, so a read may use both — `filter` to narrow cheaply, then
`where` for the range. The two are independent and combine with `and`.

```ts
/**
 * @fieldName Issue date
 * @queryWhere gte lte
 * @widget date
 */
issueDate?: Date;
```

A field may carry `@queryFilter`, `@queryWhere`, and `@queryOrderBy` at once — they
are separate read facets. An entity with no `@queryWhere` field takes no `where` (its
opts type omits the key). Like `order`, a branch carries its own `where`, checked
against the target's own `@queryWhere` whitelist.

## `limit` and `offset`

Every read pages. `limit` bounds how many rows a read returns and `offset` skips
leading rows.

```ts
const page = await queryInvoice(db, {
    filter: { tenantId: [tenantId], customerId: [customerId] },
    order: [["createdAt", "desc"]],
    limit: 25,
    offset: 50,
    select: { number: true },
});
```

`limit` defaults to **1000** and `offset` to **0**, so a root read that names
neither returns the first 1000 matching rows. The default is the resolver's
`DEFAULT_LIMIT`; pass a larger `limit` to widen the window, or a smaller one to
want less.

A branch names its own `limit` and `offset` in its read arguments, and there they
bound **each parent**, not the batch: `rows: { select: {…}, limit: 1 }` returns the
first row of every invoice, not the first row of all invoices. A branch that names
neither is unbounded. The resolver ranks a branch's rows per parent
(`row_number()` over the parent key) and keeps each parent's window, so a batched
branch still costs one query.

A non-positive `limit` or a negative `offset` is a **type error** and, over
HTTP, a 400; the resolver re-checks both, because a decoded number reaches the
SQL unchecked. There is no cursor pagination and no `limit: null` escape hatch:
`limit` is always a positive integer, the default cap included.

## Selection

A query does not return a whole entity by default. It returns the fields the
caller asks for, narrowed in the type system. `Selection` describes what may be
asked; `Selected` is the result.

```ts
/** The scalar field names of `E`: the fields a branch's `filter`, `order`, or `where` may name. */
export type ScalarKeys<E> = {
    [K in keyof E]-?: Scalar<E[K]> extends true ? K : never;
}[keyof E];

/** The arguments of a read over `E`, as a branch carries them: the same shape a root read takes. */
export type QueryArgs<E> = {
    select: Selection<E>;
    filter?: { [K in ScalarKeys<E>]?: readonly NonNullable<E[K]>[] };
    order?: readonly (readonly [field: ScalarKeys<E>, direction: Direction])[];
    where?: { [K in ScalarKeys<E>]?: { [P in CompareOp]?: NonNullable<E[K]> } };
    limit?: number;
    offset?: number;
};

/** The fields a caller wants: `true` for a scalar, `true` or a read's arguments for a branch. */
export type Selection<E> = {
    [K in keyof E]?: Scalar<E[K]> extends true ? true : true | QueryArgs<ElementOf<E[K]>>;
};

/** The result of `E` under selection `S`: only the selected keys, each optional. */
export type Selected<E, S> = {
    [K in keyof S & keyof E]?: NonNullable<S[K]> extends true
        ? E[K]
        : IsArray<E[K]> extends true
            ? Selected<ElementOf<E[K]>, BranchSelect<S[K]>>[]
            : Selected<ElementOf<E[K]>, BranchSelect<S[K]>>;
};
```

A scalar is selected with `true`; a branch (a child collection or a relation) is
selected either with `true` — every scalar of the branch, unfiltered — or with a
**read's arguments**: a required `select`, plus the `filter`, `order`, `where`,
`limit`, and `offset` a root read takes. Properties not named are absent from the
result, not `undefined`.

```ts
const [invoice] = await queryInvoice(db, {
    filter: { tenantId: [tenantId] },
    select: {
        number: true,
        // The same arguments `queryInvoiceRow` takes, applied to this invoice's rows.
        rows: {
            select: { description: true, totalAmount: true },
            order: [["totalAmount", "desc"]],
            limit: 3,
        },
    },
});
```

A branch's `select` is mandatory, so the empty object is not a branch. The
runtime reads the same annotations a root read does: a branch `filter`/`order`/
`where` is checked against the **target's** whitelists, so an unannotated field
is a runtime throw (and a 400 over HTTP) even though the branch's `filter`,
`order`, and `where` are typed structurally, over every scalar field. A root read
keeps the per-entity `Filters`/`Order`/`Where` types, so an unknown field there
stays a compile error; only a branch is checked at run time.

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
    filter: { tenantId: [tenantId], id: [id] },
    select: {
        id: true,
        number: true,
        totalAmount: true,
        rows: { select: { description: true, totalAmount: true } },
    },
});
// invoice.rows![0].totalAmount  ✓
// invoice.rows![0].taxAmount    ✗  not selected
// invoice.notes                 ✗  not selected
```

The compiler rejects a field that is not on the entity, a nested selection on a
scalar, a field not named in the selection, a branch without a `select`, a
non-array filter, and a root read that leaves out a required filter.

The generator emits the **contract and the wiring**, never SQL. It reads only
annotations: `@queryFilter` for the filters, the existing table model for the
columns, and the branch tags below. No domain name is hardcoded, so a new
`@queryFilter` field and a new entity flow through with no generator edit.

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
`docs/invoice-snapshotting.md`. An inlined branch still takes a `select`, but its
other read arguments have nowhere to apply: there is no separate statement to
filter, order, or page, so they are ignored for an inlined branch.

The generator records the distinction in `queryModel`, from the branch tags the
table model already carries (`packages/backend/scripts/postgres-model.ts`):

```ts
customer: { kind: "relation", table: "customer", column: "customerId" }
rows:     { kind: "children", table: "invoice_row", column: "invoiceId" }
snapshot: { kind: "inlined", columns: { name: "customerName" } }
```

The resolver types these as a union on `kind`, so a branch to another table always
carries its `table` and `column`, and an inlined one only its `columns`.

Relation and inlined columns are not the same here. Inlined columns are excluded
from the table's selectable `fields`, because the spec never declares them. A
relation's foreign key *is* excluded from nothing: it is the `@foreignKey` field
the interface declares, so `Invoice.customerId` is a selectable field and — with
`@queryFilter` — an ordinary filter. `InvoiceRow.invoiceId` is the same thing.

## The resolver reads one query per branch

`resolveMany` (`packages/backend/src/db/resolvers.ts`) builds the SQL at run
time from `queryModel` plus the selection:

- **Scalars** — projected into the root query.
- **`@inlined`** — projected from the same row, aliased per target field. No query.
- **`@relation`** — one batched `where target.key = any($n)` for every distinct
  foreign key, attached back by key.
- **`@children`** — one batched `where child.fk = any($n)`, grouped in memory.

A branch's own arguments join that statement: its `filter` narrows the batched
`= any($n)` set, its `where` adds comparisons on the target's columns, and its
`order` sorts the batch before it is grouped. Its `limit`/`offset` bound each
parent, which needs a ranked subquery rather than a plain `limit` — the resolver
ranks the branch rows over the parent key and keeps each parent's window. A
branch with no `select` throws, as does a filter, order, or comparison the target
does not allow.

A projected scalar is copied only when its column is not `null`, and a to-one
branch whose foreign key is `null` is left out. A `null` column and an absent
key therefore look the same on the wire: a value is present exactly when the
column has one, so an optional field may be absent and a required one never is.
See `docs/optionality.md`.

There is **no JSON aggregation**. A branch costs one extra query, batched over
all parents at that level; nested branches recurse the same way, one query per
branch per level. The resolver holds no domain knowledge — it only reads
`queryModel`, so a new entity and `@queryFilter` field need no resolver change.

Arguments filter by set membership: the generated filters are the scalar fields
that carry `@queryFilter` (plus every `@primaryKey` field), and a relation's
`@foreignKey` field is one of them. An unknown filter field throws rather than
silently dropping a clause, as does a non-array value, and a filter the spec marks
`required` throws when the read does not name it. `String`, `Date`, and
`decimal` values pass through unchanged.

A filter value is always an array, so a lookup names a one-element set and an
empty set matches nothing. Each set is bound as a single array parameter, so a
batched branch over any number of parents still carries one parameter for its keys,
and Postgres infers the array's element type from the column. Multiple filters are ANDed. The linter rejects
`@queryFilter` on a branch field, so a filter always names a scalar column.

Ordering, paging, and comparisons are applied the same way: the resolver reads
the table's `order`/`defaultOrder` and `where` whitelists from `queryModel`,
refuses a field or operator that is not on them, and validates the direction and
operator before they reach the SQL, where every value is parameterized. A root
read's `limit` defaults to 1000 and its `offset` to 0, and a value that is not a
positive integer or a non-negative integer is rejected; a branch's `limit`/`offset`
are optional and bound each parent. A branch keeps the batch's grouping stable,
because the ranked window orders each parent's rows before they are grouped.

## Gotchas

- **Every selected key is optional.** `Selected` marks each selected key `?`, so
  `Selected<Invoice, { number: true }>` is `{ number?: string }`. A `null` column
  is omitted rather than carried as `null`, so a value is present only when the
  column has one: selection narrows the type, and the runtime object lacks a key
  it did not select or that was `null`.
- **`true` on a branch selects scalars only.** It does not recurse into nested
  branches, so a default selection cannot fan out into unbounded joins.
- **A branch is `true` or a read's arguments.** An object branch requires a
  `select`, so `rows: {}` is invalid; `rows: { select: { description: true } }` is
  how a branch is narrowed. On an **inlined** branch only `select` applies — there
  is no separate statement to filter, order, or page.
- **A branch's facets are typed structurally, checked at run time.** The branch's
  `filter`, `order`, and `where` accept every scalar field of the target, because a
  hand-written `Selection` cannot read the target's annotations. The resolver (and
  the generated args schema, over HTTP) still refuses a field or operator the
  target does not allow, so an unannotated one is a throw or a 400 rather than a
  compile error. A root read keeps the exact `Filters`/`Order`/`Where` types.
- **A filter reads columns the selection may omit.** `select` governs the
  projection; the `args` still read whatever they name, and so do `order` and
  `where`.
- **Set membership, a null test, or the `@queryWhere` operators.** A `filter` is
  an array matched with `= any($n)`, or `{ isNull: true }`/`{ isNotNull: true }`
  on a nullable field; an empty set matches nothing, and a value that is neither
  throws. A comparison goes through `where`, whose operators are whitelisted per
  field, and whose null tests take `true`. A range is `{ gte, lte }`, not a
  `between`.
- **`eq` overlaps `filter`.** `where: { id: { eq } }` says what
  `filter: { id: [value] }` already says; `eq` exists for symmetry and `ne` is
  the operator a set cannot express, as are the two null tests.
- **Filters come only from `@queryFilter`, plus the primary key.** A field
  without the tag is not filterable, each `@primaryKey` field is a filter without
  it, and a branch field may not carry it. A parent is not filtered by a related
  record's columns, such as `customer.name`; a branch's own `filter` narrows the
  branch, and the foreign key is a scalar field, so `customerId` is filterable.
- **A default fills a hole, it does not narrow by itself.** `@queryFilter
  default=<value>` applies when a read omits the filter; a read that names it
  overrides the declared value. This is how a nullable `deletedAt` reads live rows
  by default (`docs/soft-delete.md`).
- **A required filter is a precondition, not a filter value.** `@queryFilter
  required` narrows nothing by itself; it makes the caller name the field. Every
  tenant-owned entity marks its `tenantId` that way, so a read cannot quietly span
  tenants, while `Tenant`, `Translation`, and `AuditLog` — the entities without a
  tenant — stay unscoped. A scoped foreign key is what keeps a *write* from
  linking two tenants; see `docs/tenancy.md`.
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
- **Ordering comes only from `@queryOrderBy`.** A field without the tag cannot
  order, and a direction is `asc` or `desc`. The tag is scalar-only, so a branch
  field may not carry it; a branch orders by its own entity's fields, through the
  same whitelist.
- **A root read is capped by default, a branch is not.** `limit` defaults to 1000
  on a root read, so a filter that matches more rows returns the first 1000 unless
  the caller asks for more. There is no `limit: null` for "all rows"; a root page
  is always bounded, while a branch returns every matching row unless it names its
  own `limit`.
- **`offset` is not a cursor.** A concurrent insert or delete can shift a row
  across pages between calls. Stable paging over a mutable table needs a keyset
  cursor, which is not implemented.
- **The read types are shared, the reader is not.** `Selection`, `Selected`,
  `QueryArgs`, `Filters`, `Order`, and `Where` are pure types with no query in
  them, so they live in `packages/validation/src/selection.ts` and both the
  backend and the generated REST client import them from there. The SQL, the
  resolver, and the metadata stay in the backend.

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

- **Comparing or filtering a parent by a branch's columns.** `@queryWhere` and
  `@queryFilter` are scalar-only, so `queryInvoice` cannot compare or filter on a
  related record's columns, such as `customer.name`. A branch's own `filter` and
  `where` narrow the branch, not the parent; the foreign key is a scalar field, so
  `customerId` filters the parent.
- **More comparison operators.** The vocabulary is `eq ne gt gte lt lte`. `like`,
  `isNull`, and a case-insensitive match would each be another entry.
- **Comparisons across fields.** A `where` value is a literal, not a column
  reference, so `totalAmount > netAmount` is not expressible.
- **A row at most, not exactly one.** There is no `limit 1` shorthand; a caller
  takes the first result, which fetches a whole page.
- **Cursor pagination and a total count.** `limit`/`offset` page a read, but
  there is no keyset cursor and no way to ask how many rows matched.
- **`@projection` generation.** If static read SQL is ever wanted, the hook is a
  `@projection` tag on a `Pick<Entity, "…">` alias, emitting a view or a column
  list. It is not built.
- **Returning a whole entity in one call.** There is no `select: true` shorthand
  for the entire interface; a caller names the fields.
- **A transaction around a multi-query read as a property of a read.** A batched
  branch and its root are separate statements, so a concurrent write can be
  observed between them; a caller that needs the two to agree wraps them in a
  `transaction` group, which a read does not do on its own
  (`docs/transactions.md`).
