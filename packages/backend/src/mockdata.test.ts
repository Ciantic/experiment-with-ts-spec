/** The mock-data test: seed `spec/mockdata` and read every table back. See docs/mockdata.md. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import * as infra from "infra";
import { mockTables } from "spec/mockdata/index.ts";

/** A generated read, as this test sees it: a database and an unfiltered selection. */
type Query = (db: infra.SqlExecutor, opts: { select: object }) => Promise<unknown[]>;

describe("mock data", () => {
    let driver: infra.PgliteSqlDriver;
    let db: infra.SqlExecutor;

    beforeAll(async () => {
        driver = new infra.PgliteSqlDriver(PGlite);
        await infra.applySchema(driver);
        db = driver.createExecutor();
        await infra.seedMockData(db);
    });

    afterAll(async () => {
        await driver.close();
    });

    it("names at least one table, so the loop below is not vacuous", () => {
        expect(mockTables.length).toBeGreaterThan(0);
    });

    for (const { entity, rows } of mockTables) {
        it(`seeds ${entity}`, async () => {
            const query = (infra as unknown as Record<string, Query | undefined>)[`query${entity}`];
            expect(query, `query${entity} is generated`).toBeTypeOf("function");

            const stored = await query!(db, { select: {} });
            expect(stored, entity).toHaveLength(rows.length);
        });
    }
});
