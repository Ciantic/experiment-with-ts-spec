import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Version } from "../primitives/Version.ts";

/** The unique identifier for a tenant. */
export type TenantId = BrandedId<"TenantId">;

/**
 * An organisation whose data this installation holds.
 * 
 * @pgTable tenant
 */
export interface Tenant {
    /**
     * The unique identifier for the tenant.
     * 
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: TenantId;

    /**
     * The display name of the tenant.
     * 
     * @fieldName Name
     * @widget text
     */
    name: string;

    /**
     * The moment the tenant record was created.
     * 
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the tenant record was last updated.
     * 
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the tenant record, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
