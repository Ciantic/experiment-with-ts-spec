/** Checks that the port nests with savepoints, over a real driver. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDriver } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { createTransactionalDb } from "./sql-executor.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** A fresh database with one table, and the `SqlExecutor` port over it. */
async function fixture(): Promise<{ db: SqlExecutor; close: () => Promise<void> }> {
    const driver = createPgliteDriver(PGlite);
    await driver.query("create table widget (id text primary key)");
    return { db: createTransactionalDb(driver), close: () => driver.close() };
}

/** The ids stored, in order. */
async function ids(db: SqlExecutor): Promise<unknown[]> {
    const result = await db.query<{ id: string }>("select id from widget order by id");
    return result.rows.map((row) => row.id);
}

describe("query", () => {
    it("answers the rows a statement returned, empty ones included", async () => {
        const { db, close } = await fixture();
        await db.query("insert into widget (id) values ('a'), ('b')");

        const updated = await db.query<{ id: string }>("update widget set id = id where id = 'a' returning id");
        const matchedNothing = await db.query<{ id: string }>("update widget set id = id where id = 'gone' returning id");

        expect(updated).toEqual({ rows: [{ id: "a" }], affectedRows: 1 });
        expect(matchedNothing).toEqual({ rows: [], affectedRows: 0 });
        await close();
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
            // A real constraint failure aborts the whole transaction as `25P02`; only rolling back to the savepoint makes the outer boundary usable again.
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

/** A driver that records the statements and the release, so the bracketing around a checkout is observable. */
function fakeDriver(): { driver: SqlDriver; statements: string[]; releases: () => number } {
    const statements: string[] = [];
    let releases = 0;
    const record = async (sql: string) => {
        statements.push(sql);
        return { rows: [], affectedRows: 0 };
    };
    return {
        driver: {
            query: record,
            connect: async () => ({
                query: record,
                release: () => {
                    releases += 1;
                },
            }),
            exec: async () => undefined,
            close: async () => {},
        },
        statements,
        releases: () => releases,
    };
}

describe("the checkout a boundary runs on", () => {
    it("brackets one checked-out session with begin and commit, releasing it once", async () => {
        const { driver, statements, releases } = fakeDriver();

        await createTransactionalDb(driver).transaction(async (tx) => {
            await tx.query("write");
        });

        expect(statements).toEqual(["begin", "write", "commit"]);
        expect(releases()).toBe(1);
    });

    it("rolls back and releases the session when the callback throws", async () => {
        const { driver, statements, releases } = fakeDriver();

        await expect(
            createTransactionalDb(driver).transaction(async (tx) => {
                await tx.query("write");
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        expect(statements).toEqual(["begin", "write", "rollback"]);
        expect(releases()).toBe(1);
    });

    it("keeps the nesting on that one session, releasing it once", async () => {
        const { driver, statements, releases } = fakeDriver();

        await createTransactionalDb(driver).transaction(async (tx) => {
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

describe("the modes a boundary is opened with", () => {
    it("appends them to the begin that opens the root boundary, in the order Postgres reads them", async () => {
        const { driver, statements, releases } = fakeDriver();

        await createTransactionalDb(driver).transactionWith(
            { deferrable: true, accessMode: "read only", isolationLevel: "repeatable read" },
            async (tx) => {
                await tx.query("write");
            },
        );

        expect(statements).toEqual(["begin isolation level repeatable read, read only, deferrable", "write", "commit"]);
        expect(releases()).toBe(1);
    });

    it("spells a mode the call turns off as the negative the command takes", async () => {
        const { driver, statements } = fakeDriver();

        await createTransactionalDb(driver).transactionWith(
            { deferrable: false, accessMode: "read write" },
            async (tx) => {
                await tx.query("write");
            },
        );

        expect(statements).toEqual(["begin read write, not deferrable", "write", "commit"]);
    });

    it("opens a plain boundary when the call names no modes", async () => {
        const { driver, statements } = fakeDriver();

        await createTransactionalDb(driver).transactionWith({}, async (tx) => {
            await tx.query("write");
        });

        expect(statements).toEqual(["begin", "write", "commit"]);
    });

    it("refuses them on a nested boundary, which is a savepoint and takes none", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await expect(
                tx.transactionWith({ accessMode: "read only" }, async (inner) => {
                    await inner.query("select 1");
                }),
            ).rejects.toThrow("a nested boundary is a savepoint");
            await tx.query("insert into widget (id) values ($1)", ["after"]);
        });

        expect(await ids(db)).toEqual(["after"]);
        await close();
    });

    it("opens the boundary with the modes over a real driver, and they do not outlive it", async () => {
        const { db, close } = await fixture();

        await db.transactionWith({ isolationLevel: "serializable", accessMode: "read only" }, async (tx) => {
            expect((await tx.query("show transaction_isolation")).rows).toEqual([
                { transaction_isolation: "serializable" },
            ]);
            expect((await tx.query("show transaction_read_only")).rows).toEqual([
                { transaction_read_only: "on" },
            ]);
        });
        expect((await db.query("show transaction_isolation")).rows).toEqual([
            { transaction_isolation: "read committed" },
        ]);
        expect((await db.query("show transaction_read_only")).rows).toEqual([{ transaction_read_only: "off" }]);
        await close();
    });

    it("makes a read-only boundary refuse a write, over a real driver", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transactionWith({ accessMode: "read only" }, async (tx) => {
                await tx.query("insert into widget (id) values ($1)", ["a"]);
            }),
        ).rejects.toThrow("read-only transaction");

        expect(await ids(db)).toEqual([]);
        await close();
    });
});
