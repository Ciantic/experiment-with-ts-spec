import type { Brand } from "../../primitives/Brand.ts";

/**
 * The SHA-256 digest of a one-time login token, stored instead of the token itself.
 *
 * @primitive
 * @pgType text
 * @zod z.string().regex(/^[a-f0-9]{64}$/).brand<"LoginLinkTokenHash">()
 */
export type LoginLinkTokenHash = string & Brand<"LoginLinkTokenHash">;
