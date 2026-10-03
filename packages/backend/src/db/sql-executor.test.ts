/** Checks that the driver satisfies its port, and that the port nests with savepoints. */
import { describe, expect, it } from "vitest";
import { createPglite } from "../postgres/pglite-setup.ts";
import type { Db, SqlExecutor } from "./sql-executor.ts";
import { createTransactionalDb, type TransactionalConnection } from "./transaction.ts";

/** A fresh database with one table, and the `Db` port over it. */
async function fixture(): Promise<{ db: Db; close: () => Promise<void> }> {
    const driver = createPglite();
    await driver.query("create table widget (id text primary key)");
    return { db: createTransactionalDb(driver), close: () => driver.close() };
}

/** The ids stored, in order. */
async function ids(db: SqlExecutor): Promise<unknown[]> {
    const result = (await db.query("select id from widget order by id")) as { rows: { id: string }[] };
    return result.rows.map((row) => row.id);
}

describe("SqlExecutor", () => {
    it("is satisfied by a PGlite instance", async () => {
        const executor: SqlExecutor = createPglite();

        await expect(executor.query("select 1 as value")).resolves.toBeDefined();
    });
});

describe("TransactionalConnection", () => {
    it("is satisfied by a PGlite instance, which is what the port is built on", async () => {
        const connection: TransactionalConnection = createPglite();

        const value = await connection.transaction(async (tx) => {
            await tx.query("select 1 as value");
            return "done";
        });

        expect(value).toBe("done");
    });
});

describe("createTransactionalDb", () => {
    it("commits a transaction", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await tx.query("insert into widget (id) values ($1)", ["a"]);
        });

        expect(await ids(db)).toEqual(["a"]);
        await close();
    });

    it("rolls back a transaction when the callback throws", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transaction(async (tx) => {
                await tx.query("insert into widget (id) values ($1)", ["a"]);
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("rolls back only the nested boundary, leaving the outer one to commit", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await tx.query("insert into widget (id) values ($1)", ["outer"]);
            await expect(
                tx.transaction(async (inner) => {
                    await inner.query("insert into widget (id) values ($1)", ["inner"]);
                    throw new Error("inner boom");
                }),
            ).rejects.toThrow("inner boom");
            await tx.query("insert into widget (id) values ($1)", ["after"]);
        });

        expect(await ids(db)).toEqual(["after", "outer"]);
        await close();
    });

    it("leaves the outer boundary usable after a nested failure", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await tx.query("insert into widget (id) values ($1)", ["taken"]);
            // A real constraint failure aborts the whole transaction as `25P02`; only
            // rolling back to the savepoint makes the outer boundary usable again.
            await expect(
                tx.transaction(async (inner) => {
                    await inner.query("insert into widget (id) values ($1)", ["taken"]);
                }),
            ).rejects.toThrow();
            await tx.query("insert into widget (id) values ($1)", ["recovered"]);
        });

        expect(await ids(db)).toEqual(["recovered", "taken"]);
        await close();
    });

    it("rolls the nested boundary back with the outer one when the outer fails", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transaction(async (tx) => {
                await tx.query("insert into widget (id) values ($1)", ["outer"]);
                await tx.transaction(async (inner) => {
                    await inner.query("insert into widget (id) values ($1)", ["inner"]);
                });
                throw new Error("outer boom");
            }),
        ).rejects.toThrow("outer boom");

        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("nests three deep, and an inner boundary rolls back on its own", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await tx.query("insert into widget (id) values ($1)", ["one"]);
            await tx.transaction(async (second) => {
                await second.query("insert into widget (id) values ($1)", ["two"]);
                await expect(
                    second.transaction(async (third) => {
                        await third.query("insert into widget (id) values ($1)", ["three"]);
                        throw new Error("third boom");
                    }),
                ).rejects.toThrow("third boom");
            });
        });

        expect(await ids(db)).toEqual(["one", "two"]);
        await close();
    });

    it("gives each savepoint its own name, so a sibling boundary is unaffected", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await expect(
                tx.transaction(async (first) => {
                    await first.query("insert into widget (id) values ($1)", ["first"]);
                    throw new Error("first boom");
                }),
            ).rejects.toThrow("first boom");
            await tx.transaction(async (second) => {
                await second.query("insert into widget (id) values ($1)", ["second"]);
            });
        });

        expect(await ids(db)).toEqual(["second"]);
        await close();
    });
});
