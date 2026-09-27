/**
 * A language an invoice is rendered in: these known languages plus any other
 * string. See docs/invoice-sending.md.
 *
 * @graphql String
 */
export type Language =
    | "fi"
    | "sv"
    | "en"
    | (string & {});
