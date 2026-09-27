/** An in-memory database for the dev server, so GraphQL runs with no setup. See docs/graphql.md. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RowExecutor } from "../postgres/db/sql-executor.js";
import { createPglite } from "../postgres/pglite-setup.js";

/** The committed DDL, applied to a fresh in-memory database on startup. */
export const SCHEMA_PATH = join(import.meta.dirname, "../postgres/schema.sql");

/**
 * Open a PGlite instance with the committed schema applied. The tables are empty:
 * this is for exploring the schema and trying queries, not for seeded data.
 */
export async function createInMemoryDatabase(): Promise<RowExecutor> {
    const database = createPglite();
    await database.exec(readFileSync(SCHEMA_PATH, "utf8"));
    return database;
}
