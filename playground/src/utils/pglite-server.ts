/** The in-memory environment: a PGlite server this process owns, or one already listening on the playground port. */
import { createConnection } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { ApiServer, PgliteSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import { ApiClient } from "sdk/http.ts";
import { routes, withoutGuards } from "../../../packages/backend/src/routes.ts";
import type { Examples, PlaygroundServer } from "./environment.ts";
import { runWith } from "./environment.ts";

/** The port the PGlite playground serves on, so a server you started yourself can be reused. */
const PLAYGROUND_PORT = 3000;

/** Whether anything already accepts connections on the loopback port. */
async function isListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** Serve a seeded in-memory database, or reuse the server already listening on the playground port. */
export async function startPgliteServer(): Promise<PlaygroundServer> {
    if (await isListening(PLAYGROUND_PORT)) {
        return { http: new ApiClient(`http://127.0.0.1:${PLAYGROUND_PORT}`), close: async () => {} };
    }
    const driver = new PgliteSqlDriver(PGlite);
    await applySchema(driver);
    await seedMockData(driver.createExecutor());
    const server = new ApiServer(createAppContext({ driver }), withoutGuards(routes));
    const port = await server.listen(PLAYGROUND_PORT);
    return {
        http: new ApiClient(`http://127.0.0.1:${port}`),
        close: async () => {
            await server.close();
            await driver.close();
        },
    };
}

/** The Pglite environment as a describe body. */
export function runWithPglite(examples: Examples): () => void {
    return runWith(startPgliteServer, examples);
}
