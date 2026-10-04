/** Asserts that a PGlite instance reaches the port, which is what the group boundaries run on. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import type { DriverConnection } from "../db/sql-executor.ts";
import { createPglite } from "./pglite-setup.ts";

describe("createPglite", () => {
    it("satisfies DriverConnection, so the port can be built on it", async () => {
        const connection: DriverConnection = createPglite();

        const value = await connection.transaction(async (tx) => {
            await tx.query("select 1 as value");
            return "done";
        });

        expect(value).toBe("done");
    });
});
