/** Applying the generated DDL. See docs/schema-generation.md. */
import { readFileSync } from "node:fs";
import type { SqlDriver } from "../db/sql-driver.ts";

/** The generated DDL, next to this module. */
const SCHEMA_URL = new URL("./schema.sql", import.meta.url);

/** Apply the generated DDL over a driver, which startup does once before serving. */
export async function applySchema(driver: SqlDriver): Promise<void> {
    await driver.exec(readFileSync(SCHEMA_URL, "utf8"));
}
