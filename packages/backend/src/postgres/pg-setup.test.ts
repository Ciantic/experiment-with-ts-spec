/**
 * Asserts that a `pg` pool reaches the port through `createPgConnection`, and that the
 * connection brackets its statements around one checked-out client. See docs/transactions.md.
 */
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createTransactionalDb, type DriverConnection, type SqlExecutor } from "../db/sql-executor.ts";
import { createPgConnection } from "./pg-setup.ts";

/** A pool and its one client, recording the statements and the release, so the bracketing is observable. */
function fakePool() {
    const statements: string[] = [];
    let releases = 0;
    const client = {
        query: async (sql: string) => {
            statements.push(sql);
            return { rows: [] };
        },
        release: () => {
            releases += 1;
        },
    } as unknown as PoolClient;
    const pool = {
        query: async (sql: string) => {
            statements.push(sql);
            return { rows: [] };
        },
        connect: async () => client,
    } as unknown as Pool;
    return { pool, statements, releases: () => releases };
}

/** The port a test runs against, plus what the fake driver observed. */
function fixture() {
    const fake = fakePool();
    return { db: createTransactionalDb(createPgConnection(fake.pool)), fake };
}

describe("createPgConnection", () => {
    it("takes a pg Pool, which is what makes the driver reachable", () => {
        const { pool } = fakePool();
        const connection: DriverConnection = createPgConnection(pool);

        expect(typeof connection.transaction).toBe("function");
    });

    it("does not take a bare Pool, because a pool cannot pin a transaction", () => {
        const { pool } = fakePool();

        // @ts-expect-error a Pool has no transaction of its own, so it needs createPgConnection.
        const connection: DriverConnection = pool;

        expect(connection).toBe(pool);
    });

    it("hands the callback a client that queries but cannot open a boundary of its own", async () => {
        const { pool } = fakePool();

        await createPgConnection(pool).transaction(async (tx) => {
            // @ts-expect-error a checked-out PoolClient has no transaction, so nesting stays the port's job.
            const asPort: SqlExecutor = tx;

            expect(typeof tx.query).toBe("function");
            expect(asPort).toBe(tx);
        });
    });

    it("opens the driver's own boundary, committing around the callback", async () => {
        const { db, fake } = fixture();

        await db.transaction(async (tx) => {
            await tx.query("insert into widget (id) values ($1)", ["a"]);
        });

        expect(fake.statements).toEqual(["begin", "insert into widget (id) values ($1)", "commit"]);
        expect(fake.releases()).toBe(1);
    });

    it("nests on top of that boundary as a savepoint, releasing the client once", async () => {
        const { db, fake } = fixture();

        await db.transaction(async (tx) => {
            await tx.query("outer");
            await tx.transaction(async (inner) => {
                await inner.query("inner");
            });
        });

        expect(fake.statements).toEqual([
            "begin",
            "outer",
            "savepoint sp_1",
            "inner",
            "release savepoint sp_1",
            "commit",
        ]);
        expect(fake.releases()).toBe(1);
    });

    it("rolls back and releases the client when the callback throws", async () => {
        const { db, fake } = fixture();

        await expect(
            db.transaction(async (tx) => {
                await tx.query("write");
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        expect(fake.statements).toEqual(["begin", "write", "rollback"]);
        expect(fake.releases()).toBe(1);
    });

    it("rolls back only the nested boundary, leaving the outer one to commit", async () => {
        const { db, fake } = fixture();

        await db.transaction(async (tx) => {
            await tx.query("outer");
            await expect(
                tx.transaction(async (inner) => {
                    await inner.query("inner");
                    throw new Error("inner boom");
                }),
            ).rejects.toThrow("inner boom");
            await tx.query("after");
        });

        expect(fake.statements).toEqual([
            "begin",
            "outer",
            "savepoint sp_1",
            "inner",
            "rollback to savepoint sp_1",
            "release savepoint sp_1",
            "after",
            "commit",
        ]);
        expect(fake.releases()).toBe(1);
    });
});
