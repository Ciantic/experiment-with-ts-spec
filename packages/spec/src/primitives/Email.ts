import type { Brand } from "./Brand.ts";

/**
 * An email address.
 *
 * @primitive
 * @pgType text
 * @zod z.email().brand<"Email">()
 */
export type Email = string & Brand<"Email">;
