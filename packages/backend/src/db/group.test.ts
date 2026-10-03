/** Unit tests for the group boundary semantics, against a real PGlite. See docs/transactions.md. */
import { describe, expect, it } from "vitest";
import { createPglite } from "../postgres/pglite-setup.ts";
import { attempt, batch, transaction, type Attempted, type Step } from "./group.ts";
import type { Db } from "./sql-executor.ts";
import { createTransactionalDb } from "./transaction.ts";

/** A fresh database with one table, and the `Db` port over it. */
async function fixture(): Promise<{ db: Db; close: () => Promise<void> }> {
    const driver = createPglite();
    await driver.query("create table widget (id text primary key)");
    return { db: createTransactionalDb(driver), close: () => driver.close() };
}

/** The ids stored, in order. */
async function ids(db: Db): Promise<string[]> {
    const result = (await db.query("select id from widget order by id")) as { rows: { id: string }[] };
    return result.rows.map((row) => row.id);
}

/** A step that inserts one row. */
function insert(id: string): Step {
    return async (db) => {
        await db.query("insert into widget (id) values ($1)", [id]);
        return id;
    };
}

/** A step that raises, standing in for a repository refusing a write. */
function refuse(id: string): Step {
    return async (db) => {
        await db.query("insert into widget (id) values ($1)", [id]);
        throw new Error(`refused ${id}`);
    };
}

describe("batch", () => {
    it("hands every step the database it was given, so nothing is atomic", async () => {
        const { db, close } = await fixture();

        await expect(batch(db, insert("a"), refuse("b"))).rejects.toThrow("refused b");

        // The step that raised had already written, and no boundary was open to discard it.
        expect(await ids(db)).toEqual(["a", "b"]);
        await close();
    });

    it("answers the results in step order", async () => {
        const { db, close } = await fixture();

        expect(await batch(db, insert("a"), insert("b"))).toEqual(["a", "b"]);
        await close();
    });
});

describe("transaction", () => {
    it("hands every step the boundary it opened, so a failure discards all of them", async () => {
        const { db, close } = await fixture();

        await expect(transaction(db, insert("a"), refuse("b"))).rejects.toThrow("refused b");

        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("commits every step when none fails", async () => {
        const { db, close } = await fixture();

        expect(await transaction(db, insert("a"), insert("b"))).toEqual(["a", "b"]);

        expect(await ids(db)).toEqual(["a", "b"]);
        await close();
    });

    it("is a savepoint when the database is already inside a boundary", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await transaction(tx, insert("a"));
            await expect(transaction(tx, insert("b"), refuse("c"))).rejects.toThrow("refused c");
            await transaction(tx, insert("d"));
        });

        // The failed inner boundary rolled back on its own, and the outer one still committed.
        expect(await ids(db)).toEqual(["a", "d"]);
        await close();
    });

    it("discards a nested boundary with the outer one when the outer fails", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transaction(async (tx) => {
                await transaction(tx, insert("a"));
                throw new Error("outer");
            }),
        ).rejects.toThrow("outer");

        expect(await ids(db)).toEqual([]);
        await close();
    });
});

describe("attempt", () => {
    it("reports a failure instead of raising it, and discards its own steps", async () => {
        const { db, close } = await fixture();

        const outcome = await attempt(db, insert("a"), refuse("b"));

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as Error).message).toBe("refused b");
        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("reports the failure unchanged, for the caller to interpret", async () => {
        const { db, close } = await fixture();
        const marker = new Error("refused b");

        const outcome = await attempt(db, async () => {
            throw marker;
        });

        expect(outcome.ok === false && outcome.error).toBe(marker);
        await close();
    });

    it("carries the results when nothing fails", async () => {
        const { db, close } = await fixture();

        expect(await attempt(db, insert("a"))).toEqual({ ok: true, value: ["a"] });
        await close();
    });

    it("leaves the enclosing boundary usable after a tolerated failure", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await attempt(tx, insert("a"), refuse("b"));
            await transaction(tx, insert("c"));
        });

        // The tolerated boundary rolled back to its savepoint, and the outer one still committed.
        expect(await ids(db)).toEqual(["c"]);
        await close();
    });

    it("opens a boundary of its own, so its steps never share the outer one", async () => {
        const { db, close } = await fixture();

        await attempt(db, insert("a"), refuse("b"));

        expect(await ids(db)).toEqual([]);
        await close();
    });
});

describe("the typed results", () => {
    it("keeps each step's result type, whichever kind groups it", async () => {
        const { db, close } = await fixture();
        const write = (id: string) => async (inner: Db) => {
            await inner.query("insert into widget (id) values ($1)", [id]);
            return id;
        };
        const count = async (inner: Db) => (await ids(inner)).length;

        // `tsc` is the assertion here: `unknown[]` is not assignable to either tuple.
        const grouped: [string, number] = await transaction(db, write("a"), count);
        const loose: [string, number] = await batch(db, write("b"), count);
        const tried: Attempted<[string, number]> = await attempt(db, write("c"), count);

        expect(grouped).toEqual(["a", 1]);
        expect(loose).toEqual(["b", 2]);
        expect(tried).toEqual({ ok: true, value: ["c", 3] });
        await close();
    });
});
