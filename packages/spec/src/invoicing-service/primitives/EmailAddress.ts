import type { Brand } from "./Brand.ts";

/**
 * An email address.
 *
 * @primitive
 * @pgType text
 * @zod z.email().brand<"EmailAddress">()
 */
export type EmailAddress = string & Brand<"EmailAddress">;
