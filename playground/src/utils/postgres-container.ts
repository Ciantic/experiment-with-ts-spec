/** Starts the playground's PostgreSQL container under Podman. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PgSqlDriver } from "infra";
import * as pgRuntime from "pg";
import { acceptsConnections } from "./ports.ts";

/** The container name a bare `PostgresContainer.start()` uses. */
const DEFAULT_NAME = "playground-postgres";

/** The loopback port a bare `PostgresContainer.start()` publishes. */
const DEFAULT_PORT = 5432;

/** The image a bare `PostgresContainer.start()` runs. */
const DEFAULT_IMAGE = "docker.io/library/postgres:18-alpine";

/** How long `PostgresContainer.start()` waits for PostgreSQL before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** How `PostgresContainer.start()` behaves. Every flag defaults to the value a test wants. */
export interface StartPostgresOptions {
    /** Container name. Defaults to `playground-postgres`. */
    name?: string;
    /** Loopback port to publish. Defaults to `5432`. */
    port?: number;
    /** Image to run. Defaults to `docker.io/library/postgres:18-alpine`. */
    image?: string;
    /** Reuse a running container, and start a stopped one instead of recreating it. Defaults to true. */
    onlyIfNotRunning?: boolean;
    /** Stop the container when the process exits, including on Ctrl+C. Defaults to false. */
    stopOnExit?: boolean;
    /** Wait until PostgreSQL accepts connections. Defaults to true. */
    waitForReady?: boolean;
    /** How long to wait for PostgreSQL. Defaults to 30000 ms. */
    readyTimeoutMs?: number;
}

interface ResolvedOptions {
    name: string;
    port: number;
    image: string;
    onlyIfNotRunning: boolean;
    stopOnExit: boolean;
    waitForReady: boolean;
    readyTimeoutMs: number;
}

interface PodmanResult {
    status: number;
    stdout: string;
    stderr: string;
}

/** The container `PostgresContainer.start()` started or reused, and the databases it holds. */
export class PostgresContainer {
    /** The Podman container name. */
    readonly name: string;
    /** The host port PostgreSQL is published on. */
    readonly port: number;
    /** The connection string `PgSqlDriver` takes. */
    readonly databaseUrl: string;
    /** False when an already running container was reused instead of started. */
    readonly started: boolean;

    private constructor(name: string, port: number, started: boolean) {
        this.name = name;
        this.port = port;
        this.databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
        this.started = started;
    }

    /**
     * Start PostgreSQL, or reuse it when it is already running and `onlyIfNotRunning` is true.
     * @throws {Error} when the container cannot be started, run, or made ready
     */
    static async start(options: StartPostgresOptions = {}): Promise<PostgresContainer> {
        const resolved = PostgresContainer.resolve(options);

        if (PostgresContainer.isRunning(resolved.name)) {
            if (resolved.onlyIfNotRunning) {
                const port = PostgresContainer.publishedPort(resolved.name, resolved.port);
                if (resolved.waitForReady) {
                    await PostgresContainer.waitForReady(resolved.name, port, resolved.readyTimeoutMs);
                }
                return new PostgresContainer(resolved.name, port, false);
            }
            PostgresContainer.remove(resolved.name);
        }

        if (PostgresContainer.exists(resolved.name)) {
            PostgresContainer.startExisting(resolved.name);
        } else {
            PostgresContainer.runDetached(resolved);
        }

        if (resolved.stopOnExit) {
            PostgresContainer.stopWhenProcessExits(resolved.name);
        }

        const port = PostgresContainer.publishedPort(resolved.name, resolved.port);
        if (resolved.waitForReady) {
            try {
                await PostgresContainer.waitForReady(resolved.name, port, resolved.readyTimeoutMs);
            } catch (thrown) {
                PostgresContainer.remove(resolved.name);
                throw thrown;
            }
        }

        return new PostgresContainer(resolved.name, port, true);
    }

    /** Stop the container this call started; a reused container is left running. */
    stop(): void {
        if (this.started) {
            PostgresContainer.stopContainer(this.name);
        }
    }

    /**
     * Create a database for one run, so a long-lived container never carries a previous run's rows.
     * @throws {Error} when the admin connection cannot create the database
     */
    async createDatabase(prefix: string): Promise<string> {
        const database = `${prefix}_${randomBytes(4).toString("hex")}`;
        const admin = new PgSqlDriver(pgRuntime, { connectionString: this.databaseUrl });
        try {
            await admin.exec(`create database "${database}"`);
        } finally {
            await admin.close();
        }
        return PostgresContainer.databaseUrlFor(this.databaseUrl, database);
    }

    /**
     * Drop a database this run created, releasing the connections that still use it.
     * @throws {Error} when the admin connection cannot drop the database
     */
    async dropDatabase(url: string): Promise<void> {
        const database = new URL(url).pathname.slice(1);
        const admin = new PgSqlDriver(pgRuntime, { connectionString: this.databaseUrl });
        try {
            await admin.exec(`drop database if exists "${database}" with (force)`);
        } finally {
            await admin.close();
        }
    }

    /** The connection string onto another database of the same server. */
    private static databaseUrlFor(containerUrl: string, database: string): string {
        const parsed = new URL(containerUrl);
        parsed.pathname = `/${database}`;
        return parsed.toString();
    }

    /**
     * Resolve the defaults, refusing a port that cannot be published.
     * @throws {Error} when the port is not an integer between 1 and 65535
     */
    private static resolve(options: StartPostgresOptions): ResolvedOptions {
        const port = options.port ?? DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`port must be an integer between 1 and 65535, got ${port}`);
        }
        return {
            name: options.name ?? DEFAULT_NAME,
            port,
            image: options.image ?? DEFAULT_IMAGE,
            onlyIfNotRunning: options.onlyIfNotRunning ?? true,
            stopOnExit: options.stopOnExit ?? false,
            waitForReady: options.waitForReady ?? true,
            readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        };
    }

    /**
     * Poll until PostgreSQL inside the container accepts connections.
     * @throws {Error} when the container stops or never becomes ready
     */
    private static async waitForReady(name: string, port: number, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (PostgresContainer.hasStopped(name)) {
                throw new Error(`Podman container ${name} stopped before PostgreSQL became ready`);
            }
            if (PostgresContainer.isReadyInside(name) && (await acceptsConnections(port))) {
                return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`PostgreSQL in ${name} did not accept connections within ${timeoutMs} ms`);
    }

    /**
     * Run a podman command, treating a missing binary as a harness failure.
     * @throws {Error} when podman cannot be spawned
     */
    private static podman(args: string[]): PodmanResult {
        const result = spawnSync("podman", args, { encoding: "utf8" });
        if (result.error !== undefined) {
            throw new Error(`cannot run podman: ${result.error.message}`);
        }
        return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }

    /** Whether the container exists, running or not. */
    private static exists(name: string): boolean {
        return PostgresContainer.podman(["container", "exists", name]).status === 0;
    }

    /** Whether the container exists and is running. */
    private static isRunning(name: string): boolean {
        if (!PostgresContainer.exists(name)) {
            return false;
        }
        return PostgresContainer.podman(["inspect", "--format", "{{.State.Running}}", name]).stdout.trim() === "true";
    }

    /** Whether the container is known to have stopped. */
    private static hasStopped(name: string): boolean {
        const state = PostgresContainer.podman(["inspect", "--format", "{{.State.Running}}", name]);
        return state.status === 0 && state.stdout.trim() !== "true";
    }

    /** Whether PostgreSQL itself accepts connections; Podman's port forwarder accepts TCP before it does. */
    private static isReadyInside(name: string): boolean {
        return PostgresContainer.podman(["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"]).status === 0;
    }

    /** The host port the container publishes, falling back to the requested one. */
    private static publishedPort(name: string, fallback: number): number {
        const result = PostgresContainer.podman(["port", name, "5432/tcp"]);
        if (result.status !== 0) {
            return fallback;
        }
        const first = result.stdout.split("\n")[0]?.trim();
        if (first === undefined || first === "") {
            return fallback;
        }
        const text = first.slice(first.lastIndexOf(":") + 1);
        return /^\d+$/.test(text) ? Number(text) : fallback;
    }

    /**
     * Remove the container, forcing it and ignoring one that is already gone.
     * @throws {Error} when podman reports a failure
     */
    private static remove(name: string): void {
        const result = PostgresContainer.podman(["rm", "--force", "--ignore", name]);
        if (result.status !== 0) {
            throw new Error(`cannot remove Podman container ${name}: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    }

    /**
     * Start an existing container.
     * @throws {Error} when podman reports a failure
     */
    private static startExisting(name: string): void {
        const result = PostgresContainer.podman(["start", name]);
        if (result.status !== 0) {
            throw new Error(`cannot start Podman container ${name}: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    }

    /**
     * Run a new container detached, publishing the requested loopback port.
     * @throws {Error} when podman reports a failure
     */
    private static runDetached(options: ResolvedOptions): void {
        const args = [
            "run",
            "--detach",
            "--rm",
            "--name",
            options.name,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-p",
            `127.0.0.1:${options.port}:5432`,
            options.image,
        ];
        const result = PostgresContainer.podman(args);
        if (result.status !== 0) {
            throw new Error(`podman run failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    }

    /** Stop the container, ignoring one that is already gone. */
    private static stopContainer(name: string): void {
        PostgresContainer.podman(["stop", "--ignore", name]);
    }

    /** Stop the container when this process exits, then re-raise the signal so the exit status stays honest. */
    private static stopWhenProcessExits(name: string): void {
        const stop = (): void => {
            spawnSync("podman", ["stop", "--ignore", name], { stdio: "ignore" });
        };
        const onExit = (): void => {
            stop();
        };
        const onSignal = (signal: NodeJS.Signals): void => {
            stop();
            process.off("exit", onExit);
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            process.kill(process.pid, signal);
        };
        process.on("exit", onExit);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
    }
}
