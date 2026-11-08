/** The PGlite entry point: a server over an in-memory database, for development and tests. See docs/entrypoints.md. */
import { PGlite } from "@electric-sql/pglite";
import { ApiServer, AppContext, PgliteSqlDriver, applySchema, seedMockData } from "infra";
import { routes, withoutGuards } from "./routes.ts";
import { parseServerArgs } from "./args.pglite.ts";

/** Read the flags, then serve over a fresh in-memory database, schema applied and seeded by default. */
async function main(): Promise<void> {
    const options = parseServerArgs(process.argv.slice(2));
    const app = new AppContext({
        driver: () =>
            new PgliteSqlDriver(PGlite, {
                debug: options.logSql === true ? 1 : 0,
                ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
            }),
    });
    if (options.schema) {
        await applySchema(app.driver);
    }
    if (options.seed) {
        await seedMockData(app.driver.createExecutor());
    }
    const server = new ApiServer(app, options.withoutAuth === true ? withoutGuards(routes) : routes);
    const port = await server.listen(options.port);
    console.log(
        `api listening on http://127.0.0.1:${port}` +
            `${options.seed ? " (mock data seeded)" : ""}${options.withoutAuth === true ? " (auth disabled)" : ""}`,
    );
}

await main();
