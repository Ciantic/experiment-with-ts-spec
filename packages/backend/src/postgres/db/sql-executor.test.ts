/** Checks that the driver the repositories run against satisfies SqlExecutor. */
import { describe, expect, it } from "vitest";
import { createPglite } from "../pglite-setup.js";
import type { RowExecutor, SqlExecutor } from "./sql-executor.js";

describe("SqlExecutor", () => {
    it("is satisfied by a PGlite instance", async () => {
        const executor: SqlExecutor = createPglite();

        await expect(executor.query("select 1 as value")).resolves.toBeDefined();
    });
});

describe("RowExecutor", () => {
    it("is satisfied by a PGlite instance, whose results carry rows", async () => {
        const executor: RowExecutor = createPglite();

        const result = await executor.query("select 1 as value");

        expect(result.rows).toEqual([{ value: 1 }]);
    });
});
