# Tasks

The root `package.json` is private and delegates; it owns no source. Its scripts
are the entry points for the whole workspace.

## The pipeline

```
pnpm run check
```

runs, in order:

1. `pnpm run lint` — the linters. Today that is `lint:spec`, which validates the
   `@` annotations in `packages/spec/`.
2. `pnpm run generate` — `generate:schema`, `generate:repositories`,
   `generate:queries`, `generate:validation`, `generate:rest-api`, and
   `generate:rest-client` in `packages/backend`.
3. `pnpm run build` — `pnpm -r --if-present run build`, so every package that
   defines a `build` runs it, in dependency order.

Step 3 is a no-op today: no package emits. `packages/spec` is consumed as `.ts`
through its `exports` map, and `packages/backend` is `noEmit` because `node` runs
its TypeScript directly. The step exists so that adding a `build` script to any
package joins the pipeline without touching the root.

## Ordering

The order is load-bearing:

- **Lint before generate.** The linter is the authority on whether an annotation
  is well formed. Running it first fails fast on a tag the generator would
  otherwise only report as a diagnostic, and it validates the whole spec rather
  than the subset the generators read.
- **Generate before build.** Generated `.sql` and repository modules are
  committed artifacts; anything that compiles or checks them must run after they
  are written, or it validates the previous generation.
- **Build last.** It is the only step that consumes the generated output as
  input.

`pnpm run generate` runs the schema generator before the repository generator,
then the query generator, the validation generator, and the two REST generators
last. All of them read the
spec through `packages/spec/scripts/spec-model.ts`: the backend maps it to columns
in `packages/backend/scripts/postgres-model.ts`, the query generator reads the
`@queryfilter` annotations, and the validation generator maps it to Zod schemas in
`packages/backend/scripts/zod-model.ts`. The REST pair shares
`packages/backend/scripts/rest-model.ts`, and the API generator references the
validation schemas by name, which is why it runs after them. None reads another's
output, so the
order between them is presentational — it mirrors the order the artifacts appear
in the repository.

## Why `--if-present`

`pnpm -r run build` errors with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` when no
selected package defines `build`, which would fail the pipeline before a build
exists. `--if-present` makes the step opt-in per package: a package without a
`build` is skipped, and a package that gains one is included automatically.

## Deliberately not included

- **`typecheck` and `test`.** They are their own scripts and are not part of
  `check`, so the pipeline stays the lint → generate → build sequence it is named
  for. The full pre-merge sequence composes them explicitly:

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
- **Adding a linter** means wiring it into `lint`. Only the spec package has one
  today, so `lint` is a single delegation rather than a recursive fan-out.
