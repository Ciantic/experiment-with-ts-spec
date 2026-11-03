/** The backend context a process creates once, and the context each request builds over it. See docs/operations.md. */
import type { IncomingMessage } from "node:http";
import type { SqlExecutor } from "./db/sql-executor.ts";
import type { SqlDriver } from "./db/sql-driver.ts";
import type { AuthSession } from "spec/user-service/AuthSession.ts";
import type { TenantId } from "spec/user-service/Tenant.ts";
import { NotImplemented } from "sdk/errors.ts";

/** How to build the app context. */
export interface AppOptions {
    /** The driver the process chose for its database. */
    driver: SqlDriver;
}

/** What startup creates once: the driver requests derive their executor from, and the process closes. */
export interface AppContext {
    /** The process's driver: each request builds its executor over it, and its owner closes it. */
    driver: SqlDriver;
}

/** Build the process's context over the driver it was given. */
export function createAppContext(options: AppOptions): AppContext {
    return { driver: options.driver };
}

/** One request's context: the executor its call runs on, and the request it answers. */
export class RequestContext {
    readonly #db: SqlExecutor;
    readonly #request: IncomingMessage;

    constructor(executor: SqlExecutor, request: IncomingMessage) {
        this.#db = executor;
        this.#request = request;
    }

    /** The executor the call runs on; a group hands the boundary its kind opened. */
    get db(): SqlExecutor {
        return this.#db;
    }

    /** The same request, run on another executor; a group boundary hands each of its steps one. */
    withExecutor(executor: SqlExecutor): RequestContext {
        return new RequestContext(executor, this.#request);
    }

    
    /**
     * @throws {NotImplemented} until the request's session is resolved from its credentials
     */
    async getAuthSession(): Promise<AuthSession> {
        throw new NotImplemented("getAuthSession not implemented");
    }

    /**
     * Whether the session holds `scope:action`, globally or within `tenant`; the guards ask globally first.
     *
     * @throws {NotImplemented} until permissions are checked against the authenticated session
     */
    async hasPermission(_scope: string, _action: string, _tenant?: TenantId): Promise<boolean> {
        throw new NotImplemented("hasPermission not implemented");
    }
}
