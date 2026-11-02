/** Unit tests for the hand-written server, over a stub driver and one echo route. See docs/testing.md. */
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "sdk/errors.ts";
import type { AppContext } from "../context.ts";
import { SqlDriver, type SqlConnection } from "../db/sql-driver.ts";
import { ApiHttpResponse } from "./api-http-response.ts";
import type { Route } from "./router.ts";
import { ApiServer } from "./server.ts";
import { SseStream } from "./sse.ts";

/** A driver over no database; the tests exercise the HTTP path, not a statement. */
class StubDriver extends SqlDriver {
    async query<Row extends object = Record<string, unknown>>(): Promise<{
        rows: Row[];
        rowCount: number | null;
    }> {
        return { rows: [], rowCount: null };
    }

    async connect(): Promise<SqlConnection> {
        return {
            query: <Row extends object = Record<string, unknown>>() => this.query<Row>(),
            release: () => {},
        };
    }

    async exec(): Promise<void> {}

    protected async listen(): Promise<{ close(): Promise<void> }> {
        return { close: async () => {} };
    }

    protected async shutdown(): Promise<void> {}
}

/** A route that echoes its argument, so the round-trip through the server is observable. */
const echoRoute: Route = {
    id: "echo",
    method: "POST",
    path: "/echo",
    source: "body",
    input: { safeParse: (value) => ({ success: true, data: value }) },
    handler: async (_ctx, argument) => argument,
};

/** A stream that yields one change and ends. */
const watchRoute: Route = {
    id: "watch",
    method: "GET",
    path: "/watch",
    source: "query",
    stream: true,
    input: { safeParse: (value) => ({ success: true, data: value }) },
    handler: async () =>
        new SseStream(() =>
            (async function* () {
                yield { op: "INSERT" };
            })(),
        ),
};

/** A route that answers with a response value instead of a value the server encodes. */
const responseRoute: Route = {
    id: "gone",
    method: "GET",
    path: "/gone",
    source: "query",
    input: { safeParse: (value) => ({ success: true, data: value }) },
    handler: async () => ApiHttpResponse.failure(new NotFoundError("gone")),
};

/** The context startup builds, over the stub driver. */
function createApp(): AppContext {
    return { driver: new StubDriver() };
}

describe("ApiServer", () => {
    it("answers a matched route on the port it listened on", async () => {
        const server = new ApiServer(createApp(), [echoRoute]);
        const port = await server.listen(0);
        const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

        try {
            const response = await fetch(`http://127.0.0.1:${port}/echo`, {
                method: "POST",
                body: stringify(payload),
                headers: { connection: "close" },
            });

            expect(response.status).toBe(200);
            expect(parse(await response.text())).toEqual(payload);
        } finally {
            await server.close();
        }
    });

    it("writes an event stream and ends it", async () => {
        const server = new ApiServer(createApp(), [watchRoute]);
        const port = await server.listen(0);

        try {
            const response = await fetch(`http://127.0.0.1:${port}/watch`, {
                headers: { connection: "close" },
            });

            expect(response.headers.get("content-type")).toBe("text/event-stream");
            expect(await response.text()).toBe(`data: ${stringify({ op: "INSERT" })}\n\n`);
        } finally {
            await server.close();
        }
    });

    it("writes a response value a route returns itself", async () => {
        const server = new ApiServer(createApp(), [responseRoute]);
        const port = await server.listen(0);

        try {
            const response = await fetch(`http://127.0.0.1:${port}/gone`, {
                headers: { connection: "close" },
            });

            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: "gone", kind: "not-found" });
        } finally {
            await server.close();
        }
    });

    it("encodes a value that has a writeTo field, since only the class marks a writable", async () => {
        const server = new ApiServer(createApp(), [echoRoute]);
        const port = await server.listen(0);
        const payload = { writeTo: "not a function" };

        try {
            const response = await fetch(`http://127.0.0.1:${port}/echo`, {
                method: "POST",
                body: stringify(payload),
                headers: { connection: "close" },
            });

            expect(response.status).toBe(200);
            expect(parse(await response.text())).toEqual(payload);
        } finally {
            await server.close();
        }
    });

    it("closes before it ever listened", async () => {
        const server = new ApiServer(createApp(), []);

        await expect(server.close()).resolves.toBeUndefined();
    });
});
