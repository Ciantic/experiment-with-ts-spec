/** Unit tests for the group boundary semantics, against a real PGlite. See docs/transactions.md. */
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RequestContext } from "../context.ts";
import { PgliteSqlDriver } from "../postgres/pglite-setup.ts";
import { attempt, attemptWith, batch, transaction, transactionWith, type Attempted, type Step } from "./group.ts";
import type { SqlExecutor } from "./sql-executor.ts";

/** A fresh database with one table, and the `SqlExecutor` port over it. */
async function fixture(): Promise<{ db: SqlExecutor; close: () => Promise<void> }> {
    const driver = new PgliteSqlDriver(PGlite);
    await driver.query("create table widget (id text primary key)");
    return { db: driver.createExecutor(), close: () => driver.close() };
}

/** A request context over one executor, for the boundaries; these tests never read the request. */
function over(executor: SqlExecutor): RequestContext {
    return new RequestContext(executor, {} as IncomingMessage);
}

/** The ids stored, in order. */
async function ids(db: SqlExecutor): Promise<string[]> {
    const result = (await db.query("select id from widget order by id")) as { rows: { id: string }[] };
    return result.rows.map((row) => row.id);
}

/** A step that inserts one row. */
function insert(id: string): Step {
    return async (ctx) => {
        await ctx.db.query("insert into widget (id) values ($1)", [id]);
        return id;
    };
}

/** A step that raises, standing in for a repository refusing a write. */
function refuse(id: string): Step {
    return async (ctx) => {
        await ctx.db.query("insert into widget (id) values ($1)", [id]);
        throw new Error(`refused ${id}`);
    };
}

/** A step that answers the transaction setting `name` as the boundary sees it. */
function setting(name: string): Step {
    return async (ctx) => (await ctx.db.query(`show ${name}`)).rows[0]?.[name];
}

/** One statement PGlite logged: the SQL, and the values it ran with. */
interface Logged {
    sql: string;
    parameters: unknown[];
}

/** The statements PGlite logged, read from the arguments it hands `console.log`. */
function logged(calls: unknown[][]): Logged[] {
    return calls.flatMap(([tag, sql, parameters]) => {
        if ((tag !== "runExec" && tag !== "runQuery") || typeof sql !== "string") {
            return [];
        }
        return [{ sql, parameters: Array.isArray(parameters) ? parameters : [] }];
    });
}

/** The statement that opens, ends, or nests a boundary. */
const BOUNDARY = /^(?:begin|commit|rollback|savepoint|release savepoint|rollback to savepoint)\b/i;

/** The insert every step here writes. */
const INSERTED = /^insert into \w+\b/i;

/** A trace entry: a boundary, or the row an insert writes. The rest is the driver's own work. */
function entry({ sql, parameters }: Logged): string | undefined {
    const text = sql.trim().toLowerCase();
    if (INSERTED.test(text)) {
        return `insert ${parameters.join(" ")}`;
    }
    return BOUNDARY.test(text) ? text : undefined;
}

/** Run `run` against a fresh database while capturing PGlite's own log; answer its trace of boundaries and inserts. */
async function boundaryTrace(run: (ctx: RequestContext) => Promise<void>): Promise<string[]> {
    const calls: unknown[][] = [];
    const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "debug"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
    ].map((spy) =>
        spy.mockImplementation((...args: unknown[]) => {
            calls.push(args);
        }),
    );
    // PGlite's own log is the only place its statements appear, and its start-up chatter goes to the same channels.
    const driver = new PgliteSqlDriver(PGlite, { debug: 1 });
    try {
        await driver.query("create table widget (id text primary key)");
        await run(over(driver.createExecutor()));
    } finally {
        await driver.close();
        for (const spy of spies) {
            spy.mockRestore();
        }
    }
    return logged(calls).flatMap((call) => entry(call) ?? []);
}

describe("batch", () => {
    it("hands every step the database it was given, so nothing is atomic", async () => {
        const { db, close } = await fixture();

        await expect(batch(over(db), insert("a"), refuse("b"))).rejects.toThrow("refused b");

        // The step that raised had already written, and no boundary was open to discard it.
        expect(await ids(db)).toEqual(["a", "b"]);
        await close();
    });

    it("answers the results in step order", async () => {
        const { db, close } = await fixture();

        expect(await batch(over(db), insert("a"), insert("b"))).toEqual(["a", "b"]);
        await close();
    });
});

describe("transaction", () => {
    it("hands every step the boundary it opened, so a failure discards all of them", async () => {
        const { db, close } = await fixture();

        await expect(transaction(over(db), insert("a"), refuse("b"))).rejects.toThrow("refused b");

        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("commits every step when none fails", async () => {
        const { db, close } = await fixture();

        expect(await transaction(over(db), insert("a"), insert("b"))).toEqual(["a", "b"]);

        expect(await ids(db)).toEqual(["a", "b"]);
        await close();
    });

    it("is a savepoint when the database is already inside a boundary", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await transaction(over(tx), insert("a"));
            await expect(transaction(over(tx), insert("b"), refuse("c"))).rejects.toThrow("refused c");
            await transaction(over(tx), insert("d"));
        });

        // The failed inner boundary rolled back on its own, and the outer one still committed.
        expect(await ids(db)).toEqual(["a", "d"]);
        await close();
    });

    it("discards a nested boundary with the outer one when the outer fails", async () => {
        const { db, close } = await fixture();

        await expect(
            db.transaction(async (tx) => {
                await transaction(over(tx), insert("a"));
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

        const outcome = await attempt(over(db), insert("a"), refuse("b"));

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as Error).message).toBe("refused b");
        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("reports the failure unchanged, for the caller to interpret", async () => {
        const { db, close } = await fixture();
        const marker = new Error("refused b");

        const outcome = await attempt(over(db), async () => {
            throw marker;
        });

        expect(outcome.ok === false && outcome.error).toBe(marker);
        await close();
    });

    it("carries the results when nothing fails", async () => {
        const { db, close } = await fixture();

        expect(await attempt(over(db), insert("a"))).toEqual({ ok: true, value: ["a"] });
        await close();
    });

    it("leaves the enclosing boundary usable after a tolerated failure", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await attempt(over(tx), insert("a"), refuse("b"));
            await transaction(over(tx), insert("c"));
        });

        // The tolerated boundary rolled back to its savepoint, and the outer one still committed.
        expect(await ids(db)).toEqual(["c"]);
        await close();
    });

    it("opens a boundary of its own, so its steps never share the outer one", async () => {
        const { db, close } = await fixture();

        await attempt(over(db), insert("a"), refuse("b"));

        expect(await ids(db)).toEqual([]);
        await close();
    });
});

describe("the modes a group names", () => {
    it("opens the boundary at them, and they do not outlive it", async () => {
        const { db, close } = await fixture();

        const inside = await transactionWith(
            over(db),
            { isolationLevel: "serializable", accessMode: "read only" },
            setting("transaction_isolation"),
            setting("transaction_read_only"),
        );

        expect(inside).toEqual(["serializable", "on"]);
        // A mode belongs to the boundary, so the next statement is back at the session default.
        expect(await setting("transaction_isolation")(over(db))).toBe("read committed");
        expect(await setting("transaction_read_only")(over(db))).toBe("off");
        await close();
    });

    it("gives an attempt the same modes, and still tolerates the write one of them refuses", async () => {
        const { db, close } = await fixture();

        const outcome = await attemptWith(
            over(db),
            { accessMode: "read only" },
            setting("transaction_read_only"),
            insert("a"),
        );

        expect(outcome.ok === false && (outcome.error as Error).message).toMatch(/read-only/i);
        expect(await ids(db)).toEqual([]);
        await close();
    });

    it("leaves the boundary at the session defaults when the call names none", async () => {
        const { db, close } = await fixture();

        expect(await transaction(over(db), setting("transaction_isolation"))).toEqual(["read committed"]);
        await close();
    });

    it("refuses them on a nested boundary, which is a savepoint and takes none", async () => {
        const { db, close } = await fixture();

        await db.transaction(async (tx) => {
            await expect(transactionWith(over(tx), { accessMode: "read only" }, insert("a"))).rejects.toThrow(
                "a nested boundary is a savepoint",
            );
        });

        expect(await ids(db)).toEqual([]);
        await close();
    });
});

describe("the typed results", () => {
    it("keeps each step's result type, whichever kind groups it", async () => {
        const { db, close } = await fixture();
        const write = (id: string) => async (inner: RequestContext) => {
            await inner.db.query("insert into widget (id) values ($1)", [id]);
            return id;
        };
        const count = async (inner: RequestContext) => (await ids(inner.db)).length;

        // `tsc` is the assertion here: `unknown[]` is not assignable to either tuple.
        const grouped: [string, number] = await transaction(over(db), write("a"), count);
        const loose: [string, number] = await batch(over(db), write("b"), count);
        const tried: Attempted<[string, number]> = await attempt(over(db), write("c"), count);

        expect(grouped).toEqual(["a", 1]);
        expect(loose).toEqual(["b", 2]);
        expect(tried).toEqual({ ok: true, value: ["c", 3] });
        await close();
    });
});

describe("the statements the boundaries put on the driver", () => {
    it("leaves `batch` boundary-free, so a failure has nothing to discard", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await batch(ctx, insert("a"), insert("b"));
        });

        expect(trace).toEqual(["insert a", "insert b"]);
    });

    it("brackets a transaction with begin and commit", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await transaction(ctx, insert("a"), insert("b"));
        });

        expect(trace).toEqual(["begin", "insert a", "insert b", "commit"]);
    });

    it("writes the modes a group names into the statement that opens its boundary", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await transactionWith(
                ctx,
                { isolationLevel: "serializable", accessMode: "read only" },
                setting("transaction_read_only"),
            );
            await attemptWith(ctx, { deferrable: false }, insert("a"));
        });

        expect(trace).toEqual([
            "begin isolation level serializable, read only",
            "commit",
            "begin not deferrable",
            "insert a",
            "commit",
        ]);
    });

    it("brackets a failed transaction with begin and rollback, never reaching a commit", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await expect(transaction(ctx, insert("a"), refuse("b"))).rejects.toThrow("refused b");
        });

        expect(trace).toEqual(["begin", "insert a", "insert b", "rollback"]);
    });

    it("turns a nested transaction into a savepoint, and commits the outer one past a failed inner one", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await ctx.db.transaction(async (tx) => {
                await transaction(over(tx), insert("a"));
                await expect(transaction(over(tx), insert("b"), refuse("c"))).rejects.toThrow("refused c");
                await transaction(over(tx), insert("d"));
            });
        });

        // One savepoint per nested boundary: released, rolled back, released; names count from one per database.
        expect(trace).toEqual([
            "begin",
            "savepoint sp_1",
            "insert a",
            "release savepoint sp_1",
            "savepoint sp_2",
            "insert b",
            "insert c",
            "rollback to savepoint sp_2",
            "release savepoint sp_2",
            "savepoint sp_3",
            "insert d",
            "release savepoint sp_3",
            "commit",
        ]);
    });

    it("gives `attempt` the boundaries of a transaction, and none of its failure reaches the caller", async () => {
        const committed = await boundaryTrace(async (ctx) => {
            await attempt(ctx, insert("a"));
        });
        const discarded = await boundaryTrace(async (ctx) => {
            await attempt(ctx, insert("a"), refuse("b"));
        });

        expect(committed).toEqual(["begin", "insert a", "commit"]);
        expect(discarded).toEqual(["begin", "insert a", "insert b", "rollback"]);
    });

    it("gives `attempt` a savepoint of its own, so the outer boundary still commits", async () => {
        const trace = await boundaryTrace(async (ctx) => {
            await ctx.db.transaction(async (tx) => {
                await attempt(over(tx), insert("a"), refuse("b"));
                await transaction(over(tx), insert("c"));
            });
        });

        expect(trace).toEqual([
            "begin",
            "savepoint sp_1",
            "insert a",
            "insert b",
            "rollback to savepoint sp_1",
            "release savepoint sp_1",
            "savepoint sp_2",
            "insert c",
            "release savepoint sp_2",
            "commit",
        ]);
    });
});
