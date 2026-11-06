# Entry points

A process picks its database once, in the module the command line launches.
Each entry has its own command line module, with no shared code between them.
`parseServerArgs(argv)` in that module reads the command line with
`node:util`'s `parseArgs`; the module's own `DEFAULT_PORT` is the port a run
listens on when `--port` is absent, and `HELP` is the usage text a help request
prints. Reading the command line is self-contained: a malformed one is a message
`parseServerArgs` prints to stderr before exiting with status `1`, a help
request prints `HELP` and exits `0`, and anything else returns the options with
the flags layered over the module's defaults. Each flag a driver does not take is
rejected as unknown. The PGlite entry defaults the schema and the seed on, so the
development server applies the schema and seeds unless `--no-schema` or
`--no-mock` says otherwise. The entries export nothing: each parses, builds its driver,
applies the generated schema and seeds the mock data when its options say so,
starts the server, and prints the port.

Two modules make the pick, and each imports one driver and its own parser:

- `packages/backend/src/main.pg.ts` with `args.pg.ts` — `PgSqlDriver` over
  `pg`'s pool, with `--database-url` (falling back to `DATABASE_URL`) as the
  connection string; flags are `--port`, `--schema`, `--seed`, `--database-url`,
  and `--help`. `pg` is a runtime dependency, so this is the production entry.
- `packages/backend/src/main.pglite.ts` with `args.pglite.ts` —
  `PgliteSqlDriver` over an in-memory PGlite, unless `--data-dir` names a
  directory to persist to; it logs statements when `--log-sql` is present;
  flags are `--port`, `--no-schema`, `--no-mock`, `--log-sql`, `--data-dir`, and
  `--help`. PGlite is a development dependency, so this is the development and
  test entry.

Neither setup module in `infra` imports its library at runtime: each takes the
module as a constructor argument and names it by type otherwise. A bundle
carries `pg` only when it is built from `main.pg.ts`, and PGlite only from
`main.pglite.ts`, with no bundler rule keeping them apart.

## Two bundles

`packages/backend/vite.config.ts` maps `--mode pg` and `--mode pglite` to one
entry each, and `pnpm --filter backend build` runs both in turn:

- `dist.pg/main.pg.js` from `main.pg.ts`
- `dist.pglite/main.pglite.js` from `main.pglite.ts`

The build bundles every dependency (`ssr.noExternal`) and turns code splitting
off, so each entry is one JavaScript file. Node builtins stay external.

`applySchema` reads `schema.sql` through `import.meta.url`, so a bundle that
also contains `infra` would no longer find it; the config replaces that read
with the DDL text, and both bundles carry the schema inside the script.

PGlite reads `pglite.wasm`, `initdb.wasm`, and `pglite.data` from its own
directory instead. The `pglite` bundle copies those three beside the entry under
the names PGlite asks for, because it loads the wasm as a module and maps the
data file into memory: base64 copies would hide that cost inside the script.

