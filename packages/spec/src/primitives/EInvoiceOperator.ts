/**
 * An e-invoice operator (välittäjätunnus): the intermediary that routes an
 * invoice on the network, one of these known operators plus any other string.
 * See docs/invoice-sending.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["maventa", "apix", "op", "basware"]).or(z.string())
 * @effect Schema.Union([Schema.Literals(["maventa", "apix", "op", "basware"]), Schema.String])
 */
export type EInvoiceOperator =
    | "maventa"
    | "apix"
    | "op"
    | "basware"
    | (string & {});
