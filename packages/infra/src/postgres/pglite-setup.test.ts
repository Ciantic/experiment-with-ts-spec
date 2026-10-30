/** Asserts that a PGlite driver serialises its one connection behind the checkouts a boundary takes. See docs/transactions.md. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PgliteSqlDriver } from "./pglite-setup.ts";

/** Let every already-scheduled microtask run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PgliteSqlDriver", () => {
    it("runs a boundary on one checkout, and hands the connection on when it ends", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        const db = driver.createExecutor();

        await expect(db.transaction((tx) => tx.query("select 'x' as value"))).resolves.toMatchObject({
            rows: [{ value: "x" }],
        });
        await expect(db.query("select 'x' as value")).resolves.toMatchObject({ rows: [{ value: "x" }] });

        await driver.close();
    });

    it("holds the one connection until the boundary ends", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        const db = driver.createExecutor();
        const order: string[] = [];

        let open!: () => void;
        const held = new Promise<void>((resolve) => {
            open = resolve;
        });
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const boundary = db.transaction(async (tx) => {
            await tx.query("select 1");
            entered();
            await held;
        });
        await inside;

        const waiting = db.query("select 2").then(() => {
            order.push("query ran");
        });
        order.push("query waiting");
        await settle();
        expect(order).toEqual(["query waiting"]);

        open();
        await boundary;
        await waiting;

        expect(order).toEqual(["query waiting", "query ran"]);
        await driver.close();
    });

    it("frees the turn when a boundary throws", async () => {
        const driver = new PgliteSqlDriver(PGlite);
        const db = driver.createExecutor();

        await expect(db.transaction((tx) => tx.query("select * from no_such_table"))).rejects.toThrow();
        await expect(db.query("select 1 as one")).resolves.toMatchObject({ rows: [{ one: 1 }] });

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
