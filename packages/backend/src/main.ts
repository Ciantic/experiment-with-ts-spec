/** The backend entry point: run an API server, optionally seeded with mock data. See docs/mockdata.md. */
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createAppContext, type AppOptions, type ServerDatabase } from "./context.ts";
import { UsageError } from "./errors.ts";
import { createApiServer } from "./http/server.ts";
import { seedMockData } from "./mock/seed.ts";

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** Listen on `port`; `0` picks a free one. Resolves with the bound port. */
function listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : port);
        });
    });
}

/** How a server is started. */
export interface StartOptions extends AppOptions {
    port?: number;
    seed?: boolean;
}

/** A running server and the database behind it. */
export interface StartedServer {
    server: Server;
    db: ServerDatabase;
    port: number;
}

/** Build the database, optionally seed it, and start the API server over it. */
export async function startServer(options: StartOptions = {}): Promise<StartedServer> {
    const app = await createAppContext(options);
    if (options.seed) {
        await seedMockData(app.database);
    }
    const server = createApiServer(app);
    const port = await listen(server, options.port ?? DEFAULT_PORT);
    return { server, db: app.database, port };
}

/**
 * Read `--port <n>`, `--seed` (alias `--mock`), and `--log-sql` from the command line.
 * @throws {UsageError} when `--port` has no integer beside it
 */
export function parseArgs(argv: string[]): StartOptions {
    const options: StartOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--seed" || arg === "--mock") {
            options.seed = true;
        } else if (arg === "--log-sql") {
            options.logSql = true;
        } else if (arg === "--port") {
            const value = argv[index + 1];
            if (value === undefined || !Number.isInteger(Number(value))) {
                throw new UsageError("--port needs an integer");
            }
            options.port = Number(value);
            index += 1;
        }
    }
    return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const options = parseArgs(process.argv.slice(2));
    const started = await startServer(options);
    console.log(`api listening on http://127.0.0.1:${started.port}${options.seed ? " (mock data seeded)" : ""}`);
}
