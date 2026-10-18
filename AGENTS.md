# Architecture

- `packages/spec/` — TypeScript interfaces that form the definition of the
  application.
- `packages/sdk/` — generated type-safe REST client, the generated Zod schemas
  and shared Patch/Insert/read types, the shared API error classes, and the
  hand-written transport and package entry. Consumed by the backend and,
  eventually, the frontend. Owns the generator that writes the schemas.
- `packages/backend/` — Postgres schema, generated repositories, and result
  mapping for the spec.

## Scripts

- `scripts/*` must never be tightly coupled to spec domain names. Read what you
  need from an annotation on the spec (e.g. `@pgType`) via a generic helper in
  `packages/spec/scripts/spec-model.ts`. A new domain type must not require
  editing a generator. We should invent more annotations if need be.
- Only `packages/spec/scripts/spec-model.ts` reads the spec through ts-morph. A
  generator, its model, and the linter read the parsed `SpecModel` — including
  each field's `SpecType`, `location`, and tags — and never walk a syntax tree
  themselves.
- A generator lives in the package that owns its artifact: the schema,
  repository, and query generators in `packages/backend/scripts` because they
  share the table model, the Zod and REST client generators in
  `packages/sdk/scripts` because they write the SDK.
- Each generator exports `run(spec, argv)`, so the root `scripts/generate.ts` can
  load the spec once and pass the same `SpecModel` to every step. That driver
  owns no artifact and holds no domain knowledge; it lints first, then orders
  the generators.

## Code style

- Only single-line comments in code. If you need more than one line of
  explanation, put it in `docs/` instead and leave a one-line pointer where the
  code needs it. `pnpm lint` enforces this (`docs/comments.md`).
- Errors are `AppError` subclasses from `packages/sdk/src/errors.ts`, the one
  contract the backend and the client share; only errors that never reach the
  wire stay in the backend (`docs/errors.md`). Every `throw new X` documents
  `@throws {X} why` on an enclosing function, and `pnpm lint` enforces it.

## Docs

- One topic per file in `docs/`, named for the concept (`queries.md`,
  `versioning.md`), each with a single `# Title`. There is no index;
  `docs/spec-annotations.md` is the entry point, since the tags are the contract
  every generator reads.
- Write about the design as it is. A note explains how the system works, not how
  it came to: no "this replaced X", no "previously", no record of an approach
  that was rejected. Git history is where change is recorded.

## Testing

- Tests cover the functionality of the code under test, not domain-specific
  features. Build fixtures in memory; do not read `packages/spec/src`
  from a unit test. A domain change must not require rewriting a test. See
  `docs/testing.md`.

## Specs

- An interface is an entity when it carries `@entity`, and a type alias is a
  primitive when it carries `@primitive`; a directory never decides what is
  generated, so an entity may live anywhere under `packages/spec/src/`. See
  `docs/spec-annotations.md`.
- Specs are in the `packages/spec`, currently they are only for demonstration.
  This means generators should not be tightly coupled with any particular spec.