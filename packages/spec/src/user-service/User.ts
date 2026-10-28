import type { BrandedId } from "../primitives/BrandedId.ts";
import type { EmailAddress } from "../emailing-service/primitives/EmailAddress.ts";
import type { Version } from "../primitives/Version.ts";

/** The unique identifier for a user. */
export type UserId = BrandedId<"UserId">;

/**
 * A person who can sign in with an emailed one-time link.
 *
 * @entity
 * @pgTable user
 * @repository create update delete
 * @restRepository create update delete
 * @queries query
 * @restQueries query
 */
export interface User {
    /**
     * The unique identifier for the user.
     *
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: UserId;

    /**
     * User's email address.
     *
     * @fieldName Email
     * @unique
     * @queryFilter
     * @widget text
     */
    email: EmailAddress;

    /**
     * The moment the address was proven, which is null until a link is redeemed.
     *
     * @fieldName Verified at
     * @queryWhere isNull isNotNull
     * @widget date
     */
    emailVerifiedAt?: Date;

    /**
     * The moment the user record was created.
     *
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the user record was last updated.
     *
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt: Date;

    /**
     * The moment the user was trashed; null while it is live.
     *
     * @fieldName Deleted at
     * @deletedAt
     * @queryFilter default=isNull
     * @widget date
     */
    deletedAt?: Date;

    /**
     * The revision of the user record, incremented on every write.
     *
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
