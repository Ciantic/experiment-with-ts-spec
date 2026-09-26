# Architecture

- `packages/spec/` — TypeScript interfaces that form the definition of the application.
- `packages/backend/` — Postgres schema, generated repositories, and result mapping for the spec.

# Code style

- Only single-line comments in code. If you need more than one line of
  explanation, put it in `docs/` instead and leave a one-line pointer where the
  code needs it.

# Testing

- Tests cover the functionality of the code under test, not domain-specific
  features. Build fixtures in memory; do not read `packages/spec/src/domain` from a unit test.
  A domain change must not require rewriting a test. See `docs/testing.md`.
