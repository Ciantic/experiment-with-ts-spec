/**
 * Unit tests for the Effect router, driven by a hand-built route table and the
 * real `effect/http` server. See docs/rest-api-effect.md.
 *
 * The routes are fixtures, so the test exercises decoding, validation, the
 * `devalue` round trip, and status mapping — not the domain.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServer from "effect/http/HttpServer";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { NodeHttpServer } from "@effect/platform-node";
import { parse as decode, stringify as encode } from "devalue";
import { createRouter, type Route } from "./router.ts";

/** A handler's failure: the router reads `.reason._tag` and `.message`, so a plain object suffices. */
function sqlError(reason: string, message: string): SqlError {
    return { _tag: "SqlError", reason: { _tag: reason }, message } as unknown as SqlError;
}

/** A query route: its argument arrives in `q`, validated by a strict struct. */
const queryInput = Schema.Struct({
    id: Schema.optionalKey(Schema.Array(Schema.String)),
    name: Schema.optionalKey(Schema.String),
});

const bodyInput = Schema.Struct({ id: Schema.String, name: Schema.String });

const routes: Route[] = [
    {
        method: "GET",
        path: "/widget/query",
        source: "query",
        input: queryInput,
        handler: (argument) => Effect.succeed({ received: argument }),
    },
    {
        method: "POST",
        path: "/widget",
        source: "body",
        input: bodyInput,
        handler: (argument) =>
            // A Date and a bigint prove the codec survives the wire.
            Effect.succeed({ ...(argument as object), at: new Date("2026-01-05T00:00:00.000Z"), version: 5n }),
    },
    {
        method: "POST",
        path: "/widget/fail",
        source: "body",
        input: bodyInput,
        handler: () => Effect.fail(sqlError("UniqueViolation", "duplicate key")),
    },
    {
        method: "DELETE",
        path: "/widget",
        source: "query",
        input: Schema.Array(Schema.Struct({ id: Schema.String })),
        handler: () => Effect.void,
    },
];

/** The server effect under test, plus a dummy `SqlClient` the fixture handlers never use. */
const serve = HttpServer.serveEffect(createRouter(routes));
const layer = Layer.mergeAll(
    NodeHttpServer.layerTest,
    Layer.succeed(SqlClient, {} as unknown as SqlClient),
);

/** Run a client program against the served routes. */
function withServer<A>(program: (client: HttpClient.HttpClient) => Effect.Effect<A, unknown, unknown>): Promise<A> {
    const effect = Effect.gen(function* () {
        yield* Effect.forkScoped(serve);
        const client = yield* HttpClient.HttpClient;
        return yield* program(client);
    });
    return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<A, never>);
}

/** A `q` parameter carrying a `devalue` value. */
function q(value: unknown): string {
    return encodeURIComponent(encode(value));
}

describe("the router", () => {
    it("decodes a query argument and encodes the result with devalue", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(HttpClientRequest.get(`/widget/query?q=${q({ id: ["a", "b"] })}`));
                const body = yield* response.text;
                return { status: response.status, body: decode(body) };
            }),
        );

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ received: { id: ["a", "b"] } });
    });

    it("round-trips a Date and a bigint through the codec", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(
                    HttpClientRequest.post("/widget").pipe(
                        HttpClientRequest.setBody(HttpBody.text(encode({ id: "x", name: "n" }), "application/json")),
                    ),
                );
                const body = yield* response.text;
                return decode(body) as { at: unknown; version: unknown };
            }),
        );

        expect(result.at).toBeInstanceOf(Date);
        expect(result.at).toEqual(new Date("2026-01-05T00:00:00.000Z"));
        expect(result.version).toBe(5n);
    });

    it("returns 404 for an unknown route", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(HttpClientRequest.get("/nope"));
                return { status: response.status, body: yield* response.text };
            }),
        );

        expect(result.status).toBe(404);
        expect(JSON.parse(result.body)).toEqual({ error: "no route" });
    });

    it("returns 400 when the argument does not validate", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(
                    HttpClientRequest.post("/widget").pipe(
                        HttpClientRequest.setBody(HttpBody.text(encode({ id: "x" }), "application/json")),
                    ),
                );
                return { status: response.status, body: JSON.parse(yield* response.text) };
            }),
        );

        expect(result.status).toBe(400);
        expect(result.body.error).toBe("invalid request");
    });

    it("rejects an unknown key, so select is a validator", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(
                    HttpClientRequest.post("/widget").pipe(
                        HttpClientRequest.setBody(
                            HttpBody.text(encode({ id: "x", name: "n", extra: true }), "application/json"),
                        ),
                    ),
                );
                return response.status;
            }),
        );

        expect(result).toBe(400);
    });

    it("returns 400 for an argument that is not decodable", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(HttpClientRequest.get("/widget/query?q=%5B"));
                return response.status;
            }),
        );

        expect(result).toBe(400);
    });

    it("maps a classified SqlError to its status", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(
                    HttpClientRequest.post("/widget/fail").pipe(
                        HttpClientRequest.setBody(HttpBody.text(encode({ id: "x", name: "n" }), "application/json")),
                    ),
                );
                return { status: response.status, body: JSON.parse(yield* response.text) };
            }),
        );

        expect(result.status).toBe(409);
        expect(result.body).toEqual({ error: "duplicate key" });
    });

    it("encodes a void result as null", async () => {
        const result = await withServer((client) =>
            Effect.gen(function* () {
                const response = yield* client.execute(
                    HttpClientRequest.make("DELETE")(`/widget?q=${q([{ id: "x" }])}`),
                );
                const body = yield* response.text;
                return { status: response.status, body: decode(body) };
            }),
        );

        expect(result.status).toBe(200);
        expect(result.body).toBeNull();
    });
});
