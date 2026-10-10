# Tasks

The root `package.json` is private and delegates. Its scripts are the entry
points for the whole workspace, and `scripts/generate.ts` is the one source it
owns: the driver that lints the spec and then runs every generator.

## The pipeline

```
pnpm run check
```

runs, in order:

1. `pnpm run generate` — `node scripts/generate.ts`, which lints the spec and
   then writes every generated artifact: `generate:schema`,
   `generate:repositories`, `generate:queries`, `generate:rest-api`, and
   `generate:rest-client` in `packages/backend`, plus `generate:validation` in
   `packages/validation`, which owns the generator for its own schemas.
2. `pnpm run build` — `pnpm -r --if-present run build`, so every package that
   defines a `build` runs it, in dependency order.

Step 2 is a no-op today: no package emits. `packages/spec` is consumed as `.ts`
through its `exports` map, and `packages/backend` is `noEmit` because `node` runs
its TypeScript directly. The step exists so that adding a `build` script to any
package joins the pipeline without touching the root.

## Ordering

The order is load-bearing:

- **Lint before generate.** The linter is the authority on whether an annotation
  is well formed, so it is the first step of `scripts/generate.ts`. A finding
  stops the run before a generator writes an artifact from a spec it rejects,
  and it validates the whole spec rather than the subset the generators read.
- **Generate before build.** Generated `.sql`, repository modules, and the
  `packages/validation` schemas are committed artifacts; anything that compiles
  or checks them must run after they
  are written, or it validates the previous generation.
- **Build last.** It is the only step that consumes the generated output as
  input.

`pnpm run generate` lints first, then runs the schema generator before the
repository generator, then the query generator, the validation generator, and the
two REST generators last. The driver parses the
spec once through
`packages/spec/scripts/spec-model.ts` and hands the same `SpecModel` to every
step, because that parse dominates a generate run; each generator keeps a
standalone `generate:*` script for a single artifact, and `pnpm run lint` runs
the linter alone. All of them read the
spec through that same model: the schema, repository, and
query generators map it to columns in
`packages/backend/scripts/postgres-model.ts`, the validation generator maps it to
Zod schemas in `packages/validation/scripts/zod-model.ts`, and the REST pair maps
it to the HTTP surface in `packages/backend/scripts/rest-model.ts`. The API
generator references the validation schemas by name, which is why it runs after
them. None reads another's
output, so the
order between them is presentational — it mirrors the order the artifacts appear
in the repository. A step that reports a finding or a diagnostic returns a
failing exit code, and the driver stops rather than running the steps after it.

The validation generator is the one that lives in the package it writes. The
other generators stay in `packages/backend/scripts`: the schema, repository, and
query generators share the table model, and the two REST generators share
`rest-model.ts`. The REST client generator draws only on the spec and that model,
yet it stays with the API generator so the two cannot drift; its output still
lands in `packages/sdk`.

## Adding a generator

A generator module exports `run(spec, argv): number`, which reads the model,
writes its artifact, and returns the process exit code. Its own
`if (import.meta.main)` block calls `run(loadSpec(), process.argv)`, so the
package script still works standalone and still accepts its flags. Adding one to
the pipeline is two lines in `scripts/generate.ts`: the import and the position
in the driver's list. The driver passes no `argv`, so a generator's flags never
reach the whole-pipeline run.

The driver is the only consumer of another package's generator, so `backend` and
`validation` do not export `scripts/`: it imports those two by relative path.
`spec` keeps its `scripts/` export, because the driver and the generators in both
of those packages read `spec/scripts/spec-model.ts` through it.

The linter is a step in that same list, so it shares the parse and no longer
needs a separate entry point in `check`. It takes no argv, and the driver stops
at its first finding.

## Why `--if-present`

`pnpm -r run build` errors with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` when no
selected package defines `build`, which would fail the pipeline before a build
exists. `--if-present` makes the step opt-in per package: a package without a
`build` is skipped, and a package that gains one is included automatically.

## Deliberately not included

- **`typecheck` and `test`.** They are their own scripts and are not part of
  `check`, so the pipeline stays the lint, generate, and build sequence it is
  named for. The full pre-merge sequence composes them explicitly:

  ```
  pnpm install && pnpm run check && pnpm run typecheck && pnpm test
  ```

- **A drift check.** `check` rewrites the generated artifacts but does not verify
  that the committed ones matched. Like `schema.sql`, staleness is caught by
  running the generator, not by a test — see `docs/schema-generation.md` and
  `docs/repositories.md`.
- **`clean`.** Nothing is emitted, so there is nothing to remove.
- **Publishing.** Every package is `private`.

## Gotchas

- **`check` writes files.** It regenerates the committed `.sql` and repository
  modules, so running it can leave a dirty working tree. That is the point: the
  generator is the source of those artifacts, not the editor.
- **A no-op build is not a failed build.** Step 3 succeeding while nothing is
  emitted is expected, not a sign the step is misconfigured.
- **`pnpm run build` is recursive, the others are not.** `lint` and `generate`
  target specific packages by name; `build` fans out to all of them.
- **Adding a linter** means wiring it into `lint` and into the driver's step
  list, since `check` reaches a linter through `pnpm run generate`. Only the spec
  package has one today, so `lint` is a single delegation rather than a recursive
  fan-out.
