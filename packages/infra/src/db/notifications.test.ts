/** Checks the subscription behind a generated `notify<Entity>` over a real driver. See docs/notifications.md. */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgliteSqlDriver } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { subscribe } from "./notifications.ts";

/** A fresh database and the executor a caller gets from it. */
async function fixture(): Promise<{ db: SqlExecutor; close: () => Promise<void> }> {
    const driver = new PgliteSqlDriver(PGlite);
    return { db: driver.createExecutor(), close: () => driver.close() };
}

/** Give the listener time to issue its `listen` before the test notifies. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("subscribe", () => {
    it("yields once for every notification on the channel, with no payload", async () => {
        const { db, close } = await fixture();
        const iterator = subscribe(db, "widget")[Symbol.asyncIterator]();

        const first = iterator.next();
        await settle();
        await db.query("select pg_notify('widget', '')");
        expect(await first).toEqual({ done: false, value: undefined });

        const second = iterator.next();
        await db.query("select pg_notify('widget', '')");
        expect(await second).toEqual({ done: false, value: undefined });

        await iterator.return?.(undefined);
        await close();
    });

    it("ignores another channel's notification", async () => {
        const { db, close } = await fixture();
        const iterator = subscribe(db, "widget")[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await db.query("select pg_notify('other', '')");
        await db.query("select pg_notify('widget', '')");

        expect(await pending).toEqual({ done: false, value: undefined });
        await iterator.return?.(undefined);
        await close();
    });

    it("stops when the signal aborts", async () => {
        const { db, close } = await fixture();
        const abort = new AbortController();
        const iterator = subscribe(db, "widget", abort.signal)[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        abort.abort();

        expect(await pending).toEqual({ done: true, value: undefined });
        await close();
    });

    it("settles a waiting read when the iterator is closed", async () => {
        const { db, close } = await fixture();
        const iterator = subscribe(db, "widget")[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await iterator.return?.(undefined);

        expect(await pending).toEqual({ done: true, value: undefined });
        await close();
    });
});
