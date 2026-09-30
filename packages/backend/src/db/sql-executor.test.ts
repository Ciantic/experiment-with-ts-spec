/** Checks that the driver the repositories run against satisfies SqlExecutor. */
import { describe, expect, it } from "vitest";
import { createPglite } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";

describe("SqlExecutor", () => {
    it("is satisfied by a PGlite instance", async () => {
        const executor: SqlExecutor = createPglite();

        await expect(executor.query("select 1 as value")).resolves.toBeDefined();
    });
});
