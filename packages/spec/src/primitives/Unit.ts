/**
 * A unit of measure: these known units plus any other string. See docs/primitives.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["hours", "pieces", "kg", "liters", "meters"]).or(z.string())
 * @effect Schema.Union([Schema.Literals(["hours", "pieces", "kg", "liters", "meters"]), Schema.String])
 */
export type Unit =
    | "hours"
    | "pieces"
    | "kg"
    | "liters"
    | "meters"
    | (string & {});
