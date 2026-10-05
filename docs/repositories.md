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
an array lets the generator emit a single multi-row statement, which is the
whole reason the functions exist in this shape:

- **create** — `insert into "t" (...) values ($1, ...), ($n, ...)`.
- **update** — `update "t" set ... from (values (...), (...)) as data(...) where "t"."id" = data."id"`.
- **delete** — `delete from "t" using (values (...), (...)) as data("id") where "t"."id" = data."id"`.

Each function returns early on an empty array, so the caller does not have to
guard.

## Inserting

`create` takes an insert rather than the whole entity. The type lives in
`packages/validation`, next to the schema that accepts the same fields, and the
repository imports it:

```ts
import type { InvoiceInsert } from "validation/invoice.ts";

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
import type { CustomerPatch } from "validation/customer.ts";

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
column (`@pgVirtual`), or a nullable `@computed` field a trigger derives. An
entity that writes every column keeps the plain `Partial<Entity>` shape. A
`@pgDefault` column is *not* on this list: a patch may override a default, the
same way a create may.

The emitted statement writes every patchable column, using `coalesce` to keep a
stored value when the patch omits one:

```sql
update "customer"
    set "name" = coalesce(data."name", "customer"."name"),
        "version" = data."version"
from (values (…)) as data("id", "name", "version")
where "customer"."id" = data."id"
```

The alternative — emitting only the columns a caller actually supplied — is not
possible for a generated statement, because the generator does not know at
build time which keys a patch will carry at run time. A static column list with
`coalesce` is what makes one statement work for any subset of fields.

The version is assigned directly rather than coalesced: it is required, so there
is nothing to fall back to, and the trigger must see the caller's value to
compare it against the stored one.

A table with nothing to patch sets its key to the key it already holds, so the
statement stays valid.

`<Entity>Patch` and `<name>PatchSchema` are the same set: both are built from
`omittedFromPatch` (`packages/spec/scripts/spec-model.ts`) into one
`packages/validation` module, so the repository type and the wire schema cannot
drift apart. A field neither writes is a 400 on
the wire and a type error in process, rather than a field that quietly does
nothing (`docs/validation.md`).

## Deleting

`delete` takes an entity's **primary key**, `<Entity>PrimaryKey`, the key alone
rather than the whole entity, because the key is the only thing its statement
reads. The type and its matching `<name>PrimaryKeySchema` are generated from the
`@primaryKey` fields in `packages/validation`, next to the patch and insert
types:

```ts
import type { CustomerPrimaryKey } from "validation/customer.ts";

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
disagree (`docs/validation.md`). A nullable trigger- or rollup-derived column is
in that set; a `@pgVirtual` column always is, required or not, because Postgres
rejects a write to a generated column outright. A *required* trigger column
stays: it has no default and no nullable column, so the insert has to carry it.

A *nullable* computed column is likewise left out of a patch, and out of the
`update` statement with it: a `before insert or update` trigger reassigns the
column from the fields it derives from, so naming it would write a value the
trigger then overwrites. A *required* computed column stays in the patch, since
it has no stored value to fall back on.

The one exception is a `@version` column. It is defaulted, so it is omitted on
insert, but it is written on update because it carries the optimistic-lock
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
  so its value is left to the trigger or rollup that fills it
  (`docs/validation.md`).
- **A defaulted column is written only when the caller supplies it.** A create
  that omits one sends the `default` keyword, so the database fills that row; a
  patch that omits one keeps the stored value. The clock fields are the different
  case: `createdAt` and `updatedAt` are excluded from `insert` and `update`
  outright, so writing one takes raw SQL. A `@version` column is excluded from
  `insert` too, though it *is* written on update.
- **`update` does not check the version itself.** The `@version` column is sent
  as an ordinary value; the conflict check and the increment are in a database
  trigger. A stale row makes the update raise rather than silently skip. See
  `docs/versioning.md`.
- **A patch cannot set a column to null.** `coalesce` cannot tell an omitted
  field from one set to `null`, so a null value reads as "not supplied" and the
  stored value is kept. Clearing a nullable column — `Invoice.customerId` is the
  one in this model — takes raw SQL or a sentinel value.
- **A patch is all-or-nothing per column, not per field-set.** Every patchable
  column appears in the statement, so a patch that supplies one field still
  writes the others back to their stored value. That is a no-op per column, but
  it means the written columns are not a signal of what the caller intended.
- **`delete` keys on the primary key only.** `deleteCustomer` takes
  `CustomerPrimaryKey[]` and has no patch variant and no version precondition.
- **No transaction wrapping.** A multi-row statement is atomic on its own, but
  anything spanning more than one call needs a boundary the caller opens:
  `SqlExecutor` carries `transaction`, and a repository still does not call it
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
