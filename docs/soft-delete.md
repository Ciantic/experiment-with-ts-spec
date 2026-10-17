# Soft delete

An entity is soft-deletable when one of its fields carries `@deletedAt`. A
trashed row stays in its table with the moment it was trashed; reads stop
returning it, and `trash` and `restore` move a row in and out of that state. A
real `delete` is still there for a row that has to go.

`Invoice` carries it in the spec:

```ts
/**
 * The moment the invoice was trashed; absent while it is live.
 *
 * @fieldName Deleted at
 * @deletedAt
 * @widget date
 */
deletedAt?: Date;
```

## The column

`@deletedAt` is a bare marker on a `Date` field, and the column is a plain
nullable `timestamptz`:

```sql
"deletedAt" timestamptz
```

- **`null` means live.** The field is optional, the reverse of the clock tags
  (`docs/timestamps.md`), whose columns are never null. A required `@deletedAt`
  field is a lint finding.
- **No default and no trigger.** The value is written by `trash` and `restore`
  alone, so the tag is exclusive with `@computed`, `@pgDefault`, `@createdAt`,
  `@updatedAt`, `@version`, `@primaryKey`, and the mechanism tags.
- **No create or patch writes it.** The tag leaves the field out of
  `<name>Insert`, `<name>Upsert`, and `<name>Patch`, and out of their schemas, so
  a caller cannot trash a row by smuggling the field into an ordinary write. It
  is a regular field on a read, so a caller can select it.
- **One per interface.** `trash` and `restore` need one column to write.

## Reads hide trashed rows

A read of a soft-deletable entity returns live rows unless it says otherwise.
The generated `query<Entity>` takes a `trashed` argument:

| `trashed` | Rows returned |
| --- | --- |
| `"exclude"` (the default) | live rows: `"deletedAt" is null` |
| `"include"` | every row |
| `"only"` | trashed rows: `"deletedAt" is not null` |

```ts
const live = await queryInvoice(db, { filter: { tenantId: [tenantId] }, select: { number: true } });
const bin = await queryInvoice(db, { filter: { tenantId: [tenantId] }, trashed: "only", select: { number: true } });
```

The clause is `and`-ed with the filters and comparisons, so `trashed: "only"`
with a `filter` narrows the bin. The argument exists only on an entity with the
tag: the generated type, the wire schema, and the SDK offer it there, and the
resolver throws for `trashed` on a table that has no `@deletedAt` column.

This is not a `@queryFilter`. A filter is a set matched with `= any($n)`, and a
set cannot say `is null` or `is not null`. `@deletedAt` brings the exclusion
with it, the way `@primaryKey` brings its filter (`docs/queries.md`), so the
spec has one spelling for it: a `@queryFilter` on a `@deletedAt` field is a lint
finding.

### Branches

A `@children` or `@relation` branch reads through the same resolver, so it hides
trashed rows by default too: a trashed `InvoiceRow` is absent from
`Invoice.rows`, and a relation to a trashed row is absent as well, as if the
foreign key were null. A branch takes the same `trashed` argument as a root read
(`rows: { select: …, trashed: "include" }`). The argument is typed structurally
on a branch and checked at run time, like the rest of a branch's facets
(`docs/queries.md`).

## `trash` and `restore`

Both are write operations named in `@repository`, and in `@restRepository` to
expose them. Either one needs a `@deletedAt` field on the entity, which the
linter checks.

```ts
// trashInvoice.ts
trashInvoice(db: SqlExecutor, rows: InvoiceTrashKey[]): Promise<void>
// restoreInvoice.ts
restoreInvoice(db: SqlExecutor, rows: InvoiceTrashKey[]): Promise<void>
```

`<Entity>TrashKey` is the primary key, plus the `@version` field when the entity
has one: `{ id, version }` for `Invoice`, `{ id }` for an entity without a
version. It is declared in `packages/validation`, beside the schema that
validates it (`<entity>TrashKeySchema`).

## Trash and restore claim the version

A trash is a state change a user acts on from a copy they read earlier, so on an
entity with `@version` it carries the version the caller holds, exactly as an
`update` does (`docs/versioning.md`). The statement matches the key *and* the
version, writes the rows it matches, and returns their keys:

```sql
update "invoice" set "deletedAt" = coalesce("invoice"."deletedAt", now())
    from (values ($1::uuid, $2::int8), …) as data("id", "version")
    where "invoice"."id" = data."id" and "invoice"."version" = data."version"
    returning "invoice"."id"
```

```sql
update "invoice" set "deletedAt" = null
    from (values ($1::uuid, $2::int8), …) as data("id", "version")
    where "invoice"."id" = data."id" and "invoice"."version" = data."version"
    returning "invoice"."id"
```

- **A stale version rejects the call.** A row the statement did not write, whether
  its version has moved on or the key is not there, fails the call with the
  `40001` conflict `update` raises (a `409` over REST). A call carrying several
  rows runs in one boundary, so a rejection writes none of them.
- **The trigger moves the version on.** The statement sends the caller's version,
  so the check passes and the trigger increments it, and `updatedAt` is
  refreshed. After a trash the caller holds a stale version, and a restore needs
  the one the trash produced: read it again, or take it from the next read with
  `trashed: "only"`.
- **A repeat at the current version is harmless.** Trashing an already-trashed row
  at its current version keeps the first `deletedAt` (the `coalesce`), though it
  still bumps the version.
- **A restore can fail.** Restoring a row whose `@unique` value a live row has
  since taken violates the unique index, and the statement raises it.

### An entity without a version

With no `@version` there is nothing to claim, so each takes the key alone and
matches the state instead:

```sql
update "memo" set "deletedAt" = now() from (values ($1::uuid), …) as data("id")
    where "memo"."id" = data."id" and "memo"."deletedAt" is null
```

```sql
update "memo" set "deletedAt" = null from (values ($1::uuid), …) as data("id")
    where "memo"."id" = data."id" and "memo"."deletedAt" is not null
```

That is **idempotent**: trashing a trashed row, restoring a live one, and naming
a key that is not there all match nothing, write nothing, and report nothing
missing, which is how `delete` behaves.

Over REST each is a `POST` to an action path with the rows in the body, validated
against `<entity>TrashKeySchema`:

| Call | Id | Method | Path | Argument |
| --- | --- | --- | --- | --- |
| trash | `trash<Entity>` | `POST` | `/<table>/trash` | `[{ id, version }]` in the body |
| restore | `restore<Entity>` | `POST` | `/<table>/restore` | `[{ id, version }]` in the body |

They are not a `DELETE` or a `PATCH`, because neither verb says "change one state
column by key", and they are not under `q` because they are state changes, not
reads. The SDK exposes `trash<Entity>(rows)` and `restore<Entity>(rows)`, and a
group names them by id like any other call (`docs/transactions.md`).

## Uniqueness

A trashed row keeps its values, so a plain `unique` constraint would hold a
trashed invoice's `number` forever. On a table with a `@deletedAt` column,
`@unique` is emitted as a partial unique index over live rows instead:

```sql
create unique index "invoice_number_key" on "invoice" ("number") where "deletedAt" is null;
```

A value freed by `trash` can be created again, and `restore` into a taken value
fails as above. The primary key and the `(scope, key)` constraints a scoped
`@foreignKey` needs stay full constraints, because a reference has to resolve
whether or not its target is trashed.

## Gotchas

- **`trash` does not cascade.** Trashing an invoice leaves its rows live. They
  disappear from `Invoice.rows` along with the invoice but remain readable
  through `queryInvoiceRow`, and `restore` brings the invoice back with nothing
  to repair.
- **A trashed row is still writable.** `update` and `delete` address a row by key
  whatever its state, and a foreign key may still point at it. Hiding is a read
  rule, not a write lock.
- **`@inlined` flattens the field.** A snapshot that inlines a soft-deletable
  entity would copy its `deletedAt`, since `@inlined` takes every scalar field
  (`docs/invoice-snapshotting.md`). Snapshots inline entities that are not
  soft-deletable here.
- **Paging follows the exclusion.** `limit` and `offset` apply to the rows left
  after trashed ones are hidden, so a page of a live list never contains one.

## Deliberately not implemented

- **Cascading trash.** A parent's trash does not touch its children.
- **An actor column.** Who trashed a row (`deletedBy`) is not modelled, as with
  `updatedBy` (`docs/timestamps.md`).
- **Purge of old rows.** `delete` removes a row for good; nothing removes trashed
  rows on a schedule.
