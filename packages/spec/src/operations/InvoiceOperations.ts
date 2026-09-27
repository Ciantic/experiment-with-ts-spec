import type { Invoice } from "../domain/Invoice.js";
import type { EInvoiceAddress } from "../primitives/EInvoiceAddress.js";
import type { EInvoiceOperator } from "../primitives/EInvoiceOperator.js";
import type { Language } from "../primitives/Language.js";

/**
 * An electronic invoice serialization format: these known formats plus any
 * other string. See docs/invoice-sending.md.
 */
export type InvoiceFormat =
    | "finvoice"
    | "peppolBis"
    | "ubl"
    | (string & {});

/**
 * How an invoice is delivered: these known channels plus any other string.
 * See docs/invoice-sending.md.
 */
export type InvoiceDelivery =
    | "eInvoice"
    | "email"
    | "print"
    | "download"
    | (string & {});

export interface InvoiceOperations {
    /** Issue the invoice and deliver it. See docs/invoice-sending.md. */
    sendInvoice(opts: {
        invoice: Invoice;
        format?: InvoiceFormat;
        delivery?: InvoiceDelivery;
        eInvoiceAddress?: EInvoiceAddress;
        eInvoiceOperator?: EInvoiceOperator;
        language?: Language;
        message?: string;
        replyTo?: string;
        attachPdf?: boolean;
    }): Promise<void>;
}