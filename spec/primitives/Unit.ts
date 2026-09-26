/**
 * A unit of measure.
 *
 * The literal members are the known units and are offered as suggestions, but
 * any other string is accepted as well, so callers can use units this spec does
 * not know about.
 *
 * `string & {}` is used instead of plain `string`: an intersection with the
 * empty type is assignable to and from `string`, but is not identical to it, so
 * the union is not collapsed and the literal members stay visible for
 * autocompletion and narrowing.
 */
export type Unit =
    | "hours"
    | "pieces"
    | "kg"
    | "liters"
    | "meters"
    | (string & {});
