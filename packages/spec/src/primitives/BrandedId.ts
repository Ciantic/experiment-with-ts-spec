import type { Brand } from "./Brand.ts";
import type { UUIDv7 } from "./UUIDv7.ts";

/**
 * A UUIDv7 that is nominally distinct for each `Name`. See docs/primitives.md.
 *
 * @primitive
 * @pgType uuid
 * @zod z.uuidv7().brand<Name>()
 */
export type BrandedId<Name extends string> = UUIDv7 & Brand<Name>;
