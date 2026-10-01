/**
 * A globally unique identifier, carried as a plain string. See docs/primitives.md.
 *
 * @primitive
 * @pgtype uuid
 * @zod z.uuid()
 * @effect Schema.String.check(Schema.isUUID())
 */
export type GUID = string;
