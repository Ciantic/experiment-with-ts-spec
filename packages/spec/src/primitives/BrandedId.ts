import type { GUID } from "./GUID.js";

/**
 * A GUID that is nominally distinct for each `Name`. See docs/primitives.md.
 *
 * @graphql ID
 */
export type BrandedId<Name extends string> = GUID & { readonly __brand: Name };
