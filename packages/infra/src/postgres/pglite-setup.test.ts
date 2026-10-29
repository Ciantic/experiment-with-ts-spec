/** Asserts that a PGlite instance reaches the pool port, which is what the boundaries run on. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createPglite, createPglitePool } from "./pglite-setup.ts";

describe("createPglitePool", () => {
    it("takes statements to a checkout, and hands the connection on when released", async () => {
        const driver = createPglite();
        const pool = createPglitePool(driver);

        const session = await pool.connect();
        await session.query("select 'x' as value");
        session.release();

        await expect(pool.query("select 'x' as value")).resolves.toMatchObject({ rows: [{ value: "x" }] });
        await driver.close();
    });

    it("holds the one connection until the checkout is released", async () => {
        const driver = createPglite();
        const pool = createPglitePool(driver);
        const order: string[] = [];

        const held = await pool.connect();
        const waiting = pool.query("select 1").then(() => {
            order.push("query ran");
        });
        order.push("query waiting");
        held.release();
        await waiting;

        expect(order).toEqual(["query waiting", "query ran"]);
        await driver.close();
    });
});
