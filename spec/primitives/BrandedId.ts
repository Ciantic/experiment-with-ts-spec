import type { GUID } from "./GUID.js";

/**
 * A GUID that is nominally distinct for each `Name`, so that identifiers of
 * different entities cannot be assigned to one another.
 */
export type BrandedId<Name extends string> = GUID & { readonly __brand: Name };
