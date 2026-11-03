/** The permission guards the generated routes carry: each refuses a call by throwing. See docs/permissions.md. */
import { ForbiddenError } from "sdk/errors.ts";
import type { TenantId } from "spec/user-service/Tenant.ts";
import type { RequestContext } from "../context.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import type { RouteGuard } from "./router.ts";

/** One row of a write, or one key a delete or watch names. */
type Row = Record<string, unknown>;

/** The argument of a read: the filter whose tenant column a guard reads. */
export interface TenantFilterArgument {
    readonly filter?: object | undefined;
}

/** The argument of a write: the rows whose tenant column a guard reads. */
export type TenantRowsArgument = readonly object[];

/** The argument of a change stream: the filter it watches, or the keys it selects. */
export interface TenantWatchArgument extends TenantFilterArgument {
    readonly pks?: readonly object[] | undefined;
}

/** The entity's generated `get<Entity>Tenants`: the distinct tenants the named key rows belong to. */
export type TenantLookup<T = any> = (db: SqlExecutor, pks: readonly T[]) => Promise<TenantId[]>;

/**
 * A permission no tenant narrows: `tenant:create`, or an `invoice:query` covering every tenant.
 *
 * @throws {ForbiddenError} when the session lacks the permission
 */
export function permissionGuard(scope: string, action: string): RouteGuard {
    return async (ctx) => {
        if (!(await ctx.hasPermission(scope, action))) {
            throw new ForbiddenError(`missing permission ${scope}:${action}`);
        }
    };
}

/** The guard for a read: the tenants its filter names. */
export function tenantOwnedQueryGuard<T extends TenantFilterArgument = TenantFilterArgument>(
    scope: string,
    column: string,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const filter = rowOf(argument.filter);
        await requirePermission(ctx, scope, "query", () => tenantValues(filter[column]));
    };
}

/** The guard for a change stream: its filter tenant, or the stored tenant of every key it names. */
export function tenantOwnedWatchGuard<T extends TenantWatchArgument | undefined = TenantWatchArgument | undefined>(
    scope: string,
    column: string,
    tenants: TenantLookup,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const options = rowOf(argument);
        const named = tenantValues(rowOf(options.filter)[column]);
        const keys = rowsOf(options.pks);
        await requirePermission(ctx, scope, "watch", async () =>
            named.length > 0 ? named : await tenants(ctx.db, keys),
        );
    };
}

/** The guard for a create: the tenant every inserted row names. */
export function tenantOwnedCreateGuard<T extends TenantRowsArgument = TenantRowsArgument>(
    scope: string,
    column: string,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const rows = rowsOf(argument);
        if (rows.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "create", () => rows.flatMap((row) => tenantValues(row[column])));
    };
}

/** The guard for an upsert: the tenant every row names, and the stored tenant a replaced row leaves. */
export function tenantOwnedUpsertGuard<T extends TenantRowsArgument = TenantRowsArgument>(
    scope: string,
    column: string,
    tenants: TenantLookup,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const rows = rowsOf(argument);
        if (rows.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "upsert", async () => [
            ...(await tenants(ctx.db, rows)),
            ...rows.flatMap((row) => tenantValues(row[column])),
        ]);
    };
}

/** The guard for a patch: a row's stored tenant, and the tenant the patch moves it to when it names one. */
export function tenantOwnedUpdateGuard<T extends TenantRowsArgument = TenantRowsArgument>(
    scope: string,
    column: string,
    tenants: TenantLookup,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const rows = rowsOf(argument);
        if (rows.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "update", async () => [
            ...(await tenants(ctx.db, rows)),
            ...rows.flatMap((row) => tenantValues(row[column])),
        ]);
    };
}

/** The guard for a delete: the stored tenant of every key it names. */
export function tenantOwnedDeleteGuard<T extends TenantRowsArgument = TenantRowsArgument>(
    scope: string,
    tenants: TenantLookup,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const rows = rowsOf(argument);
        if (rows.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "delete", () => tenants(ctx.db, rows));
    };
}

/**
 * Allow the call on a global permission, otherwise on a permission in every tenant it names.
 * @throws {ForbiddenError} when the session holds neither, or the call names no tenant to check
 */
async function requirePermission(
    ctx: RequestContext,
    scope: string,
    action: string,
    tenants: () => TenantId[] | Promise<TenantId[]>,
): Promise<void> {
    if (await ctx.hasPermission(scope, action)) {
        return;
    }
    const named = [...new Set(await tenants())];
    if (named.length === 0) {
        throw new ForbiddenError(`${scope}:${action} names no tenant the session can be checked against`);
    }
    for (const tenant of named) {
        if (!(await ctx.hasPermission(scope, action, tenant))) {
            throw new ForbiddenError(`missing permission ${scope}:${action} in tenant ${tenant}`);
        }
    }
}

/** A value read as an object, so an absent or malformed argument reads as one with no fields. */
function rowOf(value: unknown): Row {
    return typeof value === "object" && value !== null ? (value as Row) : {};
}

/** A value read as the array of rows a write or a key list carries. */
function rowsOf(value: unknown): Row[] {
    return Array.isArray(value) ? value.map(rowOf) : [];
}

/** One tenant id, or the set a filter carries; an absent value or a null test names no tenant. */
function tenantValues(value: unknown): TenantId[] {
    if (Array.isArray(value)) {
        return value.flatMap(tenantValues);
    }
    return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? [String(value) as TenantId]
        : [];
}
