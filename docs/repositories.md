# Repositories

`packages/backend/scripts/generate-repositories.ts` writes one CRUD module per
domain entity into `packages/backend/src/postgres/db/repositories/`.

- `pnpm generate:repositories` — writes the repository modules and their barrel.
- `pnpm generate:repositories --out <dir>` — writes elsewhere. A missing directory is created.

The output is committed. Regenerate rather than editing it by hand.

## What a repository is here

Each module exports three functions for its entity:

```ts
createCustomer(db: SqlExecutor, rows: Customer[]): Promise<void>
updateCustomer(db: SqlExecutor, rows: CustomerPatch[]): Promise<void>
deleteCustomer(db: SqlExecutor, rows: Customer[]): Promise<void>
```

`create` and `delete` take a whole entity. `update` takes a **patch**, so a
caller changes the fields it has without having to read and resend the rest;
see "Patching" below.

Every function takes an array and returns nothing. **Reading is not part of a
repository.** There is no `getById`, no list, no query builder. Those belong to
whatever reads the data — a projection, a report, a view — and are deliberately
not generated, because their shape is a product decision rather than a mapping
of the spec. Hand-written read contracts live in `packages/spec/src/queries/`;
see `docs/queries.md`.

`SqlExecutor` (`src/postgres/db/sql-executor.ts`) is the whole database surface:
`query(sql, parameters?)`. Both PGlite and `pg` satisfy it, so the generated
modules never import a driver, and `pg` stays an optional dependency. A test
asserts that PGlite actually satisfies the interface, so the structural type
cannot drift away from the driver.

## Why arrays

A repository that takes one row per call forces one round trip per row. Taking
an array lets the generator emit a single multi-row statement, which is the
whole reason the functions exist in this shape:

- **create** — `insert into "t" (...) values ($1, ...), ($n, ...)`.
- **update** — `update "t" set ... from (values (...), (...)) as data(...) where "t"."id" = data."id"`.
- **delete** — `delete from "t" using (values (...), (...)) as data("id") where "t"."id" = data."id"`.

Each function returns early on an empty array, so the caller does not have to
guard.

## Patching

`update` takes a patch rather than a whole entity. The generator emits one type
per module:

```ts
export type CustomerPatch = Partial<Customer> & Required<Pick<Customer, "id" | "version">>;
```

Every column is optional except two, which are the keys the rest of the design
leans on:

- **The primary key** says which row to write.
- **The `@version` column**, where one exists, is the optimistic-lock
  precondition (`docs/versioning.md`). It is required so a patch cannot
  accidentally skip the check. For an entity with no version — the snapshots —
  only the key is required.

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

## Where the columns come from

The generator does not read `schema.sql` and does not re-parse the spec: it
consumes the same table model as the schema generator, from
`packages/backend/scripts/postgres-model.ts`, which maps the parsed spec
(`packages/spec/scripts/spec-model.ts`) to columns. One interpretation of
`@table`, `@relation`, `@children`, `@inlined`, `<Entity>Id` foreign keys, and
type mapping feeds both the DDL and the repositories, so a repository cannot
name a column the schema does not have.

The column value is read through the accessor recorded on the model, so an
inlined optional customer is written as `row.customer?.id`, and a relation field
as `row.customer?.id`, without the generator special-casing either.

A column with a database default (`@default`) is left to the database and never
appears in a generated `insert`. That covers both timestamps: the default fills
`createdAt` and `updatedAt` on insert, and the trigger refreshes `updatedAt` on
every write; see `docs/timestamps.md`.

The one exception is a `@version` column. It is defaulted, so it is omitted on
insert, but it is written on update because it carries the optimistic-lock
precondition the trigger checks. The generator therefore builds the insert and
patch column sets separately; see `docs/versioning.md`.

## Gotchas

- **Foreign keys have no `ON DELETE` clause**, so `deleteInvoice` fails while
  rows still reference it. Deleting children is the caller's job; there is no
  cascade.
- **Computed columns without a default are supplied like any other.** The insert
  sends them, then the before-trigger overwrites them. Passing a value is
  required (the columns are `not null` with no default) but has no effect.
- **A defaulted column is never written.** Both timestamps have database defaults
  and are excluded from `insert` and `update`, so the generated functions cannot
  set them even deliberately. Writing one takes raw SQL. A `@version` column is
  the exception: it is defaulted but *is* written on update.
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
- **`delete` keys on the primary key only.** `deleteCustomer` has no patch
  variant and no version precondition.
- **No transaction wrapping.** A multi-row statement is atomic on its own, but
  the caller owns anything spanning more than one call.

## Deliberately not implemented

- **Queries.** Hand-written read contracts live in `packages/spec/src/queries/`,
  not in a repository; see `docs/queries.md`.
- **Upsert and full-row replacement.** `update` is a patch; there is no "write
  exactly this object" variant, and no insert-or-update.
- **Cascade delete** for `@children`. A child table's foreign key has no
  `ON DELETE`, so a parent with children cannot be deleted.
- **Batching across repositories.** No unit of work; each call is one statement.
- **A drift test.** Like `schema.sql`, staleness is caught by running
  `pnpm generate:repositories`, not by a test.
