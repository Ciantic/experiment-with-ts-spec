/**
 * An ISO 4217 currency code.
 *
 * The literal members are the currencies this spec models explicitly and are
 * offered as suggestions, but any other code is accepted as well.
 *
 * `string & {}` is used instead of plain `string` so the union is not collapsed
 * and the literal members stay visible for autocompletion and narrowing.
 */
export type Currency =
    | "EUR"
    | "USD"
    | "GBP"
    | "SEK"
    | (string & {});
