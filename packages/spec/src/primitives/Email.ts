import type { $brand } from "zod";

/**
 * An email address.
 *
 * @primitive
 * @pgtype text
 * @zod z.email().brand<"Email">()
 */
export type Email = string & $brand<"Email">;
