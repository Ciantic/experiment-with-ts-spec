/** What every playground environment shares: a client for its server, the examples, and the describe body joining them. */
import { afterAll, beforeAll } from "vitest";
import type { ApiClient } from "sdk/http.ts";

/** The server an environment started, or reused, and the teardown of everything its launch opened. */
export interface PlaygroundServer {
    /** The client for the server the environment started, or reused. */
    http: ApiClient;
    /** Stop the server and release everything the environment opened. */
    close: () => Promise<void>;
}

/** The `it` blocks a describe registers, asked for the client of the server it started. */
export type Examples = (getHttp: () => ApiClient) => void;

/** Start the server, register the examples over its client, then close it; the body of a playground describe. */
export function runWith(start: () => Promise<PlaygroundServer>, examples: Examples): () => void {
    return () => {
        let server: PlaygroundServer;

        beforeAll(async () => {
            server = await start();
        }, 180_000);

        afterAll(async () => {
            await server.close();
        }, 60_000);

        examples(() => server.http);
    };
}
