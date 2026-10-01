/** End-to-end smoke test: a seeded server answers the generated reads over HTTP. See docs/mockdata.md. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { parse as decode, stringify as encode } from "devalue";
import { mockTables } from "spec/mockdata/index.ts";
import { startServer } from "./main.ts";

/** `InvoiceRow` -> `invoice_row`, the `@table` default the REST path is built from. */
function tablePath(entity: string): string {
    return `/${entity.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}/query`;
}

describe("seeded server", () => {
    it("round-trips every mock table through its list route", async () => {
        const counts = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const started = yield* startServer({ port: 0, seed: true });
                    const client = yield* HttpClient.HttpClient;
                    const result: Record<string, number> = {};
                    for (const { entity } of mockTables) {
                        const q = encodeURIComponent(encode({ select: {} }));
                        const url = `http://127.0.0.1:${started.port}${tablePath(entity)}?q=${q}`;
                        const response = yield* client.execute(HttpClientRequest.get(url));
                        const body = decode(yield* response.text);
                        result[entity] = Array.isArray(body) ? body.length : -1;
                    }
                    return result;
                }).pipe(Effect.provide(FetchHttpClient.layer)),
            ) as Effect.Effect<Record<string, number>, never>,
        );

        for (const { entity, rows } of mockTables) {
            expect(counts[entity], entity).toBe(rows.length);
        }
    });
});
