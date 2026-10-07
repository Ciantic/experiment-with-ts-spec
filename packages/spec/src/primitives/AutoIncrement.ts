import type { Brand } from "./Brand.ts";

/**
 * An integer key the database assigns at insert. See docs/auto-increment.md.
 *
 * @primitive
 * @pgType integer
 * @zod z.number().int().brand<Name>()
 */
export type AutoIncrement<Name extends string> = number & Brand<Name>;
