import type { Brand } from "../../primitives/Brand.ts";

/**
 * The opaque one-time token a login link carries, before it is hashed for storage.
 *
 * @primitive
 * @pgType text
 * @zod z.string().regex(/^[A-Za-z0-9_-]{43}$/).brand<"LoginLinkToken">()
 */
export type LoginLinkToken = string & Brand<"LoginLinkToken">;
