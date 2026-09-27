import type { $brand } from "zod";

/**
 * An email address.
 *
 * @primitive
 * @zod z.email().brand<"Email">()
 */
export type Email = string & $brand<"Email">;
