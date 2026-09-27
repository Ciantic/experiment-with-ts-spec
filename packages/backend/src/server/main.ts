/** Start the GraphQL dev server over an in-memory database. See docs/graphql.md. */
import { createServer } from "node:http";
import { createContext, schema } from "../graphql/index.js";
import { createInMemoryDatabase } from "./in-memory-database.js";
import { createRequestHandler } from "./request-handler.js";

/** Read `--name value` from the arguments, falling back to an environment variable. */
function readOption(name: string, environment: string, fallback: string): string {
    const index = process.argv.indexOf(name);
    if (index !== -1 && process.argv[index + 1] !== undefined) {
        return process.argv[index + 1] as string;
    }
    return process.env[environment] ?? fallback;
}

async function main(): Promise<void> {
    if (process.argv.includes("--help")) {
        console.log("usage: node src/server/main.ts [--port 4000] [--host 127.0.0.1] [--no-playground]");
        return;
    }

    const port = Number(readOption("--port", "PORT", "4000"));
    const host = readOption("--host", "HOST", "127.0.0.1");
    const playground = !process.argv.includes("--no-playground");

    const database = await createInMemoryDatabase();
    // One context per request, so the DataLoaders never outlive an operation.
    const handler = createRequestHandler({
        schema,
        context: () => createContext(database),
        playground,
    });

    const server = createServer((request, response) => {
        void handler(request, response);
    });

    server.listen(port, host, () => {
        console.log(`GraphQL endpoint: http://${host}:${port}/graphql`);
        console.log(`Schema SDL:       http://${host}:${port}/schema`);
        if (playground) {
            console.log(`Playground:       http://${host}:${port}/`);
        }
        console.log("The database is in memory and empty; the tables follow schema.sql.");
    });

    process.on("SIGINT", () => {
        server.close(() => process.exit(0));
    });
}

if (import.meta.main) {
    await main();
}
