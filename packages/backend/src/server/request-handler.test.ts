/** Tests the framework-free GraphQL-over-HTTP handler with a fixture schema. See docs/testing.md. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";
import { createRequestHandler } from "./request-handler.js";

// A schema built in the test, so the handler is exercised without the generated domain schema.
const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
        name: "Query",
        fields: {
            hello: {
                type: GraphQLString,
                args: { name: { type: GraphQLString } },
                resolve: (_source, args: { name?: string }) => `hello ${args.name ?? "world"}`,
            },
        },
    }),
});

let server: Server;
let endpoint: string;

beforeAll(async () => {
    const handler = createRequestHandler({ schema, context: () => ({}) });
    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the GraphQL handler", () => {
    it("executes a POSTed JSON query", async () => {
        const response = await fetch(`${endpoint}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ hello }" }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ data: { hello: "hello world" } });
    });

    it("passes variables through", async () => {
        const response = await fetch(`${endpoint}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "query ($n: String) { hello(name: $n) }", variables: { n: "there" } }),
        });

        expect(await response.json()).toEqual({ data: { hello: "hello there" } });
    });

    it("executes a GET query from the query string", async () => {
        const response = await fetch(`${endpoint}/graphql?query=${encodeURIComponent("{ hello }")}`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ data: { hello: "hello world" } });
    });

    it("accepts a bare document as an application/graphql body", async () => {
        const response = await fetch(`${endpoint}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/graphql" },
            body: "{ hello }",
        });

        expect(await response.json()).toEqual({ data: { hello: "hello world" } });
    });

    it("rejects malformed JSON with 400", async () => {
        const response = await fetch(`${endpoint}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{ not json",
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toHaveProperty("errors");
    });

    it("reports an execution error inside a 200 response", async () => {
        const response = await fetch(`${endpoint}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ missing }" }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toHaveProperty("errors");
    });

    it("answers 405 for an unsupported method on /graphql", async () => {
        const response = await fetch(`${endpoint}/graphql`, { method: "PUT", body: "{}" });

        expect(response.status).toBe(405);
    });

    it("serves the SDL at /schema", async () => {
        const response = await fetch(`${endpoint}/schema`);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("hello");
    });

    it("serves the playground at /", async () => {
        const response = await fetch(`${endpoint}/`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
    });

    it("serves a self-contained playground, with no external resources", async () => {
        const html = await (await fetch(`${endpoint}/`)).text();

        expect(html).toContain("GraphQL playground");
        // No CDN: the page must work offline and cannot break behind a third party's back.
        expect(html).not.toContain("http://");
        expect(html).not.toContain("https://");
    });

    it("answers 404 for an unknown route", async () => {
        const response = await fetch(`${endpoint}/nope`);

        expect(response.status).toBe(404);
    });

    it("can disable the playground", async () => {
        const handler = createRequestHandler({ schema, context: () => ({}), playground: false });
        const bare = createServer((request, response) => {
            void handler(request, response);
        });
        await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
        const address = bare.address() as AddressInfo;

        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(response.status).toBe(404);

        await new Promise<void>((resolve) => bare.close(() => resolve()));
    });
});
