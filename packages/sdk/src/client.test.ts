/** Unit tests for the hand-written call model, over a stub `fetch`. See docs/transactions.md. */
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import {
    attempt,
    attemptWith,
    batch,
    call,
    exec,
    GROUP_PATH,
    transaction,
    transactionWith,
    type Attempted,
    type Call,
} from "./client.ts";
import { createHttpClient, HttpError, type HttpClient } from "./http.ts";

interface Recorded {
    url: string;
    init: RequestInit | undefined;
}

/** A `fetch` stand-in that records the request and answers with `response`. */
function stubFetch(response: Response): { calls: Recorded[]; impl: typeof fetch } {
    const calls: Recorded[] = [];
    const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), init });
        return response;
    };
    return { calls, impl: impl as typeof fetch };
}

/** A client over a stub that answers `body` with `status`. */
function client(body: string, status = 200) {
    const stub = stubFetch(new Response(body, { status }));
    return { ...stub, http: createHttpClient("http://api.example", stub.impl) };
}

/** The body a recorded request sent. */
function sentBody(recorded: Recorded): unknown {
    return parse(String(recorded.init?.body));
}

/** A stand-in for a spec entity, so the type assertions need no domain type. */
interface Widget {
    id: string;
    name: string;
}

/** What a selection may name. */
type SelectionOf<E> = { [K in keyof E]?: boolean };

/** What a selection produces, mirroring the generated `Selected<E, S>`. */
type SelectedOf<E, S> = Pick<E, Extract<keyof S, keyof E>>;

/**
 * A stand-in for a generated builder. The real ones are generic in what they
 * select, and that is the shape the group result has to preserve.
 */
function selectWidget<S extends SelectionOf<Widget>>(opts: { select: S }): Call<SelectedOf<Widget, S>[]> {
    return call<SelectedOf<Widget, S>[]>("queryWidget", "GET", "/widget/query", opts);
}

/** A value with both of the types a JSON encoding would lose. */
const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

describe("exec", () => {
    it("sends a GET call's argument as the query parameter", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("queryWidget", "GET", "/widget/query", payload));

        const url = new URL(calls[0]!.url);
        expect(url.origin + url.pathname).toBe("http://api.example/widget/query");
        expect(url.searchParams.get("q")).toBe(stringify(payload));
        expect(calls[0]?.init?.body).toBeUndefined();
    });

    it("sends a DELETE call's argument as the query parameter", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("deleteWidget", "DELETE", "/widget", [{ id: "a" }]));

        expect(new URL(calls[0]!.url).searchParams.get("q")).toBe(stringify([{ id: "a" }]));
    });

    it("sends a POST call's argument as the body", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("createWidget", "POST", "/widget", [payload]));

        expect(calls[0]?.url).toBe("http://api.example/widget");
        expect(calls[0]?.init?.method).toBe("POST");
        expect(calls[0]?.init?.body).toBe(stringify([payload]));
    });

    it("sends a PATCH call's argument as the body", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("updateWidget", "PATCH", "/widget", []));

        expect(calls[0]?.init?.method).toBe("PATCH");
    });

    it("sends a PUT call's argument as the body, as an upsert does", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("upsertWidget", "PUT", "/widget", [payload]));

        expect(calls[0]?.init?.method).toBe("PUT");
        expect(calls[0]?.init?.body).toBe(stringify([payload]));
    });

    it("decodes the result, restoring a Date and a bigint", async () => {
        const { http } = client(stringify([payload]));

        const rows = await exec(http, call<(typeof payload)[]>("queryWidget", "GET", "/widget/query", {}));

        expect(rows).toEqual([payload]);
    });
});

describe("groups", () => {
    it("posts a batch to the group path as a tree of calls", async () => {
        const { http, calls } = client(stringify([null, null]));

        await exec(http, batch(call<void>("createWidget", "POST", "/widget", [1]), call<void>("createOther", "POST", "/other", [2])));

        expect(calls[0]?.url).toBe(`http://api.example${GROUP_PATH}`);
        expect(calls[0]?.init?.method).toBe("POST");
        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    { call: { operation: "createWidget", argument: [1] } },
                    { call: { operation: "createOther", argument: [2] } },
                ],
            },
        });
    });

    it("marks a transaction group, and nests the two kinds", async () => {
        const { http, calls } = client(stringify([[null], null]));

        await exec(
            http,
            batch(
                transaction(call<void>("createWidget", "POST", "/widget", [])),
                call<void>("createOther", "POST", "/other", []),
            ),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    {
                        group: {
                            kind: "transaction",
                            calls: [{ call: { operation: "createWidget", argument: [] } }],
                        },
                    },
                    { call: { operation: "createOther", argument: [] } },
                ],
            },
        });
    });

    it("nests a transaction inside a transaction, keeping both result levels", async () => {
        const { http, calls } = client(stringify([[null, null], [{ id: "r" }]]));

        const [writes, rows] = await exec(
            http,
            transaction(
                transaction(call<void>("createWidget", "POST", "/widget", []), call<void>("createOther", "POST", "/other", [])),
                call<{ id: string }[]>("queryWidget", "GET", "/widget/query", {}),
            ),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "transaction",
                calls: [
                    {
                        group: {
                            kind: "transaction",
                            calls: [
                                { call: { operation: "createWidget", argument: [] } },
                                { call: { operation: "createOther", argument: [] } },
                            ],
                        },
                    },
                    { call: { operation: "queryWidget", argument: {} } },
                ],
            },
        });
        expect(writes).toEqual([null, null]);
        expect(rows).toEqual([{ id: "r" }]);
    });

    it("keeps a nested group's results nested", async () => {
        const { http } = client(stringify([["inner"], "outer"]));

        const [inner, outer] = await exec(
            http,
            batch(
                transaction(call<string[]>("createWidget", "POST", "/widget", [])),
                call<string>("createOther", "POST", "/other", []),
            ),
        );

        expect(inner).toEqual(["inner"]);
        expect(outer).toBe("outer");
    });

    it("marks an attempt group, and keeps its recovery shape", async () => {
        const { http, calls } = client(stringify([{ ok: false, error: { message: "boom", path: [0] } }]));

        const [outcome] = await exec(
            http,
            batch(attempt(call<void>("createWidget", "POST", "/widget", [1]))),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    {
                        group: {
                            kind: "attempt",
                            calls: [{ call: { operation: "createWidget", argument: [1] } }],
                        },
                    },
                ],
            },
        });
        expect(outcome).toEqual({ ok: false, error: { message: "boom", path: [0] } });
    });

    it("carries the modes a transaction names, and marks the group", async () => {
        const { http, calls } = client(stringify([null]));

        await exec(
            http,
            transactionWith(
                { isolationLevel: "serializable", accessMode: "read only" },
                call<void>("createWidget", "POST", "/widget", []),
            ),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "transaction",
                options: { isolationLevel: "serializable", accessMode: "read only" },
                calls: [{ call: { operation: "createWidget", argument: [] } }],
            },
        });
    });

    it("carries them on an attempt, and leaves them off a group that names none", async () => {
        const named = client(stringify({ ok: true, value: [null] }));
        const plain = client(stringify([null]));

        await exec(named.http, attemptWith({ deferrable: true }, call<void>("createWidget", "POST", "/widget", [])));
        await exec(plain.http, batch(call<void>("createWidget", "POST", "/widget", [])));

        expect(sentBody(named.calls[0]!)).toEqual({
            group: {
                kind: "attempt",
                options: { deferrable: true },
                calls: [{ call: { operation: "createWidget", argument: [] } }],
            },
        });
        // A group with no modes writes no `options`, so the tree stays what it was.
        expect(sentBody(plain.calls[0]!)).toEqual({
            group: { kind: "batch", calls: [{ call: { operation: "createWidget", argument: [] } }] },
        });
    });

    it("carries the modes of a nested group, and keeps the outer group's own", async () => {
        const { http, calls } = client(stringify([null]));

        await exec(
            http,
            transactionWith(
                { accessMode: "read only" },
                transaction(call<void>("createWidget", "POST", "/widget", [])),
            ),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "transaction",
                options: { accessMode: "read only" },
                calls: [
                    {
                        group: {
                            kind: "transaction",
                            calls: [{ call: { operation: "createWidget", argument: [] } }],
                        },
                    },
                ],
            },
        });
    });

    it("raises an HttpError naming the entry that failed", async () => {
        const { http } = client(JSON.stringify({ error: "version conflict", path: [1, 0] }), 409);

        const failure = await exec(http, transaction(call<void>("createWidget", "POST", "/widget", []))).catch(
            (thrown: unknown) => thrown,
        );

        expect(failure).toBeInstanceOf(HttpError);
        expect((failure as HttpError).status).toBe(409);
        expect((failure as HttpError).path).toEqual([1, 0]);
    });

    it("reports no path for a failure that is not a group's", async () => {
        const { http } = client(JSON.stringify({ error: "version conflict" }), 409);

        const failure = await exec(http, call<void>("updateWidget", "PATCH", "/widget", [])).catch(
            (thrown: unknown) => thrown,
        );

        expect((failure as HttpError).path).toBeUndefined();
    });
});

describe("the result type", () => {
    /** Never called: each annotation below is the assertion, checked by `tsc --noEmit`. */
    function assertTypes(): void {
        const http = undefined as unknown as HttpClient;
        const row = call<{ id: string }[]>("queryWidget", "GET", "/widget/query", {});
        const write = call<void>("createWidget", "POST", "/widget", []);

        const single: Promise<{ id: string }[]> = exec(http, row);
        const allVoid: Promise<void> = exec(http, transaction(write, write));
        const mixed: Promise<[{ id: string }[], void]> = exec(http, batch(row, write));
        // A nested group keeps a level per group, so the inner tuple stays a tuple.
        const nested: Promise<[[{ id: string }[], void], void]> = exec(
            http,
            transaction(batch(row, write), write),
        );
        const tolerated: Promise<Attempted<void>> = exec(http, attempt(write, write));
        const toleratedRows: Promise<Attempted<[{ id: string }[], void]>> = exec(
            http,
            attempt(row, write),
        );
        // The modes ride on the group alone, so they shift no result: the tuple stays aligned with the calls.
        const withModes: Promise<[{ id: string }[], void]> = exec(
            http,
            transactionWith({ isolationLevel: "serializable" }, row, write),
        );
        const toleratedWithModes: Promise<Attempted<[{ id: string }[], void]>> = exec(
            http,
            attemptWith({ accessMode: "read only" }, row, write),
        );

        // A generated builder is generic in what it selects, so its result must still
        // narrow by position once it is inside a group.
        const selected: Promise<[void, Pick<Widget, "id">[]]> = exec(
            http,
            transaction(write, selectWidget({ select: { id: true } })),
        );

        void [single, allVoid, mixed, nested, tolerated, toleratedRows, selected, withModes, toleratedWithModes];
    }

    it("keeps each call's result, positionally, and collapses an all-void group", () => {
        expect(assertTypes).toBeTypeOf("function");
    });

    it("narrows an attempt's success branch to the group's results", () => {
        const rows = [{ id: "r" }];
        const outcome: Attempted<typeof rows> = { ok: true, value: rows };

        expect(outcome.ok && outcome.value).toEqual(rows);
    });
});
