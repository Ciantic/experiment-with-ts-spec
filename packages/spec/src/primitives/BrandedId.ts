import type { $brand } from "zod";
import type { GUID } from "./GUID.ts";

/**
 * A GUID that is nominally distinct for each `Name`. See docs/primitives.md.
 *
 * @primitive
 * @pgtype uuid
 * @zod z.uuid().brand<Name>()
 */
export type BrandedId<Name extends string> = GUID & $brand<Name>;
