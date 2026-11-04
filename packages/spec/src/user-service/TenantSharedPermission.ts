import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Version } from "../primitives/Version.ts";
import type { TenantId } from "./Tenant.ts";

/** The unique identifier for a shared-tenant permission. */
export type TenantSharedPermissionId = BrandedId<"TenantSharedPermissionId">;

/**
 * A grant that lets one tenant read another tenant's data.
 *
 * @entity
 * @tenantOwned ownerTenantId
 * @pgTable tenant_shared_permission
 * @repository create upsert update delete
 * @queries query
 */
export interface TenantSharedPermission {
    /**
     * The unique identifier for the grant.
     *
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: TenantSharedPermissionId;

    /**
     * The identifier of the tenant that grants the permission, which owns the row.
     *
     * @fieldName Owner tenant ID
     * @queryFilter
     * @foreignKey Tenant
     * @widget text
     */
    ownerTenantId: TenantId;

    /**
     * The identifier of the tenant that is granted the permission.
     *
     * @fieldName Shared tenant ID
     * @queryFilter
     * @foreignKey Tenant
     * @widget text
     */
    sharedTenantId: TenantId;

    /**
     * The permissions granted to the shared tenant.
     *
     * @fieldName Permissions
     * @widget text
     * @todo This should have better type, but for now it is a string.
     */
    permissions: string;

    /**
     * The moment the grant was created.
     *
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the grant was last updated.
     *
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the grant, incremented on every write.
     *
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
