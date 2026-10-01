import type { Brand } from "./Brand.ts";

/**
 * An email address.
 *
 * @primitive
 * @pgtype text
 * @zod z.email().brand<"Email">()
 * @effect Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)).pipe(Schema.brand("Email"))
 */
export type Email = string & Brand<"Email">;
