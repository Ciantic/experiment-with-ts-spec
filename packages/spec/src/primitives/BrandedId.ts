import type { Brand } from "./Brand.ts";
import type { GUID } from "./GUID.ts";

/**
 * A GUID that is nominally distinct for each `Name`. See docs/primitives.md.
 *
 * @primitive
 * @pgtype uuid
 * @zod z.uuid().brand<Name>()
 * @effect Schema.String.check(Schema.isUUID()).pipe(Schema.brand<Name>(name as never))
 */
export type BrandedId<Name extends string> = GUID & Brand<Name>;
