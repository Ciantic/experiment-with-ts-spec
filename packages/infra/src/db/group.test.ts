/** Unit tests for the group boundary semantics, against a real PGlite. See docs/transactions.md. */
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { AppContext, RequestContext } from "../context.ts";
import { PgliteSqlDriver } from "../postgres/pglite-setup.ts";
import { attempt, attemptWith, batch, transaction, transactionWith, type Attempted, type Step } from "./group.ts";

/** A stand-in for the request a context answers; these tests never read it. */
const REQUEST = {} as IncomingMessage;

let driver: PgliteSqlDriver;
let app: AppContext;
let context: RequestContext;

/** A fresh database with one table per test, and the app and request context the boundaries run on. */
beforeEach(async () => {
    driver = new PgliteSqlDriver(PGlite);
    await driver.query("create table widget (id text primary key)");
    app = new AppContext({ driver: () => driver });
    context = new RequestContext(app, REQUEST);
});

/** Release the database each test opened; this file owns it, so the context has no shutdown of its own. */
afterEach(async () => {
    await driver.close();
});

/** The ids stored, in order, as the app's driver reads them. */
async function ids(app: AppContext): Promise<string[]> {
    const result = (await app.driver.query("select id from widget order by id")) as {
        rows: { id: string }[];
    };
    return result.rows.map((row) => row.id);
}

/** A step that inserts one row. */
function insert(id: string): Step {
    return async (context) => {
        await context.db.query("insert into widget (id) values ($1)", [id]);
        return id;
    };
}

/** A step that raises, standing in for a repository refusing a write. */
function refuse(id: string): Step {
    return async (context) => {
        await context.db.query("insert into widget (id) values ($1)", [id]);
        throw new Error(`refused ${id}`);
    };
}

/** A step that answers the transaction setting `name` as the boundary sees it. */
function setting(name: string): Step {
    return async (context) => (await context.db.query(`show ${name}`)).rows[0]?.[name];
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
async function boundaryTrace(run: (context: RequestContext) => Promise<void>): Promise<string[]> {
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
        await run(new RequestContext(new AppContext({ driver: () => driver }), REQUEST));
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
        await expect(batch(context, insert("a"), refuse("b"))).rejects.toThrow("refused b");

        // The step that raised had already written, and no boundary was open to discard it.
        expect(await ids(app)).toEqual(["a", "b"]);
    });

    it("answers the results in step order", async () => {
        expect(await batch(context, insert("a"), insert("b"))).toEqual(["a", "b"]);
    });
});

describe("transaction", () => {
    it("hands every step the boundary it opened, so a failure discards all of them", async () => {
        await expect(transaction(context, insert("a"), refuse("b"))).rejects.toThrow("refused b");

        expect(await ids(app)).toEqual([]);
    });

    it("commits every step when none fails", async () => {
        expect(await transaction(context, insert("a"), insert("b"))).toEqual(["a", "b"]);

        expect(await ids(app)).toEqual(["a", "b"]);
    });

    it("is a savepoint when the database is already inside a boundary", async () => {
        await context.db.transaction(async (tx) => {
            await transaction(context.withExecutor(tx), insert("a"));
            await expect(transaction(context.withExecutor(tx), insert("b"), refuse("c"))).rejects.toThrow("refused c");
            await transaction(context.withExecutor(tx), insert("d"));
        });

        // The failed inner boundary rolled back on its own, and the outer one still committed.
        expect(await ids(app)).toEqual(["a", "d"]);
    });

    it("discards a nested boundary with the outer one when the outer fails", async () => {
        await expect(
            context.db.transaction(async (tx) => {
                await transaction(context.withExecutor(tx), insert("a"));
                throw new Error("outer");
            }),
        ).rejects.toThrow("outer");

        expect(await ids(app)).toEqual([]);
    });
});

describe("attempt", () => {
    it("reports a failure instead of raising it, and discards its own steps", async () => {
        const outcome = await attempt(context, insert("a"), refuse("b"));

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as Error).message).toBe("refused b");
        expect(await ids(app)).toEqual([]);
    });

    it("reports the failure unchanged, for the caller to interpret", async () => {
        const marker = new Error("refused b");

        const outcome = await attempt(context, async () => {
            throw marker;
        });

        expect(outcome.ok === false && outcome.error).toBe(marker);
    });

    it("carries the results when nothing fails", async () => {
        expect(await attempt(context, insert("a"))).toEqual({ ok: true, value: ["a"] });
    });

    it("leaves the enclosing boundary usable after a tolerated failure", async () => {
        await context.db.transaction(async (tx) => {
            await attempt(context.withExecutor(tx), insert("a"), refuse("b"));
            await transaction(context.withExecutor(tx), insert("c"));
        });

        // The tolerated boundary rolled back to its savepoint, and the outer one still committed.
        expect(await ids(app)).toEqual(["c"]);
    });

    it("opens a boundary of its own, so its steps never share the outer one", async () => {
        await attempt(context, insert("a"), refuse("b"));

        expect(await ids(app)).toEqual([]);
    });
});

describe("the modes a group names", () => {
    it("opens the boundary at them, and they do not outlive it", async () => {
        const inside = await transactionWith(
            context,
            { isolationLevel: "serializable", accessMode: "read only" },
            setting("transaction_isolation"),
            setting("transaction_read_only"),
        );

        expect(inside).toEqual(["serializable", "on"]);
        // A mode belongs to the boundary, so the next statement is back at the session default.
        expect(await setting("transaction_isolation")(context)).toBe("read committed");
        expect(await setting("transaction_read_only")(context)).toBe("off");
    });

    it("gives an attempt the same modes, and still tolerates the write one of them refuses", async () => {
        const outcome = await attemptWith(
            context,
            { accessMode: "read only" },
            setting("transaction_read_only"),
            insert("a"),
        );

        expect(outcome.ok === false && (outcome.error as Error).message).toMatch(/read-only/i);
        expect(await ids(app)).toEqual([]);
    });

    it("leaves the boundary at the session defaults when the call names none", async () => {
        expect(await transaction(context, setting("transaction_isolation"))).toEqual([
            "read committed",
        ]);
    });

    it("refuses them on a nested boundary, which is a savepoint and takes none", async () => {
        await context.db.transaction(async (tx) => {
            await expect(
                transactionWith(context.withExecutor(tx), { accessMode: "read only" }, insert("a")),
            ).rejects.toThrow("a nested boundary is a savepoint");
        });

        expect(await ids(app)).toEqual([]);
    });
});

describe("the typed results", () => {
    it("keeps each step's result type, whichever kind groups it", async () => {
        const write = (id: string) => async (inner: RequestContext) => {
            await inner.db.query("insert into widget (id) values ($1)", [id]);
            return id;
        };
        const count = async (inner: RequestContext) =>
            (await inner.db.query("select id from widget order by id")).rows.length;

        // `tsc` is the assertion here: `unknown[]` is not assignable to either tuple.
        const grouped: [string, number] = await transaction(context, write("a"), count);
        const loose: [string, number] = await batch(context, write("b"), count);
        const tried: Attempted<[string, number]> = await attempt(context, write("c"), count);

        expect(grouped).toEqual(["a", 1]);
        expect(loose).toEqual(["b", 2]);
        expect(tried).toEqual({ ok: true, value: ["c", 3] });
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
                await transaction(ctx.withExecutor(tx), insert("a"));
                await expect(transaction(ctx.withExecutor(tx), insert("b"), refuse("c"))).rejects.toThrow(
                    "refused c",
                );
                await transaction(ctx.withExecutor(tx), insert("d"));
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
                await attempt(ctx.withExecutor(tx), insert("a"), refuse("b"));
                await transaction(ctx.withExecutor(tx), insert("c"));
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
