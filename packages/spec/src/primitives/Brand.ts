import type { $brand } from "zod";

/**
 * A nominal brand a spec primitive carries.
 */
export type Brand<Name extends string> = $brand<Name>;
