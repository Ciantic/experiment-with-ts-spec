# Testing

Tests cover the functionality of the code under test. They do not encode
domain-specific behaviour.

## The rule

A test should assert what a unit does, using its own inputs, not what the
domain currently happens to contain. Concretely:

- Unit tests build their own fixtures in memory and do not read
  `packages/spec/src`.
- Tests assert on the unit's contract (mapping, ordering, diagnostics), not on
  the business meaning of a particular field.
- A change to the domain model should not require rewriting a unit test.

## Why

The domain is a moving target: entities, fields, and aggregates change. A test
that asserted "a widget with two rows totals X" would have been rewritten every
time a type changed, and would have taught nothing about the generator.
Fixture-driven tests survive all of it.

The same reasoning removed a behavioural suite that exercised trigger semantics
against PGlite: it hardcoded rounding examples, trigger ordering, and the status
values, all of which are domain decisions rather than code behaviour.

## How it looks here

- `scripts/infra/generate-postgres-schema.test.ts` — drives
  `generateSchema` with self-contained fixtures, parsed by `parseInMemorySpec`
  from the sources the test writes, so it never has to touch the real spec.
  Its trigger group also executes the generated triggers in PGlite over
  `Parent`/`ChildA`/`ChildB` fixtures, asserting which child drives which parent
  column: the SQL text cannot show a trigger attached to the wrong table, because
  that trigger is still valid and still runs.
- `scripts/sdk/generate-zod-schemas.test.ts` — drives the schema
  mapper with in-memory spec fixtures and evaluates the emitted `primitives.ts`
  against Zod, so no assertion depends on the real domain.
- `scripts/sdk/rest-model.test.ts` — drives `buildRestModel` with
  in-memory fixtures, asserting the paths, operation ids, filters, and exposed
  operations both REST generators render.
- `scripts/sdk/generate-rest-client.test.ts` — drives the client
  renderer with fixtures and asserts the invariant that makes it worth
  generating: the emitted modules import `spec`, the type-only schema types, and
  their own modules, and nothing else.
- `scripts/sdk/errors.test.ts` — the shared error contract:
  `apiErrorBody` names the wire kind, `apiErrorFromBody` rebuilds every kind with
  the response's status, and an unknown kind or an unclassified body stays
  undefined. The class list is a fixture, so a new kind is added there once.
- `packages/sdk/src/http.test.ts` — a non-2xx response with a known kind becomes
  that class with its path and issues, one with no kind or an unknown kind stays
  an `HttpError`, and `client.test.ts` asserts the group path survives the
  rebuild.
- `packages/sdk/src/index.test.ts` — walks the package entry's relative imports
  and asserts it reaches only the transport and the error contract, so a schema
  module added to the entry fails the test instead of pulling `zod` into the
  client runtime.
- `scripts/infra/generate-entity-routes.test.ts` — drives the entity route
  renderer with fixtures.
- `scripts/backend/generate-operation-routes.test.ts` — drives the operation
  route renderer and the combined table with fixtures, and drives the client
  renderer from the same model to assert both expose exactly the same calls, so
  the pair cannot drift.
- `scripts/infra/generate-repositories.test.ts` — drives the repository
  renderer with table fixtures built by hand, so it exercises no ts-morph and no
  domain. A second group transpiles the generated module, builds a matching
  `create table` from the fixture's column metadata, and runs create/upsert/
  update/delete against PGlite. It asserts the generated SQL *executes*, not what
  the data means.
- `scripts/spec/spec-model.ts` — its `tsLoadGeneratedModule` and
  `tsStubImports` are test support the generator suites share: they transpile a
  module of generated TypeScript to CommonJS and run it with the imports the test
  names standing in for its own, so an unstubbed runtime import fails the test
  instead of loading a real module. The compiler lives in this one file and
  nowhere else, which leaves every generator test free of ts-morph.
- `packages/infra/src/db/sql-executor.test.ts` — drives `createExecutor` over a
  real PGlite, so a driver's boundary semantics are observable: a commit, a
  rollback, and that a nested boundary is a savepoint the outer transaction
  survives. A recording fake driver pins the other half: the checkout brackets the
  boundary and is released exactly once.
- `packages/infra/src/postgres/pglite-setup.test.ts` — PGlite as a
  `PgliteSqlDriver`: a boundary holds the one connection until it ends, a plain
  statement waits for it, and a failure frees the turn. It also checks the write
  count, the DDL batch, and shutdown.
- `packages/infra/src/postgres/pg-setup.test.ts` — `PgSqlDriver` builds the driver
  over `pg`'s mapped `Pool`, and a checked-out `PoolClient` fits `SqlSession`. It also
  asserts the mapping `createPgMapperTypes` installs — `int8` to `bigint`, `date`/`timestamp`/
  `numeric` to strings, `bytea` to `Uint8Array`, a text array to its raw
  elements, and an unmapped type left to the driver. No Postgres server is in the
  loop: constructing a `Pool` opens no connection.
- `packages/infra/src/db/group.test.ts` — drives `batch`, `transaction`, and
  `attempt` against a real PGlite over a `widget` table it creates itself. It
  asserts boundary behaviour — a failed `transaction` leaves nothing behind, a
  nested one is a savepoint the outer transaction survives, a tolerated one does
  not poison its enclosing boundary — naming no domain type and no route. What
  only this can assert is that the steps really receive the boundary handle. A
  second group turns on PGlite's own logging and asserts the statements the
  driver is asked to run: `batch` opens no boundary, `transaction` and `attempt`
  bracket their steps with `BEGIN`/`COMMIT` or `BEGIN`/`ROLLBACK`, and a nested
  one shows as a `SAVEPOINT` that is released, or rolled back to before it is
  released. Each step's insert is in the trace too, so the order reads as the
  rows land. That log is the only place the driver's own statements are visible,
  which is why the assertions read it rather than the rows.
- `packages/infra/src/http/group-handler.test.ts` — drives `handleGroup` with
  fixture routes, resolved by operation id, and an executor double that records
  the boundaries a tree opens and the modes each was opened with. It asserts the
  wire contract — every call is validated before any of them runs, a body that is
  not a group is a 400 naming the entry at fault, and so is a mode the boundary
  cannot open with — and the composition: a `transaction` opens one boundary, a
  nested one a savepoint, and an `attempt` one it may roll back without taking
  the outer group down.
- `packages/infra/src/postgres/schema.test.ts` — one check: the generated SQL
  executes. Nothing about what the tables mean.
- `packages/backend/src/main.test.ts` — the end-to-end smoke test: the generated
  client, the generated route table, and a live server. It takes the rows a seeded
  server answers with from `spec/mockdata`, and names no domain type, so a change
  to the model does not touch it.
- `{operation}.spec.test.ts` in `packages/backend/src/operations/` — the tests the
  spec declares for an operation, over fixtures the test builds in memory: the
  rows a call writes, and that an input missing any one of the fields it needs is
  refused with nothing written.
- `{operation}.test.ts` beside it — the behaviour the spec does not declare, over
  a schema seeded from `spec/mockdata`, so a call runs on the rows a development
  server holds. It asserts the values the operation snapshots onto the written
  row, the value it resolves when the caller omits it, and that a refused second
  write leaves the first rolled back.
- `scripts/backend/generate-spec-tests.test.ts` — drives the spec-test
  scaffolder with in-memory fixtures and a temp directory: the describe blocks
  it groups the rows into, the drift it reports for a file whose tests differ
  from the spec's, and the write/keep/prune decisions, including the read-only
  `--check`.
- `scripts/spec/lint-spec.test.ts` — linter rules, with fixture source
  strings. The one exception is a case asserting the committed spec passes lint,
  which is about the linter's real-world input rather than the domain's content.
- `scripts/oxlint/errors.test.ts` — the two error-contract rules, with fixture
  source strings: a documented throw passes, a missing or reasonless `@throws`
  fails, and a plain `Error` fails. It runs through Oxlint's own `RuleTester`, so
  the rule is exercised by the engine that will apply it.

## Gotchas

- **Do not import the real spec into a unit test.** Give the test its own sources
  through `parseInMemorySpec(files, { sourceGlob })`, so the model holds
  only what the test wrote, or the test becomes a domain test by accident. The
  end-to-end smoke test in `src/main.test.ts` is no exception: it draws its rows
  from `spec/mockdata` and names no domain type. An operation test is the
  exception: an operation is hand-written code over particular entities, so it
  seeds `spec/mockdata` and asserts what the operation writes.
- **Name the real file extension in imports.** `node` runs the TypeScript
  directly and resolves only `.ts` specifiers; `allowImportingTsExtensions` lets
  TypeScript accept them, and Vitest resolves them too.
- **Tag placement matters in fixtures.** JSDoc on the same line as a field is not
  attached to the node. Inline `/** @unique */ f: string;` is silently ignored;
  it must be its own line.
- **Generator output stays out of a test run.** A generator's `run` takes its
  `output` channels as a third argument, so a suite passes a silent sink
  alongside `--out` and asserts on the exit code. A test that checks what a run
  reports passes recording channels instead of spying on the console.

## Deliberately not implemented

- **Behavioural tests beyond the trigger wiring.** Nothing asserts that a trigger
  computes the right value, that a constraint rejects a bad status, or that a
  field's expression means what its name says. Those are domain assertions and
  would be rewritten with the model. The trigger check above is the exception
  because it pins the table-to-column mapping, which is code behaviour. The
  consequence is real and accepted: a semantically wrong but valid trigger passes
  every test.
- **A drift test for `packages/infra/src/postgres/schema.sql`.** Staleness is caught by running
  `pnpm generate:schema`, not by a test.

Both are worth adding once the model settles and the domain stops moving.
