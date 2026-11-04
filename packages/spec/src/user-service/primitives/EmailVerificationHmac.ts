import type { Brand } from "../../primitives/Brand.ts";

/**
 * The server-secret HMAC of the address a verification link was mailed to, so the link and the address must match.
 *
 * @primitive
 * @pgType text
 * @zod z.string().regex(/^[a-f0-9]{64}$/).brand<"EmailVerificationHmac">()
 */
export type EmailVerificationHmac = string & Brand<"EmailVerificationHmac">;
