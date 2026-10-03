# Testing

Tests cover the functionality of the code under test. They do not encode
domain-specific behaviour.

## The rule

A test should assert what a unit does, using its own inputs, not what the
domain currently happens to contain. Concretely:

- Unit tests build their own fixtures in memory and do not read
  `packages/spec/src/domain`.
- Tests assert on the unit's contract (mapping, ordering, diagnostics), not on
  the business meaning of a particular field.
- A change to the domain model should not require rewriting a unit test.

## Why

The domain is a moving target. `Invoice`, `InvoiceRow`, and their fields have
changed repeatedly. A test that asserted "an invoice with two rows totals X"
would have been rewritten every time a type changed, and would have taught
nothing about the generator. Fixture-driven tests survived all of it.

The same reasoning removed a behavioural suite that exercised trigger semantics
against PGlite: it hardcoded rounding examples, trigger ordering, and the status
values, all of which are domain decisions rather than code behaviour.

## How it looks here

- `packages/backend/scripts/generate-postgres-schema.test.ts` — drives
  `generateSchema` with self-contained fixtures. `generateSchema` takes
  `{ specGlob, aliasGlob }` precisely so a test never has to touch the real spec.
- `packages/validation/scripts/generate-zod-schemas.test.ts` — drives the schema
  mapper with in-memory spec fixtures and evaluates the emitted `primitives.ts`
  against Zod, so no assertion depends on the real domain.
- `packages/backend/scripts/generate-repositories.test.ts` — drives the repository
  renderer with table fixtures built by hand, so it exercises no ts-morph and no
  domain. A second group transpiles the generated module, builds a matching
  `create table` from the fixture's column metadata, and runs create/update/delete
  against PGlite. It asserts the generated SQL *executes*, not what the data means.
- `packages/backend/src/db/sql-executor.test.ts` — asserts that PGlite satisfies
  the `SqlExecutor` interface the generated repositories accept, and the `Db`
  port the router takes. The second is what lets a group open a real
  transaction, so it asserts a commit, a rollback, and that a nested boundary is
  a savepoint the outer transaction survives.
- `packages/backend/src/db/group.test.ts` — drives `batch`, `transaction`, and
  `attempt` against a real PGlite over a `widget` table it creates itself. It
  asserts boundary behaviour — a failed `transaction` leaves nothing behind, a
  nested one is a savepoint the outer transaction survives, a tolerated one does
  not poison its enclosing boundary — naming no domain type and no route. What
  only this can assert is that the steps really receive the boundary handle.
- `packages/backend/src/postgres/schema.test.ts` — one check: the generated SQL
  executes. Nothing about what the tables mean.
- `packages/spec/scripts/lint-spec.test.ts` — linter rules, with fixture source
  strings. The one exception is a case asserting the committed spec passes lint,
  which is about the linter's real-world input rather than the domain's content.

## Gotchas

- **Do not import the real spec into a unit test.** Use an in-memory project with
  a fixture glob, or the test becomes a domain test by accident.
- **Name the real file extension in imports.** `node` runs the TypeScript
  directly and resolves only `.ts` specifiers; `allowImportingTsExtensions` lets
  TypeScript accept them, and Vitest resolves them too.
- **Tag placement matters in fixtures.** JSDoc on the same line as a field is not
  attached to the node. Inline `/** @unique */ f: string;` is silently ignored;
  it must be its own line.

## Deliberately not implemented

- **Behavioural tests.** Nothing asserts that a trigger computes the right value,
  that rollups fire on delete, or that a constraint rejects a bad status. Those
  are domain assertions and would be rewritten with the model. The consequence is
  real and accepted: a semantically wrong but valid trigger passes every test.
- **A drift test for `packages/backend/src/postgres/schema.sql`.** Staleness is caught by running
  `pnpm generate:schema`, not by a test.

Both are worth adding once the model settles and the domain stops moving.
