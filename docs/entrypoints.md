# Entry points

A process picks its database once, in the module the command line launches.
`packages/backend/src/serve.ts` holds what does not depend on that pick:
`startServer(driver, options)` builds the app context over a `SqlDriver`, applies
the generated schema and seeds the mock data when asked, and listens;
`parseServerArgs` reads the command line with `node:util`'s `parseArgs`:
`--port <n>`, `--seed` (alias `--mock`), `--log-sql`, `--database-url <url>`, and
`--data-dir <path>`. Reading the command line returns a result rather than
throwing: a malformed one is a message the entry prints before setting exit
status `1`. The entries export nothing: each parses, builds its driver, starts,
and prints the port. A test that needs the same server imports `startServer` and
builds its own driver, as `mockdata.test.ts` does, rather than importing an
entry that would start one.

Two modules make the pick, and each imports one driver:

- `packages/backend/src/main.pg.ts` — `PgSqlDriver` over `pg`'s pool, with
  `--database-url` (falling back to `DATABASE_URL`) as the connection string.
  `pg` is a runtime dependency, so this is the production entry.
- `packages/backend/src/main.pglite.ts` — `PgliteSqlDriver` over an in-memory
  PGlite, unless `--data-dir` names a directory to persist to; it logs
  statements when `--log-sql` is present. PGlite is a development dependency, so
  this is the development and test entry.

Neither setup module in `infra` imports its library at runtime: each takes the
module as a constructor argument and names it by type otherwise. A bundle
carries `pg` only when it is built from `main.pg.ts`, and PGlite only from
`main.pglite.ts`, with no bundler rule keeping them apart.

## Two bundles

The entries are separate inputs, not one module that branches:

```ts
// vite.config.ts
export default defineConfig({
    build: {
        ssr: true,
        target: "node22",
        rollupOptions: {
            input: {
                pg: "src/main.pg.ts",
                pglite: "src/main.pglite.ts",
            },
        },
    },
});
```

An SSR build externalises what is in `node_modules` and bundles the linked
workspace packages, so shared code lands in chunks both entries import, while
`pg` and `@electric-sql/pglite` stay runtime dependencies of their own bundle.

`applySchema` reads `schema.sql` through `import.meta.url`, so a bundle that
also contains `infra` no longer finds it. Either list the workspace packages in
`ssr.external` and let `infra` stay in `node_modules` beside its DDL, or copy
`schema.sql` into the output at the path the emitted module resolves.
