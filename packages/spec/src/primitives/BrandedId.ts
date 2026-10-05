import type { Brand } from "./Brand.ts";
import type { GUID } from "./GUID.ts";

/**
 * A GUID that is nominally distinct for each `Name`. See docs/primitives.md.
 *
 * @primitive
 * @pgType uuid
 * @zod z.uuid().brand<Name>()
 */
export type BrandedId<Name extends string> = GUID & Brand<Name>;
