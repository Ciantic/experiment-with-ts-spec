/** The permission guards the generated routes carry: each refuses a call by throwing. See docs/permissions.md. */
import { ForbiddenError } from "sdk/errors.ts";
import type { TenantId } from "spec/user-service/Tenant.ts";
import type { RequestContext } from "../context.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import type { RouteGuard } from "./router.ts";

/** One row of a write, or one key a delete or watch names. */
type Row = Record<string, unknown>;

/** The argument of a read: the filter whose tenant field a guard reads. */
export interface TenantFilterArgument {
    readonly filter?: Record<string, unknown> | undefined;
}

/** The argument of a write: the rows whose tenant field a guard reads. */
export type TenantRowsArgument = readonly object[];

/** The argument of a change stream: the filter it watches, or the keys it selects. */
export interface TenantWatchArgument<TKey extends object = object> extends TenantFilterArgument {
    readonly pks?: readonly TKey[] | undefined;
}

/** The entity's generated `get<Entity>Tenants`: the distinct tenants the named key rows belong to. */
export type TenantLookup<TKey extends object = object> = (db: SqlExecutor, pks: readonly TKey[]) => Promise<TenantId[]>;

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
    tenantFieldName: string,
): RouteGuard<T> {
    return async (ctx, argument) => {
        const tenantFilters = argument.filter?.[tenantFieldName];
        await requirePermission(ctx, scope, "query", () => tenantValues(tenantFilters));
    };
}

/** The guard for a change stream: its filter tenant, or the stored tenant of every key it names. */
export function tenantOwnedWatchGuard<TKey extends object>(
    scope: string,
    tenantFieldName: string,
    tenants: TenantLookup<TKey>,
): RouteGuard<TenantWatchArgument<TKey> | undefined> {
    return async (ctx, argument) => {
        const tenantFilters = argument?.filter?.[tenantFieldName];
        const pks = argument?.pks;
        await requirePermission(ctx, scope, "watch", async () =>
            tenantFilters !== undefined ? tenantValues(tenantFilters) : await tenants(ctx.db, pks ?? []),
        );
    };
}

/** The guard for a create: the tenant every inserted row names. */
export function tenantOwnedCreateGuard<T extends TenantRowsArgument = TenantRowsArgument>(
    scope: string,
    tenantFieldName: string,
): RouteGuard<T> {
    return async (ctx, argument) => {
        if (argument.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "create", () =>
            argument.flatMap((row) => tenantValues(rowOf(row)[tenantFieldName])),
        );
    };
}

/** The guard for an upsert: the tenant every row names, and the stored tenant a replaced row leaves. */
export function tenantOwnedUpsertGuard<TKey extends object>(
    scope: string,
    tenantFieldName: string,
    tenants: TenantLookup<TKey>,
): RouteGuard<readonly TKey[]> {
    return async (ctx, argument) => {
        if (argument.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "upsert", async () => [
            ...(await tenants(ctx.db, argument)),
            ...argument.flatMap((row) => tenantValues(rowOf(row)[tenantFieldName])),
        ]);
    };
}

/** The guard for a patch: a row's stored tenant, and the tenant the patch moves it to when it names one. */
export function tenantOwnedUpdateGuard<TKey extends object>(
    scope: string,
    tenantFieldName: string,
    tenants: TenantLookup<TKey>,
): RouteGuard<readonly TKey[]> {
    return async (ctx, argument) => {
        if (argument.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "update", async () => [
            ...(await tenants(ctx.db, argument)),
            ...argument.flatMap((row) => tenantValues(rowOf(row)[tenantFieldName])),
        ]);
    };
}

/** The guard for a delete: the stored tenant of every key it names. */
export function tenantOwnedDeleteGuard<TKey extends object>(
    scope: string,
    tenants: TenantLookup<TKey>,
): RouteGuard<readonly TKey[]> {
    return async (ctx, argument) => {
        if (argument.length === 0) {
            return;
        }
        await requirePermission(ctx, scope, "delete", () => tenants(ctx.db, argument));
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

/** One tenant id, or the set a filter carries; an absent value or a null test names no tenant. */
function tenantValues(value: unknown): TenantId[] {
    if (Array.isArray(value)) {
        return value.flatMap(tenantValues);
    }
    return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? [String(value) as TenantId]
        : [];
}
