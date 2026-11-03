/** Driver-agnostic command line reading shared by the entries. See docs/entrypoints.md. */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The port used when `--port` is absent. */
export const DEFAULT_PORT = 3000;

/** The flags a server starts with. */
export interface ServerOptions {
    port?: number;
    seed?: boolean;
}

/** The flags an entry reads; the last three belong to a driver, so a server ignores them. */
export interface CliOptions extends ServerOptions {
    logSql?: boolean;
    databaseUrl?: string;
    dataDir?: string;
}

/** The usage text `--help` and `-h` print. */
export const HELP = [
    "Usage: <entry point> [options]",
    "",
    "Options:",
    "  --port <n>             port to listen on (default 3000)",
    "  --seed, --mock         apply the schema and seed the mock data (PGlite seeds by default)",
    "  --log-sql              log every statement PGlite runs",
    "  --database-url <url>   Postgres connection string (defaults to DATABASE_URL)",
    "  --data-dir <path>      directory PGlite persists to",
    "  --help, -h             print this help",
].join("\n");

/** The shared flags, so `parseArgs` rejects anything it does not know. */
const CLI_FLAGS = {
    port: { type: "string" },
    seed: { type: "boolean" },
    mock: { type: "boolean" },
    "log-sql": { type: "boolean" },
    "database-url": { type: "string" },
    "data-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/** Read the flags over `defaults`, printing the help or the bad command line's message and exiting instead of returning. */
export function parseServerArgs(argv: readonly string[], defaults: ServerOptions = {}): CliOptions {
    let values;
    try {
        ({ values } = parseArgs({ args: argv, options: CLI_FLAGS, strict: true, allowPositionals: false }));
    } catch (thrown) {
        console.error(thrown instanceof Error ? thrown.message : String(thrown));
        process.exit(1);
    }
    if (values.help === true) {
        console.log(HELP);
        process.exit(0);
    }
    const options: CliOptions = { ...defaults };
    if (values.seed === true || values.mock === true) {
        options.seed = true;
    }
    const port = values.port;
    if (port !== undefined) {
        if (!/^\d+$/.test(port)) {
            console.error("--port needs an integer");
            process.exit(1);
        }
        options.port = Number(port);
    }
    if (values["log-sql"] === true) {
        options.logSql = true;
    }
    const databaseUrl = values["database-url"];
    if (databaseUrl !== undefined) {
        options.databaseUrl = databaseUrl;
    }
    const dataDir = values["data-dir"];
    if (dataDir !== undefined) {
        options.dataDir = dataDir;
    }
    return options;
}
