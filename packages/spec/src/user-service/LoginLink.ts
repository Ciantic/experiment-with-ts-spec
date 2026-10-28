import type { BrandedId } from "../primitives/BrandedId.ts";
import type { EmailAddress } from "../primitives/EmailAddress.ts";
import type { Version } from "../primitives/Version.ts";
import type { LoginLinkTokenHash } from "./primitives/LoginLinkTokenHash.ts";

/** The unique identifier for a login magic link. */
export type LoginLinkId = BrandedId<"LoginLinkId">;

/**
 * A one-time sign-in token emailed to an address.
 *
 * @entity
 * @pgTable login_link
 * @repository create update delete
 * @queries query
 */
export interface LoginLink {
    /**
     * The unique identifier for the link.
     *
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: LoginLinkId;

    /**
     * The address the link was requested for, which need not have a user yet.
     *
     * @fieldName Email
     * @queryFilter
     * @widget text
     */
    email: EmailAddress;

    /**
     * The hash of the mailed token, so the table never holds a redeemable secret.
     *
     * @fieldName Token hash
     * @unique
     * @queryFilter
     * @widget text
     */
    tokenHash: LoginLinkTokenHash;

    /**
     * The moment the link stops being redeemable.
     *
     * @fieldName Expires at
     * @queryWhere gt lte
     * @widget date
     */
    expiresAt: Date;

    /**
     * The moment the link was redeemed, which is null until then.
     *
     * @fieldName Consumed at
     * @queryWhere isNull isNotNull
     * @widget date
     */
    consumedAt?: Date;

    /**
     * The moment the link was created.
     *
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the link was last updated.
     *
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the link, incremented on every write.
     *
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
