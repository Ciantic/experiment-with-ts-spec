/** Asserts that a PGlite driver reaches the pool port, which is what the boundaries run on. See docs/transactions.md. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPgliteDriver } from "./pglite-setup.ts";

describe("createPgliteDriver", () => {
    it("takes statements to a checkout, and hands the connection on when released", async () => {
        const driver = createPgliteDriver(PGlite);
        const session = await driver.connect();
        await session.query("select 'x' as value");
        session.release();

        await expect(driver.query("select 'x' as value")).resolves.toMatchObject({ rows: [{ value: "x" }] });
        await driver.close();
    });

    it("holds the one connection until the checkout is released", async () => {
        const driver = createPgliteDriver(PGlite);
        const order: string[] = [];

        const held = await driver.connect();
        const waiting = driver.query("select 1").then(() => {
            order.push("query ran");
        });
        order.push("query waiting");
        held.release();
        await waiting;

        expect(order).toEqual(["query waiting", "query ran"]);
        await driver.close();
    });
});
