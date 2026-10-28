import type { Brand } from "../../primitives/Brand.ts";

/**
 * The SHA-256 digest of an opaque session token, stored instead of the token itself.
 *
 * @primitive
 * @pgType text
 * @zod z.string().regex(/^[a-f0-9]{64}$/).brand<"UserSessionTokenHash">()
 */
export type UserSessionTokenHash = string & Brand<"UserSessionTokenHash">;
