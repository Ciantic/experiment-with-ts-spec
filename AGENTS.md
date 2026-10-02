# Architecture

- `packages/spec/` — TypeScript interfaces that form the definition of the
  application.
- `packages/validation/` — generated Zod schemas and the shared Patch/Insert
  types, consumed by the backend, the SDK, and eventually the frontend. Owns the
  generator that writes them.
- `packages/backend/` — Postgres schema, generated repositories, and result
  mapping for the spec.
- `packages/sdk/` — generated type-safe REST client, plus the hand-written
  transport.

# Scripts

- `scripts/*` must never be tightly coupled to spec domain names. Read what you
  need from an annotation on the spec (e.g. `@pgtype`) or a generic helper in
  `packages/spec/scripts/spec-model.ts`. A new domain type must not require
  editing a generator. We should invent more annotations if need be.
- A generator lives in the package that owns its artifact. Most of them are in
  `packages/backend/scripts` because they share the table model;
  `packages/validation/scripts` owns the Zod generator.

# Code style

- Only single-line comments in code. If you need more than one line of
  explanation, put it in `docs/` instead and leave a one-line pointer where the
  code needs it.

# Docs

- One topic per file in `docs/`, named for the concept (`queries.md`,
  `versioning.md`), each with a single `# Title`. There is no index;
  `docs/spec-annotations.md` is the entry point, since the tags are the contract
  every generator reads.
- Write about the design as it is. A note explains how the system works, not how
  it came to: no "this replaced X", no "previously", no record of an approach
  that was rejected. Git history is where change is recorded.

# Testing

- Tests cover the functionality of the code under test, not domain-specific
  features. Build fixtures in memory; do not read `packages/spec/src/domain`
  from a unit test. A domain change must not require rewriting a test. See
  `docs/testing.md`.
