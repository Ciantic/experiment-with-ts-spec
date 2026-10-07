import type { BrandedId } from "../primitives/BrandedId.ts";
import type { EmailAddress } from "../primitives/EmailAddress.ts";
import type { Version } from "../primitives/Version.ts";

/** The unique identifier for a queued email. */
export type EmailId = BrandedId<"EmailId">;

/** Where a queued email is in its delivery lifecycle. */
export type EmailStatus = "pending" | "sending" | "sent" | "failed";

/**
 * An outbound email waiting for a delivery service to pick it up.
 *
 * @pgTable email
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @pgTrigger before insert or update for each row: if NEW."status" = 'pending' and NEW."attempts" >= NEW."maxAttempts" then raise exception 'email attempt limit reached on %', NEW."id" using errcode = '23514'; end if
 */
export interface Email {
    /**
     * The unique identifier for the queued email.
     * 
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: EmailId;

    /**
     * The address the email is sent from.
     * 
     * @fieldName From
     * @widget text
     */
    from: EmailAddress;

    /**
     * The address the email is delivered to.
     * 
     * @fieldName To
     * @widget text
     */
    to: EmailAddress;

    /**
     * The subject line of the email.
     * 
     * @fieldName Subject
     * @widget text
     */
    subject: string;

    /**
     * The body of the email.
     * 
     * @fieldName Body
     * @widget textarea
     */
    body: string;

    /**
     * Where the email is in its delivery lifecycle.
     * 
     * A row cannot go back to `pending` once `attempts` reaches `maxAttempts`, so
     * `failed` is terminal.
     * 
     * @fieldName Status
     * @queryFilter
     * @pgDefault 'pending'
     * @widget select
     */
    status: EmailStatus;

    /**
     * How many times delivery has been attempted.
     * 
     * @fieldName Attempts
     * @pgDefault 0
     * @widget number
     */
    attempts: bigint;

    /**
     * How many attempts delivery is given before the email is failed.
     * 
     * @fieldName Max attempts
     * @pgDefault 5
     * @widget number
     */
    maxAttempts: bigint;

    /**
     * The error from the most recent failed attempt.
     * 
     * @fieldName Last error
     * @widget textarea
     */
    lastError?: string;

    /**
     * The moment the email was delivered.
     * 
     * @fieldName Sent at
     * @widget date
     */
    sentAt?: Date;

    /**
     * The moment the email was queued.
     * 
     * @fieldName Queued at
     * @createdAt
     * @queryOrderBy default asc
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the email was last updated.
     * 
     * @fieldName Updated at
     * @updatedAt
     * @queryOrderBy
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the queued email, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
