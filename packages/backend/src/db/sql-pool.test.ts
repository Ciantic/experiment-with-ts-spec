/** Checks the one-connection pool a single-session driver reaches the port through. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createSingleConnectionPool } from "./sql-pool.ts";

/** A pool over a statement that records what it ran, so the ordering is observable. */
function echo(): { pool: ReturnType<typeof createSingleConnectionPool>; ran: string[] } {
    const ran: string[] = [];
    const pool = createSingleConnectionPool(async (sql) => {
        ran.push(sql);
        return { rows: [{ sql }] };
    });
    return { pool, ran };
}

/** Let every already-scheduled microtask run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSingleConnectionPool", () => {
    it("holds the connection across a checkout, so a second one waits for its release", async () => {
        const { pool, ran } = echo();

        const first = await pool.connect();
        let second: string | undefined;
        void pool.connect().then((session) => {
            second = "taken";
            session.release();
        });

        await settle();
        expect(second).toBeUndefined();

        await first.query("one");
        first.release();
        await settle();

        expect(second).toBe("taken");
        expect(ran).toEqual(["one"]);
    });

    it("hands the turn on once, so a double release does not let a second taker through", async () => {
        const { pool } = echo();

        const first = await pool.connect();
        let secondTaken = false;
        let thirdTaken = false;
        const second = pool.connect().then((session) => {
            secondTaken = true;
            return session;
        });
        const third = pool.connect().then((session) => {
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
    });

    it("gives a plain query the same turn, so it cannot run inside an open checkout", async () => {
        const { pool, ran } = echo();

        const held = await pool.connect();
        void pool.query("inside");
        await settle();
        expect(ran).toEqual([]);

        held.release();
        await settle();
        expect(ran).toEqual(["inside"]);
    });

    it("frees the turn when a statement throws", async () => {
        const ran: string[] = [];
        const pool = createSingleConnectionPool(async (sql) => {
            ran.push(sql);
            if (sql === "boom") {
                throw new Error("boom");
            }
            return { rows: [] };
        });

        await expect(pool.query("boom")).rejects.toThrow("boom");
        await pool.query("after");

        expect(ran).toEqual(["boom", "after"]);
    });
});
