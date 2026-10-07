import type { AutoIncrement } from "../primitives/AutoIncrement.ts";

/** The identifier for an audit entry, assigned by the database at insert. */
export type AuditLogId = AutoIncrement<"AuditLogId">;

/**
 * One line in the audit log.
 *
 * Append-only: a row records what happened and is never changed, so it carries
 * no `@version` and no `@updatedAt`.
 *
 * @pgTable audit_log
 * @repository create
 * @restRepository create
 * @queries query
 * @restQueries query
 */
export interface AuditLog {
    /**
     * The identifier for the entry, assigned by the database.
     *
     * @fieldName ID
     * @primaryKey
     * @pgAutoIncrement
     * @widget number
     */
    id: AuditLogId;

    /**
     * What was recorded.
     *
     * @fieldName Message
     * @widget textarea
     */
    message: string;

    /**
     * The moment the entry was recorded.
     *
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt: Date;
}
