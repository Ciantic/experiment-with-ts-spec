# Mock data

`packages/spec/mockdata/` holds one sample array per domain entity, typed
against the real spec. It is the seed a development server starts from, so the
client has something to read without a fixture being written per test.

- `packages/spec/mockdata/<name>.ts` — one entity's row array, named after the
  array it exports (`invoices.ts` exports `invoices`).
- `packages/spec/mockdata/index.ts` — the barrel, plus `mockTables`, the
  ordered list of `{ entity, rows }`.
- `packages/backend/src/mock/seed.ts` — `seedMockData(db)`.
- `packages/backend/src/main.ts` — the server entry, optionally seeded.

The `mockTables` are ordered so foreign keys resolve: customers and sellers, then
invoices and their rows, then sent invoices and their rows. Tables that reference
nothing — `Tenant`, `Translation`, and `AuditLog` — sit at the end, where their
position cannot matter. `seedMockData` walks the list in that order.

## Seeding is generic

`seedMockData` does not name a domain type. For each entry it calls the
generated repository whose name is `create<Entity>`, looked up on the
`repositories` barrel. A new entity joins the seed by adding a row array to
`packages/spec/mockdata/` and an entry to `mockTables` — no backend change.

Because the rows are typed as the spec's own interfaces, a domain change breaks
the mock data at compile time instead of seeding a database the server disagrees
with. Computed values — the invoice aggregates and the row amounts — are left
out, because their fields are optional and the triggers fill them. The
database-managed `createdAt`, `updatedAt`, and `version` are declared, since the
entity requires them, but the repository omits those columns on insert and the
defaults fill them. An `@pgAutoIncrement` key is declared the same way: the
identity sequence assigns the stored value, not the row
(`docs/auto-increment.md`). See `docs/optionality.md`.

## Running the server

```
pnpm --filter backend run example:server --port 4123 --seed
```

`node src/main.ts` also works. Flags:

- `--port <n>` — the listen port. Default `3000`; `0` picks a free one.
- `--seed` (alias `--mock`) — insert the mock data before serving.
- `--log-sql` — let PGlite print every statement it runs, the `BEGIN`, `COMMIT`,
  and `ROLLBACK` it issues around a transaction included. PGlite's own startup
  and server logs come with it, so the output is verbose.

Without `--seed` the server runs against the empty generated schema. The
database is an in-memory PGlite created fresh on every start.

## The client test

`packages/backend/src/main.test.ts` starts a seeded server on an ephemeral port
and drives it through the generated client from `packages/sdk`. It walks every
`mockTables` entry by calling `query<Entity>` and asserts each comes back with
the number of rows that were seeded.

The test is deliberately generic: it reads `mockTables` and the client barrel
rather than naming an entity, so a domain change does not rewrite it. It covers
the wire, not business meaning — that the router, the codec, the resolver, and
the generated client agree end to end.
