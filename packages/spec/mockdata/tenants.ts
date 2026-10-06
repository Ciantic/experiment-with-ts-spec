import type { Tenant, TenantId } from "../src/domain/Tenant.ts";
import type { Version } from "../src/primitives/Version.ts";

/** Sample tenants for a seeded development database. See docs/mockdata.md. */
export const tenants: Tenant[] = [
    {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as TenantId,
        name: "Oksidi Oy",
        createdAt: new Date("2026-01-01T06:00:00.000Z"),
        updatedAt: new Date("2026-01-01T06:00:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as TenantId,
        name: "Example Ab",
        createdAt: new Date("2026-01-02T06:00:00.000Z"),
        updatedAt: new Date("2026-01-02T06:00:00.000Z"),
        version: 0n as Version,
    },
];
