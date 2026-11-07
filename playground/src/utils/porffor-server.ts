/** The Porffor environment: the backend bundle under `porf`, over a database on the playground's Podman container. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApiClient } from "sdk/http.ts";
import { PlaygroundServer, type Examples } from "./environment.ts";
import { runWith } from "./environment.ts";
import { PostgresContainer } from "./postgres-container.ts";
import { freePort } from "./ports.ts";

/** The workspace root, which the bundle is built from. */
const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The bundle the Porffor entry point produces. */
const PORFFOR_BUNDLE = fileURLToPath(
    new URL("../../../packages/backend/dist.porffor/main.porffor.js", import.meta.url),
);

/** How long `porf` may take to report that it is listening. */
const START_TIMEOUT_MS = 120_000;

/** A Porffor server this run spawned, with the database and container its close releases. */
class PorfforServer extends PlaygroundServer {
    readonly #child: ChildProcess;
    readonly #container: PostgresContainer;
    readonly #databaseUrl: string;
    #output = "";

    private constructor(http: ApiClient, child: ChildProcess, container: PostgresContainer, databaseUrl: string) {
        super(http);
        this.#child = child;
        this.#container = container;
        this.#databaseUrl = databaseUrl;
    }

    /** Build, then run the bundle against a freshly created database on the playground's container. */
    static async start(): Promise<PorfforServer> {
        const container = await PostgresContainer.start({ onlyIfNotRunning: true });
        const databaseUrl = await container.createDatabase("playground_porffor");
        PorfforServer.buildBundle();

        const port = await freePort();
        const child = spawn(
            "porf",
            [PORFFOR_BUNDLE, "--schema", "--seed", "--without-auth", "--database-url", databaseUrl, "--port", String(port)],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        const server = new PorfforServer(new ApiClient(`http://127.0.0.1:${port}`), child, container, databaseUrl);
        server.captureOutput();
        try {
            await server.awaitListening();
        } catch (thrown) {
            await server.close();
            throw thrown;
        }
        return server;
    }

    async close(): Promise<void> {
        await this.stopChild();
        await this.#container.dropDatabase(this.#databaseUrl);
        this.#container.stop();
    }

    /** Keep everything the child prints, so a failed start can report it. */
    private captureOutput(): void {
        this.#child.stdout?.on("data", (chunk: Buffer) => {
            this.#output += chunk.toString();
        });
        this.#child.stderr?.on("data", (chunk: Buffer) => {
            this.#output += chunk.toString();
        });
    }

    /**
     * Resolve once the child prints the line its entry point logs when the server is listening.
     * @throws {Error} when the child exits or stays silent past the deadline
     */
    private awaitListening(): Promise<void> {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + START_TIMEOUT_MS;
            const onExit = (code: number | null): void => {
                settle(new Error(`the Porffor server exited with ${code}:\n${this.#output}`));
            };
            const settle = (thrown?: Error): void => {
                clearInterval(poll);
                this.#child.off("exit", onExit);
                if (thrown === undefined) {
                    resolve();
                } else {
                    reject(thrown);
                }
            };
            const poll = setInterval(() => {
                if (this.#output.includes("api listening")) {
                    settle();
                } else if (Date.now() > deadline) {
                    settle(new Error(`the Porffor server did not start within ${START_TIMEOUT_MS} ms:\n${this.#output}`));
                }
            }, 100);
            this.#child.once("exit", onExit);
        });
    }

    /** Stop the child, escalating to `SIGKILL` when it ignores the polite signal. */
    private async stopChild(): Promise<void> {
        if (this.#child.exitCode !== null) {
            return;
        }
        const exited = new Promise<void>((resolve) => {
            this.#child.once("exit", () => resolve());
        });
        this.#child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
            exited.then(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), 5000);
            }),
        ]);
        clearTimeout(timer);
        if (timedOut) {
            this.#child.kill("SIGKILL");
            await exited;
        }
    }

    /**
     * Build the Porffor bundle, which is written beside the backend's other builds.
     * @throws {Error} when pnpm cannot be run or the build fails
     */
    private static buildBundle(): void {
        const result = spawnSync("pnpm", ["--filter", "backend", "run", "build:porffor"], {
            cwd: WORKSPACE_ROOT,
            encoding: "utf8",
        });
        if (result.error !== undefined) {
            throw new Error(`cannot run pnpm: ${result.error.message}`);
        }
        if (result.status !== 0) {
            throw new Error(`build:porffor failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    }
}

/** The Porffor environment as a describe body. */
export function runWithPorffor(examples: Examples): () => void {
    return runWith(PorfforServer.start, examples);
}
