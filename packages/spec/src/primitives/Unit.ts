/**
 * A unit of measure: these known units plus any other string. See docs/primitives.md.
 *
 * @graphql String
 */
export type Unit =
    | "hours"
    | "pieces"
    | "kg"
    | "liters"
    | "meters"
    | (string & {});
