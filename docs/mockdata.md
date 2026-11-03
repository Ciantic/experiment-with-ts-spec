# Mock data

`packages/spec/mockdata/` holds one sample array per domain entity, typed
against the real spec. It is the seed a development server starts from, so the
client has something to read without a fixture being written per test.

- `packages/spec/mockdata/<name>.ts` — one entity's row array, named after the
  array it exports (`widgets.ts` exports `widgets`).
- `packages/spec/mockdata/index.ts` — the barrel, plus `mockTables`, the
  ordered list of `{ entity, rows }`.
- `packages/infra/src/mock/seed.ts` — `seedMockData(db)`.
- `packages/backend/src/main.pglite.ts` — the development server entry, seeded by default (`--no-mock` turns it off).

The `mockTables` are ordered so foreign keys resolve: the tenancy root every row
belongs to, then the entities it references, then children after their parents,
then snapshots after the rows they copy. Tables that reference nothing sit at
the end, where their position cannot matter. `seedMockData` walks the list in
that order.

## Seeding is generic

`seedMockData` does not name a domain type. For each entry it calls the
generated repository whose name is `create<Entity>`, looked up on the
`repositories` barrel. A new entity joins the seed by adding a row array to
`packages/spec/mockdata/` and an entry to `mockTables` — no backend change.

Because the rows are typed as the spec's own interfaces, a domain change breaks
the mock data at compile time instead of seeding a database the server disagrees
with. A row must also satisfy the constraints it is inserted under: its
`tenantId` has to match the tenant of every row it points at, since a scoped
foreign key refuses a pair that does not exist (`docs/tenancy.md`). Computed
values — a parent's aggregates and a child's amounts — are left
out, because their fields are optional and the triggers fill them. The
`createdAt`, `updatedAt`, and `version` values are declared and stored as
written: the generated insert carries them, so a sample row seeds the instant
and revision it names. An `@pgAutoIncrement` key is the exception: it is
declared, but the identity sequence assigns the stored value, not the row
(`docs/auto-increment.md`). See `docs/optionality.md`.

## Running the server

```
pnpm --filter backend run example:server --port 4123
```

`node src/main.pglite.ts` also works. The PGlite entry applies the schema and
seeds by default; flags:

- `--port <n>` — the listen port. Default `3000`; `0` picks a free one.
- `--no-schema` — skip applying the generated schema.
- `--no-mock` — skip inserting the mock data before serving.
- `--schema` and `--seed` — the `pg` entry's opt-in flags; `pg` applies the
  schema and inserts the mock data only when they are given.
- `--log-sql` — let PGlite print every statement it runs, the `BEGIN`, `COMMIT`,
  and `ROLLBACK` it issues around a transaction included. PGlite's own startup
  and server logs come with it, so the output is verbose.
- `--database-url <url>` — the connection string the `pg` entry passes to the
  pool; `DATABASE_URL` is the fallback. The PGlite entry ignores it.
- `--data-dir <path>` — keep PGlite's database in that directory instead of
  memory, so a seeded run survives a restart. The `pg` entry ignores it.

The PGlite entry builds an in-memory driver and serves over it, with the schema
applied and the mock data seeded by default; the `pg` entry builds one over
`DATABASE_URL` and runs against the empty generated schema unless given
`--schema` and `--seed` (`docs/entrypoints.md`).

## The mock data test

`packages/backend/src/mockdata.test.ts` seeds every `mockTables` entry into an
in-memory PGlite and reads each table back through its generated
`query<Entity>`. It asserts each comes back with the number of rows that were
seeded.

The test is deliberately generic: it reads `mockTables` and the generated query
functions rather than naming an entity, so a domain change does not rewrite it.
It covers the seed and the read path over the real schema; the HTTP surface,
generated client, and server are out of scope.
