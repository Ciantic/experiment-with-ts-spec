import type { TenantSharedPermission, TenantSharedPermissionId } from "../src/user-service/TenantSharedPermission.ts";
import type { TenantId } from "../src/user-service/Tenant.ts";
import type { Version } from "../src/primitives/Version.ts";

const oksidi = "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId;
const example = "dddddddd-dddd-7ddd-8ddd-dddddddddddd" as TenantId;
const at = new Date("2026-01-03T06:00:00.000Z");

/** Sample cross-tenant grants for a seeded development database. See docs/mockdata.md. */
export const tenantSharedPermissions: TenantSharedPermission[] = [
    {
        id: "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee" as TenantSharedPermissionId,
        ownerTenantId: oksidi,
        sharedTenantId: example,
        permissions: "query",
        createdAt: at,
        updatedAt: at,
        version: 0n as Version,
    },
    {
        id: "ffffffff-ffff-7fff-8fff-ffffffffffff" as TenantSharedPermissionId,
        ownerTenantId: example,
        sharedTenantId: oksidi,
        permissions: "query",
        createdAt: at,
        updatedAt: at,
        version: 0n as Version,
    },
];
