/** Checks the one-connection adapter a single-session database reaches the driver port through. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createSingleConnectionDriver } from "./sql-driver.ts";

/** A driver over a statement that records what it ran, so the ordering is observable. */
function echo(): { driver: ReturnType<typeof createSingleConnectionDriver>; ran: string[] } {
    const ran: string[] = [];
    const driver = createSingleConnectionDriver({
        query: async (sql) => {
            ran.push(sql);
            return { rows: [{ sql }] };
        },
        exec: async () => undefined,
        close: async () => {},
    });
    return { driver, ran };
}

/** Let every already-scheduled microtask run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSingleConnectionDriver", () => {
    it("holds the connection across a checkout, so a second one waits for its release", async () => {
        const { driver, ran } = echo();

        const first = await driver.connect();
        let second: string | undefined;
        void driver.connect().then((session) => {
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
        const { driver } = echo();

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
    });

    it("gives a plain query the same turn, so it cannot run inside an open checkout", async () => {
        const { driver, ran } = echo();

        const held = await driver.connect();
        void driver.query("inside");
        await settle();
        expect(ran).toEqual([]);

        held.release();
        await settle();
        expect(ran).toEqual(["inside"]);
    });

    it("frees the turn when a statement throws", async () => {
        const ran: string[] = [];
        const driver = createSingleConnectionDriver({
            query: async (sql) => {
                ran.push(sql);
                if (sql === "boom") {
                    throw new Error("boom");
                }
                return { rows: [] };
            },
            exec: async () => undefined,
            close: async () => {},
        });

        await expect(driver.query("boom")).rejects.toThrow("boom");
        await driver.query("after");

        expect(ran).toEqual(["boom", "after"]);
    });

    it("answers the write count, defaulting it to zero when the connection reports none", async () => {
        const counted = createSingleConnectionDriver({
            query: async () => ({ rows: [], affectedRows: 3 }),
            exec: async () => undefined,
            close: async () => {},
        });
        const bare = createSingleConnectionDriver({
            query: async () => ({ rows: [] }),
            exec: async () => undefined,
            close: async () => {},
        });

        expect(await counted.query("update widget set id = id")).toEqual({ rows: [], affectedRows: 3 });

        const session = await bare.connect();
        expect(await session.query("select 1")).toEqual({ rows: [], affectedRows: 0 });
        session.release();
    });

    it("passes the batch and shutdown through to the connection", async () => {
        const calls: string[] = [];
        const driver = createSingleConnectionDriver({
            query: async () => ({ rows: [] }),
            exec: async () => {
                calls.push("exec");
            },
            close: async () => {
                calls.push("close");
            },
        });

        await driver.exec("create table widget ()");
        await driver.close();

        expect(calls).toEqual(["exec", "close"]);
    });
});
