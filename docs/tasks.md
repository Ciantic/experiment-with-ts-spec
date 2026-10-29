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
   then writes every generated artifact: `generate:operations`,
   `generate:operation-routes`, and `generate:spec-tests` under
   `packages/backend`; `generate:schema`, `generate:repositories`,
   `generate:queries`, and `generate:entity-routes` under `packages/infra`; and
   `generate:errors` and `generate:validation` under `packages/sdk`. The
   generators run from `scripts/`, but each artifact belongs to its package.
2. `pnpm run build` — `pnpm -r --if-present run build`, so every package that
   defines a `build` runs it, in dependency order.

Step 2 is a no-op today: no package emits. `packages/spec` is consumed as `.ts`
through its `exports` map, and `packages/infra` and `packages/backend` are
`noEmit` because `node` runs their TypeScript directly. The step exists so that
adding a `build` script to any package joins the pipeline without touching the
root.

## Ordering

The order is load-bearing:

- **Lint before generate.** The linter is the authority on whether an annotation
  is well formed, so it is the first step of `scripts/generate.ts`. A finding
  stops the run before a generator writes an artifact from a spec it rejects,
  and it validates the whole spec rather than the subset the generators read.
- **Generate before build.** Generated `.sql`, repository modules, and the
  `packages/sdk` schemas are committed artifacts; anything that compiles
  or checks them must run after they
  are written, or it validates the previous generation.
- **Build last.** It is the only step that consumes the generated output as
  input.

`pnpm run generate` lints first, then writes the operation errors and scaffolds
the operation modules, then runs the schema generator before the repository
generator, then the query generator, the validation generator, and the two REST
generators last. Errors go before operations because an operation's scaffold
documents the classes its `@throws` tags declare. Operations go before the REST
pair because the generated route imports the module the scaffold writes. The driver parses the
spec once through
`scripts/spec/spec-model.ts` and hands the same `SpecModel` to every
step, because that parse dominates a generate run; each generator keeps a
standalone `generate:*` script for a single artifact, and `pnpm run lint` runs
the spec linter plus the generators' read-only `--check` passes. All of them read the
spec through that same model: the schema, repository, and
query generators map it to columns in
`scripts/infra/postgres-model.ts`, the validation generator maps it to
Zod schemas in `scripts/sdk/zod-model.ts`, and the REST pair maps
it to the HTTP surface in `scripts/sdk/rest-model.ts`. The error
generator reads the `@throws` tags and writes `specErrors.ts`; the operations
generator reads the parsed `@operation` methods and writes only the modules that
do not exist yet. See `docs/errors.md` and `docs/operations.md`. The route
generators reference the validation schemas by name, which is why they run after
them. None reads another's
output, so the
order between them is presentational — it mirrors the order the artifacts appear
in the repository. A step that reports a finding or a diagnostic returns a
failing exit code, and the driver stops rather than running the steps after it.

A generator lives under `scripts/<package>`, named for the package whose
artifact it writes. The schema, repository, query, and entity-route generators
are in `scripts/infra`, because they share `postgres-model.ts` or the REST model
and write infra's own tables, modules, and servable route table. The operation,
spec-test, and operation-route generators are in `scripts/backend`, beside the
implementation they wire. The Zod generator and the REST client
generator are in `scripts/sdk`, with the client artifact they render and, for
the REST pair, the `rest-model.ts` both read; the route generators import that
model rather than owning a second copy. The drift check drives every route
generator, so it stays in `scripts/backend` beside the table that joins them.
`scripts/paths.ts` derives each package root, so an output path never depends on
the cwd.

## Adding a generator

A generator module exports `run(spec, argv, output): number`, which reads the
model, writes its artifact, and returns the process exit code. Its own
`if (import.meta.main)` block calls `run(loadSpec(), process.argv)`, so the
root `generate:*` script still works standalone and still accepts its flags.
`output` is the two channels a run reports on, `Pick<Console, "log" | "error">`,
and defaults to the console; a caller that supplies its own takes over the
reporting, so a silent sink leaves the exit code as the whole report. Each
generator declares that type itself, since it is the console's shape with a
narrower minimum. A generator's own artifact flags are unaffected: the schema's
`--stdout` still prints the SQL. Adding one to the pipeline is two lines in
`scripts/generate.ts`: the import and the position in the driver's list. The
driver passes no `argv`, so a generator's flags never reach the whole-pipeline
run.

The generators are siblings under `scripts/`, so the driver imports them by
relative path, and no package exposes them through its `exports` map.

The linter is a step in that same list, so it shares the parse with the
generators. The driver stops at its first finding.

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
  list, since `check` reaches a linter through `pnpm run generate`. `lint`
  composes the spec linter and the generators' `--check` passes rather than
  fanning out through the workspace.
