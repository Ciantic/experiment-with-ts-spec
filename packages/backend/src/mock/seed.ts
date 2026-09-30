/** Seed a database from the spec's mock data. See docs/mockdata.md. */
import * as repositories from "../db/repositories/index.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { mockTables } from "spec/mockdata/index.ts";

/** A generated repository create function, matched to a mock table by entity name. */
type Create = (db: SqlExecutor, rows: unknown[]) => Promise<void>;

/** Insert every mock table in the order the spec lists it, so foreign keys resolve. */
export async function seedMockData(db: SqlExecutor): Promise<void> {
    const creators = repositories as unknown as Record<string, Create | undefined>;
    for (const { entity, rows } of mockTables) {
        const create = creators[`create${entity}`];
        if (create === undefined) {
            throw new Error(`mock data names entity "${entity}" with no create${entity} repository`);
        }
        await create(db, rows);
    }
}
