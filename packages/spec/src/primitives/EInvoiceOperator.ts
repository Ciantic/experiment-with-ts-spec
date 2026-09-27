/**
 * An e-invoice operator (välittäjätunnus): the intermediary that routes an
 * invoice on the network, one of these known operators plus any other string.
 * See docs/invoice-sending.md.
 */
export type EInvoiceOperator =
    | "maventa"
    | "apix"
    | "op"
    | "basware"
    | (string & {});
