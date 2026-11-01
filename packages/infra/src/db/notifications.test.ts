/** Checks the subscriptions behind a generated `notify<Entity>` and `watch<Entity>` over a real driver. See docs/notifications.md. */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgliteSqlDriver } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { subscribe, watchKeys } from "./notifications.ts";

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
    it("yields once for every notification on the channel, with its payload", async () => {
        const { db, close } = await fixture();
        const iterator = subscribe(db, "widget")[Symbol.asyncIterator]();

        const first = iterator.next();
        await settle();
        await db.query(`select pg_notify('widget', '{"id":"a"}')`);
        expect(await first).toEqual({ done: false, value: '{"id":"a"}' });

        const second = iterator.next();
        await db.query(`select pg_notify('widget', '')`);
        expect(await second).toEqual({ done: false, value: "" });

        await iterator.return?.(undefined);
        await close();
    });

    it("ignores another channel's notification", async () => {
        const { db, close } = await fixture();
        const iterator = subscribe(db, "widget")[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await db.query(`select pg_notify('other', '{"id":"a"}')`);
        await db.query(`select pg_notify('widget', '{"id":"a"}')`);

        expect(await pending).toEqual({ done: false, value: '{"id":"a"}' });
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

describe("watchKeys", () => {
    it("yields the requested key whose row changed, with the operation, and ignores the rest", async () => {
        const { db, close } = await fixture();
        const keys = [{ id: "a" }, { id: "b" }];
        const iterator = watchKeys(db, "widget", keys, ["id"])[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await db.query(`select pg_notify('widget', '{"op":"DELETE","key":{"id":"c"}}')`);
        await db.query(`select pg_notify('widget', '{"op":"DELETE","key":{"id":"b"}}')`);

        expect(await pending).toEqual({ done: false, value: { key: { id: "b" }, op: "DELETE" } });
        await iterator.return?.(undefined);
        await close();
    });

    it("matches a date key in the trigger's canonical text", async () => {
        const { db, close } = await fixture();
        const at = new Date("2026-01-02T03:04:05.000Z");
        const iterator = watchKeys(db, "widget", [{ at }], ["at"])[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await db.query(
            `select pg_notify('widget', '{"op":"INSERT","key":{"at":"2026-01-02T03:04:05.000Z"}}')`,
        );

        expect(await pending).toEqual({ done: false, value: { key: { at }, op: "INSERT" } });
        await iterator.return?.(undefined);
        await close();
    });

    it("ignores a payload that carries no operation", async () => {
        const { db, close } = await fixture();
        const iterator = watchKeys(db, "widget", [{ id: "a" }], ["id"])[Symbol.asyncIterator]();

        const pending = iterator.next();
        await settle();
        await db.query(`select pg_notify('widget', '{"id":"a"}')`);
        await db.query(`select pg_notify('widget', '{"op":"UPDATE","key":{"id":"a"}}')`);

        expect(await pending).toEqual({ done: false, value: { key: { id: "a" }, op: "UPDATE" } });
        await iterator.return?.(undefined);
        await close();
    });

    it("completes immediately when no key is requested", async () => {
        const { db, close } = await fixture();
        const iterator = watchKeys(db, "widget", [], ["id"])[Symbol.asyncIterator]();

        expect(await iterator.next()).toEqual({ done: true, value: undefined });
        await close();
    });
});
