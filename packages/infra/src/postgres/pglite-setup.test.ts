/** Asserts that a PGlite driver serialises its one connection behind the checkouts a boundary takes. See docs/transactions.md. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PgliteSqlDriver } from "./pglite-setup.ts";

/** Let every already-scheduled microtask run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PgliteSqlDriver", () => {
    it("takes statements to a checkout, and hands the connection on when released", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        const session = await driver.connect();
        await session.query("select 'x' as value");
        session.release();

        await expect(driver.query("select 'x' as value")).resolves.toMatchObject({ rows: [{ value: "x" }] });
        await driver.close();
    });

    it("holds the one connection until the checkout is released", async () => {
        const driver = new PgliteSqlDriver(PGlite);
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

    it("hands the turn on once, so a double release does not let a second taker through", async () => {
        const driver = new PgliteSqlDriver(PGlite);

        const first = await driver.connect();
        let secondTaken = false;
        let thirdTaken = false;
        const second = driver.connect().then((session) => {
            secondTaken = true;
            return session;
        });
        const third = driver.connect().then((session) => {
            thirdTaken = true;
            return session;
        });

        first.release();
        first.release();

        const secondSession = await second;
        await settle();
        expect(secondTaken).toBe(true);
        expect(thirdTaken).toBe(false);

        secondSession.release();
        const thirdSession = await third;
        expect(thirdTaken).toBe(true);
        thirdSession.release();
        await driver.close();
    });

    it("frees the turn when a statement throws", async () => {
        const driver = new PgliteSqlDriver(PGlite);

        await expect(driver.query("select * from no_such_table")).rejects.toThrow();
        await expect(driver.query("select 1 as one")).resolves.toMatchObject({ rows: [{ one: 1 }] });

        await driver.close();
    });

    it("answers the write count, with a select reporting zero", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        await driver.exec("create table widget (id text primary key)");

        await expect(driver.query("insert into widget (id) values ('a'), ('b')")).resolves.toMatchObject({
            affectedRows: 2,
        });
        await expect(driver.query("select id from widget")).resolves.toMatchObject({ rows: [{ id: "a" }, { id: "b" }], affectedRows: 0 });

        await driver.close();
    });

    it("runs the DDL batch, and shuts the connection down", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        await driver.exec("create table widget (id text primary key)");
        await driver.query("insert into widget (id) values ('a')");

        await expect(driver.query("select id from widget")).resolves.toMatchObject({ rows: [{ id: "a" }] });

        await driver.close();
        await expect(driver.query("select 1")).rejects.toThrow();
    });
});
