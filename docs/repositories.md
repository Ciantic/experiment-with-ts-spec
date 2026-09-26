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
updateCustomer(db: SqlExecutor, rows: Customer[]): Promise<void>
deleteCustomer(db: SqlExecutor, rows: Customer[]): Promise<void>
```

Every function takes an array and returns nothing. **Reading is not part of a
repository.** There is no `getById`, no list, no query builder. Those belong to
whatever reads the data — a projection, a report, a view — and are deliberately
not generated, because their shape is a product decision rather than a mapping
of the spec.

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

The `update` sets every non-key column. A table whose only column is the primary
key sets the key to itself, so the statement is still valid.

## Where the columns come from

The generator does not read `schema.sql` and does not re-parse the spec: it
consumes the same table model as the schema generator, from
`packages/backend/scripts/spec-model.ts`. One interpretation of `@table`,
`@relation`, `@children`, `@inlined`, `<Entity>Id` foreign keys, and type
mapping feeds both the DDL and the repositories, so a repository cannot name a
column the schema does not have.

The column value is read through the accessor recorded on the model, so an
inlined optional customer is written as `row.customer?.id`, and a relation field
as `row.customer?.id`, without the generator special-casing either.

A column with a database default (`@default`) is left to the database and never
appears in a generated `insert` or `update`. That covers both timestamps: the
default fills `createdAt` and `updatedAt` on insert, and the trigger refreshes
`updatedAt` on every write; see `docs/timestamps.md`.

## Gotchas

- **Foreign keys have no `ON DELETE` clause**, so `deleteInvoice` fails while
  rows still reference it. Deleting children is the caller's job; there is no
  cascade.
- **Computed columns without a default are supplied like any other.** The insert
  sends them, then the before-trigger overwrites them. Passing a value is
  required (the columns are `not null` with no default) but has no effect.
- **A defaulted column is never written.** Both timestamps have database defaults
  and are excluded from `insert` and `update`, so the generated functions cannot
  set them even deliberately. Writing one takes raw SQL.
- **`delete` and `update` key on the primary key only.** A primary-key-only
  `update` is a no-op write; it exists because the function must set something.
- **No transaction wrapping.** A multi-row statement is atomic on its own, but
  the caller owns anything spanning more than one call.

## Deliberately not implemented

- **Queries.** See above.
- **Upsert, partial updates, and patches.** `update` always writes every column.
- **Cascade delete** for `@children`. A child table's foreign key has no
  `ON DELETE`, so a parent with children cannot be deleted.
- **Batching across repositories.** No unit of work; each call is one statement.
- **A drift test.** Like `schema.sql`, staleness is caught by running
  `pnpm generate:repositories`, not by a test.
