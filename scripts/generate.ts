/** Lint the spec, then run every generator from one parse; this driver only orders the steps. See docs/spec-annotations.md. */
import { loadSpec, type SpecModel } from "./spec/spec-model.ts";
import { run as runLint } from "./spec/lint-spec.ts";
import { run as runPostgresSchema } from "./infra/generate-postgres-schema.ts";
import { run as runRepositories } from "./infra/generate-repositories.ts";
import { run as runQueries } from "./infra/generate-queries.ts";
import { run as runEntityRoutes } from "./infra/generate-entity-routes.ts";
import { run as runOperations } from "./backend/generate-operations.ts";
import { run as runSpecTests } from "./backend/generate-spec-tests.ts";
import { run as runOperationRoutes } from "./backend/generate-operation-routes.ts";
import { run as runRestClient } from "./sdk/generate-rest-client.ts";
import { run as runValidation } from "./sdk/generate-zod-schemas.ts";
import { run as runErrors } from "./sdk/generate-errors.ts";
import { run as runMermaidSpec } from "./spec/generate-mermaid-spec.ts";

/** One step of the run: read the spec, do its job, and report the exit code. */
type Step = (spec: SpecModel, argv: readonly string[]) => number;

// loadSpec parses ts-morph, which dominates a generate run, so every step reads one model.
const spec = loadSpec();

// The linter goes first: it is the authority on a well-formed tag, so it gates every writer.
const steps: Step[] = [
    runLint,
    runErrors,
    runOperations,
    runSpecTests,
    runPostgresSchema,
    runRepositories,
    runQueries,
    runValidation,
    runEntityRoutes,
    runOperationRoutes,
    runRestClient,
    runMermaidSpec,
];

for (const step of steps) {
    // No argv: the flags each script takes are for a standalone run, not the whole pipeline.
    const code = step(spec, []);
    if (code !== 0) {
        process.exitCode = code;
        break;
    }
}
