/** Unit tests for the hand-written call model, over a stub `fetch`. See docs/transactions.md. */
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { batch, bundle, attempt, call, exec, GROUP_PATH, transaction, type Attempted, type Call } from "./client.ts";
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
    return call<SelectedOf<Widget, S>[]>("GET", "/widget/query", opts);
}

/** A value with both of the types a JSON encoding would lose. */
const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

describe("exec", () => {
    it("sends a GET call's argument as the query parameter", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("GET", "/widget/query", payload));

        const url = new URL(calls[0]!.url);
        expect(url.origin + url.pathname).toBe("http://api.example/widget/query");
        expect(url.searchParams.get("q")).toBe(stringify(payload));
        expect(calls[0]?.init?.body).toBeUndefined();
    });

    it("sends a DELETE call's argument as the query parameter", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("DELETE", "/widget", [{ id: "a" }]));

        expect(new URL(calls[0]!.url).searchParams.get("q")).toBe(stringify([{ id: "a" }]));
    });

    it("sends a POST call's argument as the body", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("POST", "/widget", [payload]));

        expect(calls[0]?.url).toBe("http://api.example/widget");
        expect(calls[0]?.init?.method).toBe("POST");
        expect(calls[0]?.init?.body).toBe(stringify([payload]));
    });

    it("sends a PATCH call's argument as the body", async () => {
        const { http, calls } = client(stringify(null));

        await exec(http, call("PATCH", "/widget", []));

        expect(calls[0]?.init?.method).toBe("PATCH");
    });

    it("decodes the result, restoring a Date and a bigint", async () => {
        const { http } = client(stringify([payload]));

        const rows = await exec(http, call<(typeof payload)[]>("GET", "/widget/query", {}));

        expect(rows).toEqual([payload]);
    });
});

describe("groups", () => {
    it("posts a batch to the group path as a tree of calls", async () => {
        const { http, calls } = client(stringify([null, null]));

        await exec(http, batch(call<void>("POST", "/widget", [1]), call<void>("POST", "/other", [2])));

        expect(calls[0]?.url).toBe(`http://api.example${GROUP_PATH}`);
        expect(calls[0]?.init?.method).toBe("POST");
        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    { call: { method: "POST", path: "/widget", argument: [1] } },
                    { call: { method: "POST", path: "/other", argument: [2] } },
                ],
            },
        });
    });

    it("marks a transaction group, and nests the two kinds", async () => {
        const { http, calls } = client(stringify([[null], null]));

        await exec(
            http,
            batch(
                transaction(call<void>("POST", "/widget", [])),
                call<void>("POST", "/other", []),
            ),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    {
                        group: {
                            kind: "transaction",
                            calls: [{ call: { method: "POST", path: "/widget", argument: [] } }],
                        },
                    },
                    { call: { method: "POST", path: "/other", argument: [] } },
                ],
            },
        });
    });

    it("nests a transaction inside a transaction, keeping both result levels", async () => {
        const { http, calls } = client(stringify([[null, null], [{ id: "r" }]]));

        const [writes, rows] = await exec(
            http,
            transaction(
                transaction(call<void>("POST", "/widget", []), call<void>("POST", "/other", [])),
                call<{ id: string }[]>("GET", "/widget/query", {}),
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
                                { call: { method: "POST", path: "/widget", argument: [] } },
                                { call: { method: "POST", path: "/other", argument: [] } },
                            ],
                        },
                    },
                    { call: { method: "GET", path: "/widget/query", argument: {} } },
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
                transaction(call<string[]>("POST", "/widget", [])),
                call<string>("POST", "/other", []),
            ),
        );

        expect(inner).toEqual(["inner"]);
        expect(outer).toBe("outer");
    });

    it("carries a bundle under its keys, in order", async () => {
        const { http, calls } = client(stringify([null, null]));

        await exec(
            http,
            bundle({
                first: call<void>("POST", "/widget", [1]),
                second: call<void>("POST", "/other", [2]),
            }),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    { call: { method: "POST", path: "/widget", argument: [1] } },
                    { call: { method: "POST", path: "/other", argument: [2] } },
                ],
            },
        });
    });

    it("marks an attempt group, and keeps its recovery shape", async () => {
        const { http, calls } = client(stringify([{ ok: false, error: { message: "boom", path: [0] } }]));

        const [outcome] = await exec(
            http,
            batch(attempt(call<void>("POST", "/widget", [1]))),
        );

        expect(sentBody(calls[0]!)).toEqual({
            group: {
                kind: "batch",
                calls: [
                    {
                        group: {
                            kind: "attempt",
                            calls: [{ call: { method: "POST", path: "/widget", argument: [1] } }],
                        },
                    },
                ],
            },
        });
        expect(outcome).toEqual({ ok: false, error: { message: "boom", path: [0] } });
    });

    it("raises an HttpError naming the entry that failed", async () => {
        const { http } = client(JSON.stringify({ error: "version conflict", path: [1, 0] }), 409);

        const failure = await exec(http, transaction(call<void>("POST", "/widget", []))).catch(
            (thrown: unknown) => thrown,
        );

        expect(failure).toBeInstanceOf(HttpError);
        expect((failure as HttpError).status).toBe(409);
        expect((failure as HttpError).path).toEqual([1, 0]);
    });

    it("reports no path for a failure that is not a group's", async () => {
        const { http } = client(JSON.stringify({ error: "version conflict" }), 409);

        const failure = await exec(http, call<void>("PATCH", "/widget", [])).catch(
            (thrown: unknown) => thrown,
        );

        expect((failure as HttpError).path).toBeUndefined();
    });
});

describe("the result type", () => {
    /** Never called: each annotation below is the assertion, checked by `tsc --noEmit`. */
    function assertTypes(): void {
        const http = undefined as unknown as HttpClient;
        const row = call<{ id: string }[]>("GET", "/widget/query", {});
        const write = call<void>("POST", "/widget", []);

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

        // A generated builder is generic in what it selects, so its result must still
        // narrow by position once it is inside a group.
        const selected: Promise<[void, Pick<Widget, "id">[]]> = exec(
            http,
            transaction(write, selectWidget({ select: { id: true } })),
        );

        void [single, allVoid, mixed, nested, tolerated, toleratedRows, selected];
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
