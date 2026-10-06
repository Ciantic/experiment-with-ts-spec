/** Checks that the port nests with savepoints, over a real driver. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createPglite, createPglitePool } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { affectedRows, createTransactionalDb } from "./sql-executor.ts";
import type { SqlPool } from "./sql-pool.ts";

/** A fresh database with one table, and the `SqlExecutor` port over it. */
async function fixture(): Promise<{ db: SqlExecutor; close: () => Promise<void> }> {
    const driver = createPglite();
    await driver.query("create table widget (id text primary key)");
    return { db: createTransactionalDb(createPglitePool(driver)), close: () => driver.close() };
}

/** The ids stored, in order. */
async function ids(db: SqlExecutor): Promise<unknown[]> {
    const result = (await db.query("select id from widget order by id")) as { rows: { id: string }[] };
    return result.rows.map((row) => row.id);
}

describe("affectedRows", () => {
    it("reads the count each driver names", () => {
        expect(affectedRows({ affectedRows: 1 })).toBe(1);
        expect(affectedRows({ rowCount: 0 })).toBe(0);
        // A zero count is a real answer, so it must not fall through to the other name.
        expect(affectedRows({ affectedRows: 0, rowCount: 7 })).toBe(0);
    });

    it("throws on a result that carries neither count, rather than reading as a conflict", () => {
        expect(() => affectedRows({ rows: [] })).toThrow("the executor did not return an affected-row count");
        expect(() => affectedRows({ rowCount: null })).toThrow();
        expect(() => affectedRows(undefined)).toThrow();
        expect(() => affectedRows(null)).toThrow();
    });

    it("counts the rows of a statement over a real driver", async () => {
        const driver = createPglite();
        await driver.query("create table widget (id text primary key)");
        await driver.query("insert into widget (id) values ('a'), ('b')");

        const updated = await driver.query("update widget set id = 'a' where id = 'a'");
        const matchedNothing = await driver.query("update widget set id = 'x' where id = 'gone'");

        expect(affectedRows(updated)).toBe(1);
        expect(affectedRows(matchedNothing)).toBe(0);
        await driver.close();
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

/** A pool that records the statements and the release, so the bracketing around a checkout is observable. */
function fakePool(): { pool: SqlPool; statements: string[]; releases: () => number } {
    const statements: string[] = [];
    let releases = 0;
    const record = async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
    };
    return {
        pool: {
            query: record,
            connect: async () => ({
                query: record,
                release: () => {
                    releases += 1;
                },
            }),
        },
        statements,
        releases: () => releases,
    };
}

describe("the checkout a boundary runs on", () => {
    it("brackets one checked-out session with begin and commit, releasing it once", async () => {
        const { pool, statements, releases } = fakePool();

        await createTransactionalDb(pool).transaction(async (tx) => {
            await tx.query("write");
        });

        expect(statements).toEqual(["begin", "write", "commit"]);
        expect(releases()).toBe(1);
    });

    it("rolls back and releases the session when the callback throws", async () => {
        const { pool, statements, releases } = fakePool();

        await expect(
            createTransactionalDb(pool).transaction(async (tx) => {
                await tx.query("write");
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        expect(statements).toEqual(["begin", "write", "rollback"]);
        expect(releases()).toBe(1);
    });

    it("keeps the nesting on that one session, releasing it once", async () => {
        const { pool, statements, releases } = fakePool();

        await createTransactionalDb(pool).transaction(async (tx) => {
            await tx.query("outer");
            await tx.transaction(async (inner) => {
                await inner.query("inner");
            });
        });

        expect(statements).toEqual([
            "begin",
            "outer",
            "savepoint sp_1",
            "inner",
            "release savepoint sp_1",
            "commit",
        ]);
        expect(releases()).toBe(1);
    });
});
