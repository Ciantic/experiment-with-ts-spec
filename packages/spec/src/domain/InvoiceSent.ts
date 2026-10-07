import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Language } from "../primitives/Language.ts";
import type { Money } from "../primitives/Money.ts";
import type { Customer } from "./Customer.ts";
import type { InvoiceId } from "./Invoice.ts";
import type { InvoiceSentRow } from "./InvoiceSentRow.ts";
import type { Seller } from "./Seller.ts";

/** The unique identifier for a sent invoice. */
export type InvoiceSentId = BrandedId<"InvoiceSentId">;

/**
 * An invoice as issued, frozen at the moment it was sent.
 *
 * See docs/invoice-snapshotting.md.
 *
 * @pgTable invoice_sent
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 */
export interface InvoiceSent {
    /**
     * The unique identifier for the sent invoice.
     * 
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: InvoiceSentId;

    /**
     * The draft this sent invoice was issued from.
     * 
     * @fieldName Invoice
     * @foreignKey Invoice
     * @widget text
     */
    invoiceId: InvoiceId;

    /**
     * The moment the invoice was sent.
     * 
     * @fieldName Sent at
     * @widget date
     */
    sentAt: Date;

    /**
     * The human-readable invoice number shown to the customer.
     * 
     * @fieldName Invoice number
     * @unique
     * @widget text
     */
    number: string;

    /**
     * The customer details as they were at send time.
     * 
     * @fieldName Customer
     * @inlined
     * @widget select
     */
    customer?: Customer;

    /**
     * The seller details as they were at send time.
     * 
     * @fieldName Seller
     * @inlined
     * @widget select
     */
    seller?: Seller;

    /**
     * The language the invoice was rendered in when it was sent.
     * 
     * @fieldName Language
     * @widget select
     */
    language: Language;

    /**
     * The date the invoice was issued.
     * 
     * @fieldName Issue date
     * @widget date
     */
    issueDate: Date;

    /**
     * The date by which payment is due.
     * 
     * @fieldName Due date
     * @widget date
     */
    dueDate: Date;

    /**
     * Free-form notes to display on the invoice.
     * 
     * @fieldName Notes
     * @widget textarea
     */
    notes: string;

    /**
     * The net amount of the invoice, before taxes.
     * 
     * @fieldName Net amount
     * @widget number
     */
    netAmount: Money;

    /**
     * The tax amount of the invoice.
     * 
     * @fieldName Tax amount
     * @widget number
     */
    taxAmount: Money;

    /**
     * The total amount of the invoice, including taxes.
     * 
     * @fieldName Total amount
     * @widget number
     */
    totalAmount: Money;

    /**
     * The line items that make up the invoice.
     * 
     * @fieldName Rows
     * @children
     * @widget table
     */
    rows: InvoiceSentRow[];
}
