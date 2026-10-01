import type { Brand } from "./Brand.ts";

/**
 * A monotonic record revision, used as an optimistic-lock precondition. See docs/versioning.md.
 *
 * @primitive
 * @pgtype int8
 * @zod z.bigint().brand<"Version">()
 */
export type Version = bigint & Brand<"Version">;
