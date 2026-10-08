/**
 * Lint the spec, then run every generator from that one parse. See docs/spec-annotations.md.
 * A single generator lives in the package that owns its artifact; this driver only orders them.
 */
import { run as runPostgresSchema } from "backend/scripts/generate-postgres-schema.ts";
import { run as runRepositories } from "backend/scripts/generate-repositories.ts";
import { run as runQueries } from "backend/scripts/generate-queries.ts";
import { run as runRestApi } from "backend/scripts/generate-rest-api.ts";
import { run as runRestClient } from "backend/scripts/generate-rest-client.ts";
import { run as runLint } from "spec/scripts/lint-spec.ts";
import { loadSpec, type SpecModel } from "spec/scripts/spec-model.ts";
import { run as runValidation } from "validation/scripts/generate-zod-schemas.ts";

/** One step of the run: read the spec, do its job, and report the exit code. */
type Step = (spec: SpecModel, argv: readonly string[]) => number;

// loadSpec parses ts-morph, which dominates a generate run, so every step reads one model.
const spec = loadSpec();

// The linter goes first: it is the authority on a well-formed tag, so it gates every writer.
const steps: Step[] = [
    runLint,
    runPostgresSchema,
    runRepositories,
    runQueries,
    runValidation,
    runRestApi,
    runRestClient,
];

for (const step of steps) {
    // No argv: the flags each script takes are for a standalone run, not the whole pipeline.
    const code = step(spec, []);
    if (code !== 0) {
        process.exitCode = code;
        break;
    }
}
