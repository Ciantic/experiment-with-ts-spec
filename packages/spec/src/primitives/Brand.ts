import type { Brand as EffectBrand } from "effect";
import type { $brand } from "zod";

/**
 * A nominal brand a spec primitive carries. It is the union of Zod's `$brand`
 * and Effect's `Brand.Brand`, so a value decoded by either schema library is
 * assignable to the spec type. See docs/primitives.md.
 */
export type Brand<Name extends string> = $brand<Name> | EffectBrand.Brand<Name>;
