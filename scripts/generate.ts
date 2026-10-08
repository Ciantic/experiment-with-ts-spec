/**
 * Run every generator from one spec parse. See docs/spec-annotations.md.
 * A single generator lives in the package that owns its artifact; this driver only orders them.
 */
import { run as runPostgresSchema } from "backend/scripts/generate-postgres-schema.ts";
import { run as runRepositories } from "backend/scripts/generate-repositories.ts";
import { run as runQueries } from "backend/scripts/generate-queries.ts";
import { run as runRestApi } from "backend/scripts/generate-rest-api.ts";
import { run as runRestClient } from "backend/scripts/generate-rest-client.ts";
import { loadSpec } from "spec/scripts/spec-model.ts";
import { run as runValidation } from "validation/scripts/generate-zod-schemas.ts";

// loadSpec parses ts-morph, which dominates a generate run, so all six generators read one model.
const spec = loadSpec();

const generators = [
    runPostgresSchema,
    runRepositories,
    runQueries,
    runValidation,
    runRestApi,
    runRestClient,
];

for (const run of generators) {
    // No argv: the flags each script takes are for a standalone run, not the whole pipeline.
    const code = run(spec, []);
    if (code !== 0) {
        process.exitCode = code;
        break;
    }
}
