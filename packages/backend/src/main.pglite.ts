/** The PGlite entry point: a server over an in-memory database, for development and tests. See docs/entrypoints.md. */
import { PGlite } from "@electric-sql/pglite";
import { ApiServer, PgliteSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import { routes } from "./routes.ts";
import { parseServerArgs } from "./args.pglite.ts";

/** Read the flags, then serve over a fresh in-memory database, schema applied and seeded by default. */
async function main(): Promise<void> {
    const options = parseServerArgs(process.argv.slice(2));
    const driver = new PgliteSqlDriver(PGlite, {
        debug: options.logSql === true ? 1 : 0,
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    });
    if (options.schema) {
        await applySchema(driver);
    }
    if (options.seed) {
        await seedMockData(driver.createExecutor());
    }
    const app = createAppContext({ driver });
    const server = new ApiServer(app, routes);
    const port = await server.listen(options.port);
    console.log(`api listening on http://127.0.0.1:${port}${options.seed ? " (mock data seeded)" : ""}`);
}

await main();
