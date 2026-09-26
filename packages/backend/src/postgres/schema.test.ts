/** Sanity check that the committed src/postgres/schema.sql is valid SQL. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteParsers } from "./pglite-setup.js";

const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

describe("src/postgres/schema.sql", () => {
    it("executes in Postgres", async () => {
        const db = new PGlite({ parsers: createPgliteParsers() });

        await expect(db.exec(sql)).resolves.toBeDefined();
    });
});
