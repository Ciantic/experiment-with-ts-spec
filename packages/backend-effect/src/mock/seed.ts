/** Seed a database from the spec's mock data. See docs/mockdata.md. */
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as repositories from "../db/repositories/index.ts";
import { mockTables } from "spec/mockdata/index.ts";

/** A generated repository create function, matched to a mock table by entity name. */
type Create = (rows: unknown[]) => Effect.Effect<void, SqlError, SqlClient>;

/** Insert every mock table in the order the spec lists it, so foreign keys resolve. */
export const seedMockData: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(function* () {
    const creators = repositories as unknown as Record<string, Create | undefined>;
    for (const { entity, rows } of mockTables) {
        const create = creators[`create${entity}`];
        if (create === undefined) {
            // A mismatch between mock data and the generated repositories is a programming error.
            return yield* Effect.die(new Error(`mock data names entity "${entity}" with no create${entity} repository`));
        }
        yield* create(rows);
    }
});
