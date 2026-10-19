/**
 * A UUID version 7, carried as a plain string. See docs/primitives.md.
 *
 * @primitive
 * @pgType uuid
 * @pgDefault uuidv7()
 * @zod z.uuidv7()
 */
export type UUIDv7 = string;
