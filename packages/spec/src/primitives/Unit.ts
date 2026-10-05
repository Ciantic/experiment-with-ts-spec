/**
 * A unit of measure: these known units plus any other string. See docs/primitives.md.
 *
 * @primitive
 * @pgType text
 * @zod z.enum(["hours", "pieces", "kg", "liters", "meters"]).or(z.string())
 */
export type Unit =
    | "hours"
    | "pieces"
    | "kg"
    | "liters"
    | "meters"
    | (string & {});
