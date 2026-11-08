/** The backend context a process creates once, and the context each request builds over it. See docs/operations.md. */
import type { IncomingMessage } from "node:http";
import type { SqlExecutor } from "./db/sql-executor.ts";
import type { SqlDriver } from "./db/sql-driver.ts";
import type { AuthSession } from "spec/user-service/AuthSession.ts";
import type { TenantId } from "spec/user-service/Tenant.ts";
import { NotImplemented } from "sdk/errors.ts";
import type {
    PermissionAction,
    PermissionEntity,
    TenantPermissionAction,
    TenantPermissionEntity,
} from "sdk/permissions.ts";

/** How to build the app context: one factory per process-level dependency, each called on first use. */
export interface AppOptions {
    /** Build the driver the first time a request needs the database; the process closes what it built. */
    driver: () => SqlDriver;
}

/** What startup creates once: the dependencies a request derives its own from, each built on first use. */
export class AppContext {
    readonly #options: AppOptions;
    #driver: SqlDriver | undefined;

    constructor(options: AppOptions) {
        this.#options = options;
    }

    /** The process's driver, built on first use; its owner closes it at shutdown. */
    get driver(): SqlDriver {
        return (this.#driver ??= this.#options.driver());
    }
}

/** One request's context: the process's context, and the request it answers. */
export class RequestContext {
    readonly #app: AppContext;
    #db?: SqlExecutor;
    readonly #request: IncomingMessage;

    constructor(app: AppContext, request: IncomingMessage) {
        this.#app = app;
        this.#request = request;
    }

    /** The executor the call runs on; a group hands the boundary its kind opened. */
    get db(): SqlExecutor {
        return (this.#db ??= this.#app.driver.createExecutor());
    }

    /** The same request, run on another executor; a group boundary hands each of its steps one. */
    withExecutor(executor: SqlExecutor): RequestContext {
        const context = new RequestContext(this.#app, this.#request);
        context.#db = executor;
        return context;
    }

    /**
     * @throws {NotImplemented} until the request's session is resolved from its credentials
     */
    async getAuthSession(): Promise<AuthSession> {
        throw new NotImplemented("getAuthSession not implemented");
    }

    /**
     * Whether the session holds `scope:action` globally; the guards ask this first.
     *
     * @throws {NotImplemented} until permissions are checked against the authenticated session
     */
    async hasGlobalPermission<E extends PermissionEntity>(_scope: E, _action: PermissionAction<E>): Promise<boolean> {
        throw new NotImplemented("hasGlobalPermission not implemented");
    }

    /**
     * Whether the session holds `scope:action` within `tenant`.
     *
     * @throws {NotImplemented} until permissions are checked against the authenticated session
     */
    async hasTenantPermission<E extends TenantPermissionEntity>(
        _scope: E,
        _action: TenantPermissionAction<E>,
        _tenant: TenantId,
    ): Promise<boolean> {
        throw new NotImplemented("hasTenantPermission not implemented");
    }
}
