/** Checks that the port nests with savepoints, over a real driver. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createPglite, createPglitePool } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { affectedRows, createTransactionalDb, resultRows, setTransaction } from "./sql-executor.ts";
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

describe("resultRows", () => {
    it("reads the rows a result carries, empty ones included", () => {
        expect(resultRows({ rows: [{ id: "a" }] })).toEqual([{ id: "a" }]);
        expect(resultRows({ rows: [] })).toEqual([]);
    });

    it("throws on a result that carries no rows, rather than reading as a statement that wrote none", () => {
        expect(() => resultRows({ affectedRows: 1 })).toThrow("the executor did not return rows");
        expect(() => resultRows(undefined)).toThrow();
        expect(() => resultRows(null)).toThrow();
    });

    it("reads the rows a statement returned over a real driver", async () => {
        const driver = createPglite();
        await driver.query("create table widget (id text primary key)");
        await driver.query("insert into widget (id) values ('a'), ('b')");

        const updated = await driver.query("update widget set id = id where id = 'a' returning id");
        const matchedNothing = await driver.query("update widget set id = id where id = 'gone' returning id");

        expect(resultRows(updated)).toEqual([{ id: "a" }]);
        expect(resultRows(matchedNothing)).toEqual([]);
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

describe("setTransaction", () => {
    /** A boundary that records the statements, so the one `set transaction` it carries is observable. */
    async function boundary(run: (tx: SqlExecutor) => Promise<void>): Promise<string[]> {
        const { pool, statements } = fakePool();
        await createTransactionalDb(pool).transaction(run);
        return statements;
    }

    it("writes the modes it was given as one statement", async () => {
        const statements = await boundary((tx) =>
            setTransaction(tx, { isolationLevel: "repeatable read", accessMode: "read only", deferrable: true }),
        );

        expect(statements).toEqual([
            "begin",
            "set transaction isolation level repeatable read, read only, deferrable",
            "commit",
        ]);
    });

    it("writes the modes in the same order whatever order they were given in", async () => {
        const statements = await boundary((tx) => setTransaction(tx, { deferrable: false, accessMode: "read write" }));

        expect(statements).toEqual(["begin", "set transaction read write, not deferrable", "commit"]);
    });

    it("imports a snapshot on its own, as the command takes a literal for it", async () => {
        const statements = await boundary(async (tx) => {
            await setTransaction(tx, { isolationLevel: "repeatable read" });
            await setTransaction(tx, { snapshot: "00000003-0000001B-1" });
        });

        expect(statements).toEqual([
            "begin",
            "set transaction isolation level repeatable read",
            "set transaction snapshot '00000003-0000001B-1'",
            "commit",
        ]);
    });

    it("refuses the shapes of the command it cannot write, rather than sending a broken one", async () => {
        const { db, close } = await fixture();

        await expect(setTransaction(db, {})).rejects.toThrow("at least one mode");
        await expect(setTransaction(db, { snapshot: "00000003-0000001B-1", accessMode: "read only" })).rejects.toThrow(
            "a snapshot is the only mode",
        );
        await expect(setTransaction(db, { snapshot: "0'; drop table widget; --" })).rejects.toThrow(
            "no quote and no backslash",
        );
        await expect(setTransaction(db, { snapshot: "0\\'" })).rejects.toThrow("no quote and no backslash");
        await close();
    });

    it("sets the isolation level of the boundary it is given, over a real driver", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await setTransaction(tx, { isolationLevel: "serializable" });
            expect(resultRows(await tx.query("show transaction_isolation"))).toEqual([
                { transaction_isolation: "serializable" },
            ]);
        });
        // The mode belongs to the boundary, so the next statement is back at the session default.
        expect(resultRows(await db.query("show transaction_isolation"))).toEqual([
            { transaction_isolation: "read committed" },
        ]);
        await close();
    });

    it("makes a read-only boundary refuse a write, over a real driver", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transaction(async (tx) => {
                await setTransaction(tx, { accessMode: "read only" });
                await tx.query("insert into widget (id) values ($1)", ["a"]);
            }),
        ).rejects.toThrow("read-only transaction");

        expect(await ids(db)).toEqual([]);
        await close();
    });
});
