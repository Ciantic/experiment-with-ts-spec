/** Sanity check that the committed src/postgres/schema.sql applies. */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgliteSqlDriver } from "./pglite-setup.ts";
import { applySchema } from "./schema.ts";

describe("src/postgres/schema.sql", () => {
    it("executes in Postgres", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        try {
            await expect(applySchema(driver)).resolves.toBeUndefined();
        } finally {
            await driver.close();
        }
    });
});
