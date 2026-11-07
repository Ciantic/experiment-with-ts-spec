/** The command line the `pglite` entry reads, a server over an in-memory PGlite. See docs/entrypoints.md. */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** The flags the `pglite` entry reads, with the port, schema and seed always resolved. */
interface CliOptions {
    port: number;
    schema: boolean;
    seed: boolean;
    withoutAuth?: boolean;
    logSql?: boolean;
    dataDir?: string;
}

/** The usage text `--help` and `-h` print. */
export const HELP = [
    "Usage: <pglite entry point> [options]",
    "",
    "Options:",
    "  --port <n>             port to listen on (default 3000)",
    "  --no-schema            skip applying the generated schema",
    "  --no-mock              skip inserting the mock data",
    "  --without-auth         serve with every route guard removed",
    "  --log-sql              log every statement PGlite runs",
    "  --data-dir <path>      directory PGlite persists to",
    "  --help, -h             print this help",
].join("\n");

/** The flags, so `parseArgs` rejects anything it does not know. */
const CLI_FLAGS = {
    port: { type: "string" },
    "no-schema": { type: "boolean" },
    "no-mock": { type: "boolean" },
    "without-auth": { type: "boolean" },
    "log-sql": { type: "boolean" },
    "data-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/** Read the flags, printing the help or the bad command line's message and exiting instead of returning. */
export function parseServerArgs(argv: readonly string[]): CliOptions {
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
    const options: CliOptions = { port: DEFAULT_PORT, schema: true, seed: true };
    if (values["no-schema"] === true) {
        options.schema = false;
    }
    if (values["no-mock"] === true) {
        options.seed = false;
    }
    if (values["without-auth"] === true) {
        options.withoutAuth = true;
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
    const dataDir = values["data-dir"];
    if (dataDir !== undefined) {
        options.dataDir = dataDir;
    }
    return options;
}
