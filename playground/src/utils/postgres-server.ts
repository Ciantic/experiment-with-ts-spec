/** The real PostgreSQL environment: a database on the playground's Podman container, served by this process. */
import { expect, it } from "vitest";
import * as pgRuntime from "pg";
import { ApiServer, AppContext, PgSqlDriver, applySchema, seedMockData, type SqlDriver } from "infra";
import * as api from "sdk/api/index.ts";
import { exec } from "sdk/client.ts";
import { ApiClient } from "sdk/http.ts";
import { routes, withoutGuards } from "../../../packages/backend/src/routes.ts";
import { PlaygroundServer, type Examples } from "./environment.ts";
import { runWith } from "./environment.ts";
import { PostgresContainer } from "./postgres-container.ts";

/** A server this process serves over one database. */
class LocalServer extends PlaygroundServer {
    readonly #server: ApiServer;
    readonly #app: AppContext;

    private constructor(http: ApiClient, server: ApiServer, app: AppContext) {
        super(http);
        this.#server = server;
        this.#app = app;
    }

    /** Serve one database over an ephemeral port; close releases only this process's server and pool. */
    static async serve(databaseUrl: string): Promise<LocalServer> {
        const app = new AppContext({
            driver: () => new PgSqlDriver(pgRuntime, { connectionString: databaseUrl }),
        });
        await LocalServer.prepare(app.driver);
        const server = new ApiServer(app, withoutGuards(routes));
        const port = await server.listen(0);
        return new LocalServer(new ApiClient(`http://127.0.0.1:${port}`), server, app);
    }

    async close(): Promise<void> {
        await this.#server.close();
        await this.#app.driver.close();
    }

    /** Apply the generated schema and the mock data, unless the database already holds the schema. */
    private static async prepare(driver: SqlDriver): Promise<void> {
        const result = await driver.query<{ tables: number }>(
            "select count(*)::int as tables from information_schema.tables where table_schema = 'public'",
        );
        if ((result.rows[0]?.tables ?? 0) > 0) {
            return;
        }
        await applySchema(driver);
        await seedMockData(driver.createExecutor());
    }
}

/** A server over a database this run created, dropped with the container once the run ends. */
class FreshPostgresServer extends PlaygroundServer {
    readonly #server: LocalServer;
    readonly #container: PostgresContainer;
    readonly #databaseUrl: string;

    private constructor(server: LocalServer, container: PostgresContainer, databaseUrl: string) {
        super(server.http);
        this.#server = server;
        this.#container = container;
        this.#databaseUrl = databaseUrl;
    }

    /** Serve a freshly created database, removed with the container once the run ends. */
    static async start(): Promise<FreshPostgresServer> {
        const container = await PostgresContainer.start({ onlyIfNotRunning: true });
        const databaseUrl = await container.createDatabase("playground_pg");
        const server = await LocalServer.serve(databaseUrl);
        return new FreshPostgresServer(server, container, databaseUrl);
    }

    async close(): Promise<void> {
        await this.#server.close();
        await this.#container.dropDatabase(this.#databaseUrl);
        this.#container.stop();
    }
}

/** A server over the container's default database, left running for a backend you start yourself. */
class SharedPostgresServer extends PlaygroundServer {
    readonly #server: LocalServer;

    private constructor(server: LocalServer) {
        super(server.http);
        this.#server = server;
    }

    /** Serve the container's default database, leaving the container running across runs. */
    static async start(): Promise<SharedPostgresServer> {
        const container = await PostgresContainer.start({ onlyIfNotRunning: true });
        const server = await LocalServer.serve(container.databaseUrl);
        console.log(`PostgreSQL container "${container.name}" is left running at ${container.databaseUrl}`);
        return new SharedPostgresServer(server);
    }

    async close(): Promise<void> {
        await this.#server.close();
    }
}

/** The real PostgreSQL environment as a describe body. */
export function runWithPostgres(examples: Examples): () => void {
    return runWith(FreshPostgresServer.start, examples);
}

/** The container left running after the run, as a describe body: one test asserts it serves the seeded database. */
export function runWithPostgresContainer(): () => void {
    return runWith(SharedPostgresServer.start, (getHttp) => {
        it("leaves the PostgreSQL container running", async () => {
            const [tenant] = await exec(getHttp(), api.queryTenant({ limit: 1, select: { id: true } }));
            expect(tenant).toBeDefined();
        });
    });
}
