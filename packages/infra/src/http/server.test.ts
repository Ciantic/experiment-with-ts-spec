/** Unit tests for the hand-written server, over a stub driver and one echo route. See docs/testing.md. */
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.ts";
import { SqlDriver, type SqlConnection } from "../db/sql-driver.ts";
import type { Route } from "./router.ts";
import { ApiServer } from "./server.ts";

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

    it("closes before it ever listened", async () => {
        const server = new ApiServer(createApp(), []);

        await expect(server.close()).resolves.toBeUndefined();
    });
});
