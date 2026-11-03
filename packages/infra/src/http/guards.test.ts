/** Unit tests for the permission guard factories, over a fake request context and a fixture tenant lookup. See docs/permissions.md. */
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "sdk/errors.ts";
import type { TenantId } from "spec/user-service/Tenant.ts";
import type { RequestContext } from "../context.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import {
    permissionGuard,
    tenantOwnedCreateGuard,
    tenantOwnedDeleteGuard,
    tenantOwnedQueryGuard,
    tenantOwnedUpdateGuard,
    tenantOwnedUpsertGuard,
    tenantOwnedWatchGuard,
    type TenantLookup,
} from "./guards.ts";

/** The tenant column the fixture entries read, so no test depends on the real spec's names. */
const COLUMN = "tenantId";

const A = "tenant-a" as TenantId;
const B = "tenant-b" as TenantId;

interface PermissionCall {
    scope: string;
    action: string;
    tenant: TenantId | undefined;
}

interface Lookup {
    tenants: TenantLookup;
    calls: (readonly object[])[];
}

/** A lookup that answers the tenants the test supplies and records the key rows it was handed. */
function lookupOf(...tenants: TenantId[]): Lookup {
    const calls: (readonly object[])[] = [];
    return {
        calls,
        tenants: async (_db, pks) => {
            calls.push(pks);
            return tenants;
        },
    };
}

interface Fake {
    ctx: RequestContext;
    calls: PermissionCall[];
}

/** A context whose permission answers the test supplies; `allow` sees the tenant, or `undefined` globally. */
function context(allow: (tenant: TenantId | undefined) => boolean = () => true): Fake {
    const calls: PermissionCall[] = [];
    const ctx = {
        hasPermission: async (scope: string, action: string, tenant?: TenantId) => {
            calls.push({ scope, action, tenant });
            return allow(tenant);
        },
        db: {} as SqlExecutor,
    } as unknown as RequestContext;
    return { ctx, calls };
}

/** The error a guard refused with, so its type and fields are both assertable. */
async function failure(result: void | Promise<unknown>): Promise<unknown> {
    try {
        await result;
    } catch (thrown) {
        return thrown;
    }
    throw new Error("expected the guard to refuse");
}

describe("permissionGuard", () => {
    it("checks the scope and action once, with no tenant", async () => {
        const fake = context();

        await permissionGuard("widget", "delete")(fake.ctx, undefined);

        expect(fake.calls).toEqual([{ scope: "widget", action: "delete", tenant: undefined }]);
    });

    it("refuses with a forbidden error", async () => {
        const fake = context(() => false);

        const thrown = await failure(permissionGuard("widget", "delete")(fake.ctx, undefined));

        expect(thrown).toBeInstanceOf(ForbiddenError);
        expect((thrown as ForbiddenError).status).toBe(403);
        expect((thrown as ForbiddenError).kind).toBe("forbidden");
    });
});

describe("tenantOwnedQueryGuard", () => {
    it("checks every tenant the filter names", async () => {
        const fake = context((tenant) => tenant !== undefined);

        await tenantOwnedQueryGuard("widget", COLUMN)(fake.ctx, { filter: { tenantId: [A, B] } });

        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A, B]);
    });

    it("stops at the tenant it refuses", async () => {
        const fake = context((tenant) => tenant === A);

        const thrown = await failure(
            tenantOwnedQueryGuard("widget", COLUMN)(fake.ctx, { filter: { tenantId: [A, B] } }),
        );

        expect(thrown).toBeInstanceOf(ForbiddenError);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A, B]);
    });

    it("skips the tenant checks on a global permission", async () => {
        const fake = context(() => true);

        await tenantOwnedQueryGuard("widget", COLUMN)(fake.ctx, { filter: { tenantId: [A, B] } });

        expect(fake.calls).toEqual([{ scope: "widget", action: "query", tenant: undefined }]);
    });

    it("refuses a query that names no tenant", async () => {
        const fake = context(() => false);

        const thrown = await failure(tenantOwnedQueryGuard("widget", COLUMN)(fake.ctx, { filter: {} }));

        expect(thrown).toBeInstanceOf(ForbiddenError);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined]);
    });
});

describe("tenantOwnedCreateGuard", () => {
    it("checks every row's tenant", async () => {
        const fake = context((tenant) => tenant !== undefined);

        await tenantOwnedCreateGuard("widget", COLUMN)(fake.ctx, [{ tenantId: A }, { tenantId: B }]);

        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A, B]);
    });

    it("refuses when one row names a tenant the session lacks", async () => {
        const fake = context((tenant) => tenant === A);

        const thrown = await failure(
            tenantOwnedCreateGuard("widget", COLUMN)(fake.ctx, [{ tenantId: A }, { tenantId: B }]),
        );

        expect(thrown).toBeInstanceOf(ForbiddenError);
    });

    it("asks nothing of an empty batch", async () => {
        const fake = context(() => false);

        await tenantOwnedCreateGuard("widget", COLUMN)(fake.ctx, []);

        expect(fake.calls).toEqual([]);
    });
});

describe("tenantOwnedUpsertGuard", () => {
    it("checks the stored tenant and the tenant the row moves to", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(A);

        await tenantOwnedUpsertGuard("widget", COLUMN, lookup.tenants)(fake.ctx, [{ id: "1", tenantId: B }]);

        expect(lookup.calls).toEqual([[{ id: "1", tenantId: B }]]);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A, B]);
    });

    it("refuses a move into a tenant the session lacks", async () => {
        const fake = context((tenant) => tenant === A);
        const lookup = lookupOf(A);

        const thrown = await failure(
            tenantOwnedUpsertGuard("widget", COLUMN, lookup.tenants)(fake.ctx, [{ id: "1", tenantId: B }]),
        );

        expect(thrown).toBeInstanceOf(ForbiddenError);
    });
});

describe("tenantOwnedUpdateGuard", () => {
    it("checks the stored tenant and the tenant a patch moves the row to", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(A);

        await tenantOwnedUpdateGuard("widget", COLUMN, lookup.tenants)(fake.ctx, [{ id: "1", tenantId: B }]);

        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A, B]);
    });

    it("checks only the stored tenant when the patch names none", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(A);

        await tenantOwnedUpdateGuard("widget", COLUMN, lookup.tenants)(fake.ctx, [{ id: "1" }]);

        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A]);
    });

    it("refuses a move into a tenant the session lacks", async () => {
        const fake = context((tenant) => tenant === A);
        const lookup = lookupOf(A);

        const thrown = await failure(
            tenantOwnedUpdateGuard("widget", COLUMN, lookup.tenants)(fake.ctx, [{ id: "1", tenantId: B }]),
        );

        expect(thrown).toBeInstanceOf(ForbiddenError);
    });
});

describe("tenantOwnedDeleteGuard", () => {
    it("checks the stored tenant of the keys it names", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(A);

        await tenantOwnedDeleteGuard("widget", lookup.tenants)(fake.ctx, [{ id: "1" }, { id: "2" }]);

        expect(lookup.calls).toEqual([[{ id: "1" }, { id: "2" }]]);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A]);
    });

    it("skips the lookup on a global permission", async () => {
        const fake = context(() => true);
        const lookup = lookupOf(A);

        await tenantOwnedDeleteGuard("widget", lookup.tenants)(fake.ctx, [{ id: "1" }]);

        expect(lookup.calls).toEqual([]);
        expect(fake.calls).toEqual([{ scope: "widget", action: "delete", tenant: undefined }]);
    });

    it("refuses a key that resolves to no tenant", async () => {
        const fake = context(() => false);
        const lookup = lookupOf();

        const thrown = await failure(tenantOwnedDeleteGuard("widget", lookup.tenants)(fake.ctx, [{ id: "1" }]));

        expect(thrown).toBeInstanceOf(ForbiddenError);
    });
});

describe("tenantOwnedWatchGuard", () => {
    it("checks the filter tenant without a lookup", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(A);

        await tenantOwnedWatchGuard("widget", COLUMN, lookup.tenants)(fake.ctx, { filter: { tenantId: A } });

        expect(lookup.calls).toEqual([]);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, A]);
    });

    it("falls back to the stored tenants of the named keys", async () => {
        const fake = context((tenant) => tenant !== undefined);
        const lookup = lookupOf(B);

        await tenantOwnedWatchGuard("widget", COLUMN, lookup.tenants)(fake.ctx, { pks: [{ id: "1" }] });

        expect(lookup.calls).toEqual([[{ id: "1" }]]);
        expect(fake.calls.map((call) => call.tenant)).toEqual([undefined, B]);
    });

    it("refuses a watch that names neither a tenant nor a key", async () => {
        const fake = context(() => false);
        const lookup = lookupOf();

        const thrown = await failure(tenantOwnedWatchGuard("widget", COLUMN, lookup.tenants)(fake.ctx, undefined));

        expect(thrown).toBeInstanceOf(ForbiddenError);
    });
});
