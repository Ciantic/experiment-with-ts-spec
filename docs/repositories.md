# Repositories

`packages/backend/scripts/generate-repositories.ts` writes one module per
operation into `packages/backend/src/db/repositories/`, named after the function
it exports: `createInvoice.ts`, `updateInvoice.ts`, `deleteInvoice.ts`.

- `pnpm generate:repositories` — writes the operation modules and their barrel.
- `pnpm generate:repositories --out <dir>` — writes elsewhere. A missing directory is created.

The output is committed. Regenerate rather than editing it by hand.

## What a repository is here

Each entity gets three modules, one per operation:

```ts
// createCustomer.ts
createCustomer(db: SqlExecutor, rows: CustomerInsert[]): Promise<void>
// updateCustomer.ts
updateCustomer(db: SqlExecutor, rows: CustomerPatch[]): Promise<void>
// deleteCustomer.ts
deleteCustomer(db: SqlExecutor, rows: CustomerPrimaryKey[]): Promise<void>
```

The barrel `index.ts` re-exports every operation module, so a caller imports the
function it wants from one path.

`create` takes an **insert** — the fields a create writes — and `update` takes a
**patch**, so a caller changes the fields it has without having to read and
resend the rest; see "Inserting" and "Patching" below. `delete` takes the
**primary key**, because the key is the whole of what its statement reads.

Every function takes an array and returns nothing. **Reading is not part of a
repository.** There is no `getById`, no list, no query builder. Those belong to
whatever reads the data — a projection, a report, a view — and are deliberately
not part of a repository, because their shape is a product decision rather than
a mapping of the spec. Reads are generated separately from the entities in
`packages/backend/src/db/queries/`; see `docs/queries.md`.

`SqlExecutor` (`src/db/sql-executor.ts`) is the whole database surface:
`query(sql, parameters?)` and `transaction(run)`. The generated modules never
import a driver, so `pg` stays an optional dependency. A driver reaches the port
as a `SqlPool` (`src/db/sql-pool.ts`): `pg`'s `Pool` satisfies it directly, and
PGlite through `createPglitePool`. Tests assert both fits, so the structural
types cannot drift away from the drivers.

## Why arrays

A repository that takes one row per call forces one round trip per row. Taking
an array lets one call carry many rows, which is the whole reason the functions
exist in this shape:

- **create** — one `insert into "t" (...) select … from unnest(...)` per chunk of rows, in one boundary when a call spans several chunks.
- **update** — one statement per chunk of rows, `update "t" as u set ... from unnest(...) as v(...) where u."id" = v."id"`, in one boundary whenever the call carries more than one row.
- **delete** — one `delete from "t" using (values (...), (...)) as data("id") where "t"."id" = data."id"`.

Each function returns early on an empty array, so the caller does not have to
guard.

## Inserting

`create` takes an insert rather than the whole entity. The type lives in
`packages/validation`, in the module that also exports the schema accepting the
same fields, and the repository imports it:

```ts
import type { InvoiceInsert } from "validation/repositories/invoiceInsertSchema.ts";

export async function createInvoice(db: SqlExecutor, rows: InvoiceInsert[]): Promise<void>
```

`InvoiceInsert` is the entity minus every field the statement does not write, so
it mirrors the SQL exactly. A whole entity is still assignable to it, so a caller
holding one can pass it unchanged. What the type rules out is a field that would
be read and then dropped — a branch, a clock field, a `@pgVirtual` column, or a
derivable value — which is the same set `<entity>InsertSchema` accepts
(`docs/validation.md`). An entity with nothing to omit gets
`type <Entity>Insert = <Entity>`.

The statement binds one array per column and reads them as rows with `unnest`,
the shape `Patching` describes in full: a column a row may leave out binds a
second array of flags saying whether that row supplied it.

```sql
insert into "customer" ("id", "name", "source") select
    v."id",
    v."name",
    case when v."source#present" then v."source" else 'manual' end
from unnest($1::uuid[], $2::text[], $3::text[], $4::bool[])
    as v("id", "name", "source", "source#present")
```

The fallback for an omitted column is the column default, where a patch falls
back to the value the row already holds. A create may therefore omit a column
with a database default, and the statement writes the default the spec declares,
since the `default` keyword is not allowed outside an `insert … values` list. A
required field with a default is relaxed to optional in `<Entity>Insert`, and its
schema is `.partial()`, so the type and the wire agree that omitting it is
allowed. A `@version` field is the exception: a defaulted version is left out of
a create entirely, because its default *is* the first revision
(`docs/versioning.md`).

One statement binds at most `MAX_STATEMENT_PARAMETERS` values
(`src/db/sql-executor.ts`), so a create whose rows would bind more than that
splits into chunks of `floor(MAX_STATEMENT_PARAMETERS / <bound arrays>)` rows. A
call that fits in one chunk is one statement and runs on the handle it was
given; a call that spans several chunks opens a boundary and runs them all
in it, nested as a savepoint when the caller already holds one, so the rows
still commit together. The bound is the driver's rather than the protocol's:
PostgreSQL accepts 65535 parameters, while PGlite past 32767 drops the
statement without an error and answers nothing afterwards, so the generated
code stays inside the smaller number. The shortfall is PGlite's own: it reads
and writes the protocol's 16-bit counts with the signed `getInt16`/`setInt16`,
where the wire format is unsigned. Filed upstream as
[electric-sql/pglite#1118](https://github.com/electric-sql/pglite/issues/1118);
the constant can move to the protocol's 65535 once that is fixed.

An insert writes every row it carries, so each statement's affected-row count is
compared with the chunk it was given, and a short count is a rejected call. That
is what makes a silent loss loud: a `before insert` trigger returning `null`
skips its row without raising, and a driver that quietly declines a statement
answers nothing at all. Neither is a caller's mistake, so the thrown error
carries no SQLSTATE and the router serves it as a server fault.

## Patching

`update` takes a patch rather than a whole entity. The type lives in
`packages/validation`, narrowed to the columns the statement writes, and the
repository imports it:

```ts
import type { CustomerPatch } from "validation/repositories/customerPatchSchema.ts";

export type CustomerPatch = Omit<Partial<Customer>, "createdAt" | "updatedAt"> & Required<Pick<Customer, "id" | "version">>;
```

Every written column is optional except two, which are the keys the rest of the
design leans on:

- **The primary key** says which row to write. It is the field or fields tagged
  `@primaryKey`; a composite key requires every one of them, and the statement
  matches a row on all of them.
- **The `@version` column**, where one exists, is the optimistic-lock
  precondition (`docs/versioning.md`). It is required so a patch cannot
  accidentally skip the check. For an entity with no version — the snapshots —
  only the key is required.

A field the statement does not write is left out of the type rather than being
accepted and ignored, so `<Entity>Patch` permits exactly the fields its `update`
touches. That is a branch — a `@relation` or `@children` field, which has no
column — a column the database owns outright: a clock field, a virtual generated
column (`@pgVirtual`), or a nullable `@computed` field its mechanism fills in.
A `@pgDefault` column is *not* on this list: a patch may override a default, the
same way a create may.

`update` writes one statement per chunk of rows, naming every column a patch may
supply. Whether a row supplied one travels with the row as a presence flag, so a
field the caller omitted keeps its stored value while a field the caller sets to
`null` writes a null:

```sql
update "customer" as u
    set "name" = case when v."name#present" then v."name" else u."name" end
from unnest($1::uuid[], $2::text[], $3::bool[]) as v("id", "name", "name#present")
where u."id" = v."id" and u."version" = v."version"
returning u."id"
```

Nothing is derived from a `null` on its own, because a null cannot say whether
the caller omitted the field or sent it as `null`; each row therefore carries the
flag beside the value, and the `set` clause asks for the flag. `coalesce` cannot
tell the two apart, so a null would read as "not supplied" and the stored value
would be kept. The `#present` suffix cannot collide with a column, because a spec
field name holds no `#`.

A column therefore costs two elements per row, its value and its flag, and a
chunk is sized on that: `ROWS_PER_STATEMENT` counts the cells a row carries the
way the insert counts its columns. An entity with no writable column at all sets
its key to the key it already holds, so the statement stays valid whatever a
patch carries.

The key columns and the version travel in the same arrays: the keys match each
row to the one it addresses, and the version goes into the `where`, so a stale
one matches no row. The version is never in the `set` clause: the trigger
increments the column, and a statement that assigned it would make the trigger's
own guard fire. See `docs/versioning.md`.

A statement that writes fewer rows than its chunk carried is a rejected call
rather than a no-op: the statement returns the keys it wrote, and the generated
code throws `code: "40001"` naming the rows it did not, which is the `409` the
router already serves for a version conflict. That covers both a stale version
and an id that is not there.

A call carrying more than one row opens a boundary, and its chunks commit
together; a single row is one atomic statement and runs on the handle it was
given. Several rows need the boundary even when one statement carries all of
them, because the statement writes the rows it matches before the rejection is
raised. See `docs/transactions.md`.

`<Entity>Patch` and `<name>PatchSchema` are the same set: both are built from
`omittedFromPatch` and `nullablePatchProperties` (`packages/spec/scripts/spec-model.ts`)
into one `packages/validation` module, so the repository type and the wire schema
cannot drift apart. A field neither writes is a 400 on the wire and a type error
in process, rather than a field that quietly does nothing (`docs/validation.md`).

## Deleting

`delete` takes an entity's **primary key**, `<Entity>PrimaryKey`, the key alone
rather than the whole entity, because the key is the only thing its statement
reads. The type and its matching `<name>PrimaryKeySchema` are generated from the
`@primaryKey` fields in `packages/validation`, in the by-key module:

```ts
import type { CustomerPrimaryKey } from "validation/repositories/customerPrimaryKeySchema.ts";

export type CustomerPrimaryKey = Pick<Customer, "id">;
```

A composite key names every one of its columns, and the delete's `where` matches
on all of them, so a partial key cannot address a row:

```ts
export type TranslationPrimaryKey = Pick<Translation, "lang" | "key">;
```

The wire schema is the same field set — the delete route validates
`z.array(customerPrimaryKeySchema)` — so the caller, the schema, and the
statement agree on what a delete carries (`docs/rest-api.md`).

## Where the columns come from

The generator does not read `schema.sql` and does not re-parse the spec: it
consumes the same table model as the schema generator, from
`packages/backend/scripts/postgres-model.ts`, which maps the parsed spec
(`packages/spec/scripts/spec-model.ts`) to columns. One interpretation of
`@pgTable`, `@relation`, `@children`, `@inlined`, the `@primaryKey`/`@foreignKey`
key tags, and type mapping feeds both the DDL and the repositories, so a
repository cannot name a column the schema does not have.

The column value is read through the accessor recorded on the model, so an
inlined optional customer is written as `row.customer?.name`, without the
generator special-casing it. A relation contributes no column of its own: its
`@foreignKey` field is an ordinary column, read as `row.customerId`.

A column with a database default (`@pgDefault`) is written when the row supplies
it, and its tuple carries the `default` keyword when the row omits it, so the
database fills that row's value. The clock tags are the different case: they
never appear in a generated `insert`, because the default fills `createdAt` and
`updatedAt` on insert and the trigger refreshes `updatedAt` on every write; see
`docs/timestamps.md`.

A `@computed` column the database can fill later is left out too, so the
`insert` names exactly the insertable fields and nothing else. That is the whole
of `<entity>InsertSchema`, which is why the statement and the wire schema cannot
disagree (`docs/validation.md`). A nullable trigger-derived column is
in that set; a `@pgVirtual` column always is, required or not, because Postgres
rejects a write to a generated column outright. A *required* trigger-derived
column stays: it has no default and no nullable column, so the insert has to
carry it.

A *nullable* computed column is likewise left out of a patch, and out of the
`update` statement with it: a `before insert or update` trigger reassigns the
column from the fields it derives from, so naming it would write a value the
trigger then overwrites. A *required* computed column stays in the patch, since
it has no stored value to fall back on.

The one exception is a `@version` column. It is defaulted, so it is omitted on
insert, but a patch sends it into the `where` as the optimistic-lock
precondition the trigger checks. The generator therefore builds the insert and
patch column sets separately; see `docs/versioning.md`.

## Gotchas

- **Foreign keys have no `ON DELETE` clause**, so `deleteInvoice` fails while
  rows still reference it. Deleting children is the caller's job; there is no
  cascade.
- **A required computed column is supplied and then overwritten.** The insert
  sends it, the before-trigger overwrites it, so passing a value has no effect.
  Whether one is required follows the field's optionality, not the computation:
  `InvoiceSentRow.netAmount` is required and `not null`, so the insert has to
  carry it, while `InvoiceRow.netAmount` is optional and its column nullable. A
  *nullable* computed column is named in neither the `insert` nor the `update`,
  so its value is left to the trigger that fills it
  (`docs/validation.md`).
- **A defaulted column is written only when the caller supplies it.** A create
  that omits one writes the default the spec declares, so that row gets the same
  value the database would have; a patch that omits one keeps the stored value.
  The clock fields are the different
  case: `createdAt` and `updatedAt` are excluded from `insert` and `update`
  outright, so writing one takes raw SQL. A `@version` column is excluded from
  `insert` too, and on update it goes into the `where` rather than the `set`.
- **`update` enforces the version with a predicate, and the database raises it.**
  The `@version` column is matched in the `where`, so a stale one matches no row
  and the generated code rejects the call with the `40001` that maps to a `409`,
  naming the rows the statement did not write. The increment stays in a database
  trigger. A rejection does not say whether the version was stale or the row was
  missing. See `docs/versioning.md`.
- **A patch cannot set a non-nullable column to null.** Nullable columns are the
  exception: a patch sets one to `null` to clear it. `Invoice.notes`,
  `Invoice.number`, and the optional foreign keys are the ones in this model.
- **A patch of several rows is one statement per chunk of rows.** The chunks
  commit together in one boundary, so the call is atomic, but it is not the
  single statement a create or a delete is. Passing one row avoids the boundary
  entirely. See `docs/transactions.md`.
- **A patch whose rows disagree about who won rejects all of them.** One stale
  row aborts the boundary, so rows the earlier statements already matched are
  rolled back too. Retrying is the caller's job. See `docs/versioning.md`.
- **A patch is all-or-nothing per row, not per field-set.** The statement names
  every column a patch may write, and each row's flag says which of them the
  caller sent, so a row that omits a field writes the stored value back. That is
  a no-op, but it means the flags are the signal of what the caller sent rather
  than the `set` clause.
- **`delete` keys on the primary key only.** `deleteCustomer` takes
  `CustomerPrimaryKey[]` and has no patch variant and no version precondition.
- **No transaction wrapping by the caller.** A create or a delete is atomic on
  its own, and a patch of several rows opens its own boundary; anything spanning
  more than one *call* needs a boundary the caller opens: `SqlExecutor` carries
  `transaction`, and a repository does not call it for that
  (`docs/transactions.md`).

## Deliberately not implemented

- **Queries.** Reads are generated from the entities in
  `packages/backend/src/db/queries/`, not in a repository; see `docs/queries.md`.
- **Upsert and full-row replacement.** `update` is a patch; there is no "write
  exactly this object" variant, and no insert-or-update.
- **Cascade delete** for `@children`. A child table's foreign key has no
  `ON DELETE`, so a parent with children cannot be deleted.
- **A unit of work inside a repository.** No function opens a boundary: a
  repository runs its statement on the executor it is handed, and a caller that
  needs more than one call to be atomic opens the boundary itself
  (`docs/transactions.md`).
- **A drift test.** Like `schema.sql`, staleness is caught by running
  `pnpm generate:repositories`, not by a test.
