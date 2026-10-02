/** End-to-end smoke test: the generated client talks to the seeded server. See docs/mockdata.md. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as api from "sdk/index.ts";
import type { HttpClient } from "sdk/http.ts";
import { mockTables } from "spec/mockdata/index.ts";
import { startServer, type StartedServer } from "./main.ts";

/** A generated `query<Entity>` call, seen through the client. */
type QueryFn = (http: HttpClient, opts: { select: Record<string, never> }) => Promise<unknown[]>;

let started!: StartedServer;
let http!: HttpClient;

beforeAll(async () => {
    started = await startServer({ port: 0, seed: true });
    http = api.createHttpClient(`http://127.0.0.1:${started.port}`);
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
    });
    await started.db.close();
});

describe("seeded server", () => {
    it("round-trips every mock table through its generated client call", async () => {
        const calls = api as unknown as Record<string, QueryFn | undefined>;

        for (const { entity, rows } of mockTables) {
            const query = calls[`query${entity}`];
            expect(query, `query${entity} is generated`).toBeTypeOf("function");

            const result = await query?.(http, { select: {} });

            expect(result, entity).toHaveLength(rows.length);
        }
    });
});
