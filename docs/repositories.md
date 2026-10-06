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

- **create** — one `insert into "t" (...) values ($1, ...), ($n, ...)`.
- **update** — one statement per row, `update "t" set ... from (values (...)) as data(...) where "t"."id" = data."id"`, all in one boundary.
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

A column with a database default is written like any other, and a create may
omit it: the statement then carries the `default` keyword for that value, so the
database applies its default for that row alone. A required field with a default
is relaxed to optional in `<Entity>Insert`, and its schema is `.partial()`, so
the type and the wire agree that omitting it is allowed. A `@version` field is
the exception: a defaulted version is left out of a create entirely, because its
default *is* the first revision (`docs/versioning.md`).

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

`update` writes one statement per row, naming only the columns that row
supplies. An omitted field is not in the `set` clause at all, so it keeps its
stored value, while a field the caller sets to `null` writes a null:

```sql
update "customer"
    set "name" = data."name"
from (values (…) ) as data("id", "name", "version")
where "customer"."id" = data."id" and "customer"."version" = data."version"
```

Nothing is derived from a `null`: the two requests are told apart before the SQL
is built, by the emitted `if (row.name !== undefined)`, rather than folded into
one `coalesce`. `coalesce` could not do it — it cannot distinguish a field the
caller omitted from one set to `null`, so a null read as "not supplied" and the
stored value was kept.

The key columns travel in the tuple so the statement is matched to a row on all
of them, and the version travels in it so the `where` can compare it. The version
is never in the `set` clause: the trigger increments the column, and a statement
that assigned it would make the trigger's own guard fire. See `docs/versioning.md`.

A statement that matches no row is a rejected call rather than a no-op: the
generated code reads the affected-row count and throws `code: "40001"`, which is
the `409` the router already serves for a version conflict. That covers both a
stale version and an id that is not there, and it aborts the surrounding
transaction, so a multi-row patch whose second row is stale writes nothing.

More than one row is more than one statement, so the call opens a boundary and
the rows commit together; a single row is a single statement and runs on the
handle it was given. A row that supplies no field at all sets its key to the key
it already holds, so the statement stays valid — and still puts the version
predicate in front of it.

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
  that omits one sends the `default` keyword, so the database fills that row; a
  patch that omits one keeps the stored value. The clock fields are the different
  case: `createdAt` and `updatedAt` are excluded from `insert` and `update`
  outright, so writing one takes raw SQL. A `@version` column is excluded from
  `insert` too, and on update it goes into the `where` rather than the `set`.
- **`update` enforces the version with a predicate, and the database raises it.**
  The `@version` column is matched in the `where`, so a stale one matches no row
  and the generated code rejects the call with the `40001` that maps to a `409`.
  The increment stays in a database trigger. A rejection does not say whether the
  version was stale or the row was missing. See `docs/versioning.md`.
- **A patch cannot set a non-nullable column to null.** Nullable columns are the
  exception: a patch sets one to `null` to clear it. `Invoice.notes`,
  `Invoice.number`, and the optional foreign keys are the ones in this model.
- **A patch of several rows is several statements.** They commit together in one
  boundary, so the call is atomic, but it is not the single statement a create
  or a delete is. Passing one row avoids the boundary entirely. See
  `docs/transactions.md`.
- **A patch whose rows disagree about who won rejects all of them.** One stale
  row aborts the boundary, so rows the earlier statements already matched are
  rolled back too. Retrying is the caller's job. See `docs/versioning.md`.
- **A patch is all-or-nothing per row, not per field-set.** Each statement names
  the columns its row supplies, so a row that omits a field leaves that column
  alone rather than writing the stored value back. That is a no-op either way,
  but it means the written columns are a signal of what the caller sent.
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
