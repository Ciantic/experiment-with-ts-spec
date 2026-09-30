import type { Invoice } from "../domain/Invoice.ts";
import type { EInvoiceAddress } from "../primitives/EInvoiceAddress.ts";
import type { EInvoiceOperator } from "../primitives/EInvoiceOperator.ts";
import type { Language } from "../primitives/Language.ts";

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