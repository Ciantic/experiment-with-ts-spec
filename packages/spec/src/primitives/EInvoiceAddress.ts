/**
 * A Finnish e-invoice address (verkkolaskuosoite / OVT): a routing address such
 * as `003712345678`, the operator scheme prefix followed by the business id.
 * See docs/invoice-sending.md.
 *
 * @graphql String
 */
export type EInvoiceAddress = string & { readonly __brand: "EInvoiceAddress" };
