/** Unit tests for the hand-written transport, over a stub `fetch`. See docs/testing.md. */
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { createHttpClient, HttpError } from "./http.js";

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

/** A value with both of the types a JSON encoding would lose. */
const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

describe("createHttpClient.query", () => {
    it("joins the base url, the path, and the encoded argument", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example/", stub.impl);

        await http.query("GET", "/widget/query", payload);

        const url = new URL(stub.calls[0]!.url);
        expect(url.origin + url.pathname).toBe("http://api.example/widget/query");
        expect(url.searchParams.get("q")).toBe(stringify(payload));
    });

    it("round-trips through URLSearchParams, as the server reads it", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        await http.query("GET", "/widget/query", payload);

        const encoded = new URL(stub.calls[0]!.url).searchParams.get("q");
        expect(parse(encoded!)).toEqual(payload);
    });

    it("sends no body and no content type", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        await http.query("GET", "/widget/query", payload);

        expect(stub.calls[0]?.init?.body).toBeUndefined();
        expect(stub.calls[0]?.init?.headers).toBeUndefined();
        expect(stub.calls[0]?.init?.method).toBe("GET");
    });

    it("omits the parameter when there is no argument", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        await http.query("DELETE", "/widget");

        expect(stub.calls[0]?.url).toBe("http://api.example/widget");
    });
});

describe("createHttpClient.send", () => {
    it("sends the body as devalue under the json content type", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        await http.send("POST", "/widget", [payload]);

        expect(stub.calls[0]?.url).toBe("http://api.example/widget");
        expect(stub.calls[0]?.init?.body).toBe(stringify([payload]));
        expect(stub.calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    });

    it("carries the verb through", async () => {
        const stub = stubFetch(new Response(stringify(null), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        await http.send("PATCH", "/widget", []);

        expect(stub.calls[0]?.init?.method).toBe("PATCH");
    });
});

describe("createHttpClient responses", () => {
    it("decodes a response, restoring a Date and a bigint", async () => {
        const stub = stubFetch(new Response(stringify(payload), { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        const result = await http.query("GET", "/widget/query", {});

        expect(result).toEqual(payload);
    });

    it("resolves undefined when the response carries no body", async () => {
        const stub = stubFetch(new Response("", { status: 200 }));
        const http = createHttpClient("http://api.example", stub.impl);

        expect(await http.send("POST", "/widget", [])).toBeUndefined();
    });

    it("throws an HttpError carrying the parsed error body", async () => {
        const stub = stubFetch(
            new Response(JSON.stringify({ error: "version conflict" }), { status: 409 }),
        );
        const http = createHttpClient("http://api.example", stub.impl);

        const failure = await http.send("PATCH", "/widget", []).catch((thrown: unknown) => thrown);

        expect(failure).toBeInstanceOf(HttpError);
        expect((failure as HttpError).status).toBe(409);
        expect((failure as HttpError).body).toEqual({ error: "version conflict" });
    });

    it("keeps a non-JSON error body as text", async () => {
        const stub = stubFetch(new Response("upstream is down", { status: 502 }));
        const http = createHttpClient("http://api.example", stub.impl);

        const failure = await http.query("GET", "/widget/query", {}).catch((thrown: unknown) => thrown);

        expect((failure as HttpError).body).toBe("upstream is down");
    });
});
