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
  `{ specGlob, formulasFile }` precisely so a test never has to touch the real spec.
- `packages/backend/postgres/schema.test.ts` — one check: the generated SQL
  executes. Nothing about what the tables mean.
- `packages/spec/scripts/lint-spec.test.ts` — linter rules, with fixture source
  strings. The one exception is a case asserting the committed spec passes lint,
  which is about the linter's real-world input rather than the domain's content.

## Gotchas

- **Do not import the real spec into a unit test.** Use an in-memory project with
  a fixture glob, or the test becomes a domain test by accident.
- **Node cannot resolve `.js` specifiers to `.ts`.** Scripts run by plain `node`
  must read `packages/spec/` with ts-morph instead of importing it. Vitest resolves `.js`
  to `.ts` fine, so this only affects the scripts.
- **Tag placement matters in fixtures.** JSDoc on the same line as a field is not
  attached to the node. Inline `/** @unique */ f: string;` is silently ignored;
  it must be its own line.

## Deliberately not implemented

- **Behavioural tests.** Nothing asserts that a trigger computes the right value,
  that rollups fire on delete, or that a constraint rejects a bad status. Those
  are domain assertions and would be rewritten with the model. The consequence is
  real and accepted: a semantically wrong but valid trigger passes every test.
- **A drift test for `packages/backend/postgres/schema.sql`.** Staleness is caught by running
  `pnpm generate:schema`, not by a test.

Both are worth adding once the model settles and the domain stops moving.
