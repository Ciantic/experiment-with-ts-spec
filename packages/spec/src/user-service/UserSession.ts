import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Version } from "../primitives/Version.ts";
import type { UserId } from "./User.ts";
import type { UserSessionTokenHash } from "./primitives/UserSessionTokenHash.ts";

/** The unique identifier for a user session. */
export type UserSessionId = BrandedId<"UserSessionId">;

/**
 * A signed-in browser, holding an opaque token the cookie carries.
 *
 * @entity
 * @pgTable user_session
 * @repository create update delete
 * @queries query
 */
export interface UserSession {
    /**
     * The unique identifier for the session.
     *
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: UserSessionId;

    /**
     * The user the session authenticates.
     *
     * @fieldName User ID
     * @queryFilter
     * @foreignKey User
     * @widget text
     */
    userId: UserId;

    /**
     * The hash of the cookie's token, so the table never holds a replayable secret.
     *
     * @fieldName Token hash
     * @unique
     * @queryFilter
     * @widget text
     */
    tokenHash: UserSessionTokenHash;

    /**
     * The moment the session stops being accepted.
     *
     * @fieldName Expires at
     * @queryWhere gt lte
     * @widget date
     */
    expiresAt: Date;

    /**
     * The moment the session was revoked, which is null until sign-out.
     *
     * @fieldName Revoked at
     * @queryWhere isNull isNotNull
     * @widget date
     */
    revokedAt?: Date;

    /**
     * The moment the session was created.
     *
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the session was last updated.
     *
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the session, incremented on every write.
     *
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
