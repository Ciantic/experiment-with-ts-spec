# Architecture

- `packages/spec/` — TypeScript interfaces that form the definition of the application.
- `packages/backend/` — Postgres schema, generated repositories, result mapping, and generated Zod schemas for the spec.
- `packages/backend-effect/` — Effect v4 port of the backend: generated code uses `effect/schema`, `effect/sql`, and `effect/http`. Parallel to `packages/backend` until it reaches parity, then it replaces it.
- `packages/sdk/` — generated type-safe REST client, plus the hand-written transport.

# Scripts

- `scripts/*` must never be tightly coupled to spec domain names. Read what you
  need from an annotation on the spec (e.g. `@pgtype`) or a generic helper in
  `packages/spec/scripts/spec-model.ts`. A new domain type must not require editing a
  generator. We should invent more annotations if need be.

# Code style

- Only single-line comments in code. If you need more than one line of
  explanation, put it in `docs/` instead and leave a one-line pointer where the
  code needs it.

# Testing

- Tests cover the functionality of the code under test, not domain-specific
  features. Build fixtures in memory; do not read `packages/spec/src/domain` from a unit test.
  A domain change must not require rewriting a test. See `docs/testing.md`.
