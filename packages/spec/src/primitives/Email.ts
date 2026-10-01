import type { Brand } from "./Brand.ts";

/**
 * An email address.
 *
 * @primitive
 * @pgtype text
 * @zod z.email().brand<"Email">()
 */
export type Email = string & Brand<"Email">;
