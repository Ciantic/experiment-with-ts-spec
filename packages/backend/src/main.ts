/** The backend entry point: run an API server, optionally seeded with mock data. See docs/mockdata.md. */
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
    ApiServer,
    createAppContext,
    PgliteSqlDriver,
    seedMockData,
    UsageError,
    type AppContext,
    type HttpServer,
} from "infra";
import { routes } from "./http/routes/index.ts";

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** How a server is started. */
export interface StartOptions {
    port?: number;
    seed?: boolean;
    /** Let PGlite print every statement it runs, the transaction boundaries it issues included. */
    logSql?: boolean;
}

/** A running server and the context behind it. */
export interface StartedServer {
    server: HttpServer;
    app: AppContext;
    port: number;
}

/** Build the database, optionally seed it, and start the API server over it. */
export async function startServer(options: StartOptions = {}): Promise<StartedServer> {
    // The process is the composition root: it picks PGlite and hands infra the driver.
    const driver = new PgliteSqlDriver(PGlite, options.logSql ? { debug: 1 } : {});
    const app = await createAppContext({ driver });
    if (options.seed) {
        await seedMockData(app.driver.createExecutor());
    }
    const server = new ApiServer(app, routes);
    const port = await server.listen(options.port ?? DEFAULT_PORT);
    return { server, app, port };
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
