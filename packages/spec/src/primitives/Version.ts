import type { $brand } from "zod";

/**
 * A monotonic record revision, used as an optimistic-lock precondition. See docs/versioning.md.
 *
 * @primitive
 * @pgtype int8
 * @zod z.bigint().brand<"Version">()
 */
export type Version = bigint & $brand<"Version">;
