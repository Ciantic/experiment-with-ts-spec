/** The in-memory environment: a PGlite server this process owns, or one already listening on the playground port. */
import { PGlite } from "@electric-sql/pglite";
import { ApiServer, PgliteSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import { ApiClient } from "sdk/http.ts";
import { routes, withoutGuards } from "../../../packages/backend/src/routes.ts";
import { PlaygroundServer, ReusedServer, type Examples } from "./environment.ts";
import { runWith } from "./environment.ts";
import { acceptsConnections } from "./ports.ts";

/** The port the PGlite playground serves on, so a server you started yourself can be reused. */
const PLAYGROUND_PORT = 3000;

/** A PGlite server this process started, with the driver and API server its close releases. */
class PgliteServer extends PlaygroundServer {
    readonly #server: ApiServer;
    readonly #driver: PgliteSqlDriver;

    private constructor(http: ApiClient, server: ApiServer, driver: PgliteSqlDriver) {
        super(http);
        this.#server = server;
        this.#driver = driver;
    }

    /** Serve a seeded in-memory database, or reuse the server already listening on the playground port. */
    static async start(): Promise<PlaygroundServer> {
        if (await acceptsConnections(PLAYGROUND_PORT)) {
            return new ReusedServer(new ApiClient(`http://127.0.0.1:${PLAYGROUND_PORT}`));
        }
        const driver = new PgliteSqlDriver(PGlite);
        await applySchema(driver);
        await seedMockData(driver.createExecutor());
        const server = new ApiServer(createAppContext({ driver }), withoutGuards(routes));
        const port = await server.listen(PLAYGROUND_PORT);
        return new PgliteServer(new ApiClient(`http://127.0.0.1:${port}`), server, driver);
    }

    async close(): Promise<void> {
        await this.#server.close();
        await this.#driver.close();
    }
}

/** The Pglite environment as a describe body. */
export function runWithPglite(examples: Examples): () => void {
    return runWith(PgliteServer.start, examples);
}
