import type { BrandedId } from "../primitives/BrandedId.js";
import type { Money } from "../primitives/Money.js";
import type { Customer } from "./Customer.js";
import type { InvoiceId } from "./Invoice.js";
import type { InvoiceSentRow } from "./InvoiceSentRow.js";

/** The unique identifier for a sent invoice. */
export type InvoiceSentId = BrandedId<"InvoiceSentId">;

/**
 * An invoice as issued, frozen at the moment it was sent.
 *
 * See docs/invoice-snapshotting.md.
 *
 * @table invoice_sent
 */
export interface InvoiceSent {
    /**
     * The unique identifier for the sent invoice.
     * 
     * @fieldName ID
     * @generated
     * @widget text
     */
    id: InvoiceSentId;

    /**
     * The draft this sent invoice was issued from.
     * 
     * @fieldName Invoice
     * @generated
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
     * @inlined Customer
     * @widget select
     */
    customer?: Customer;

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
     * @children InvoiceSentRow
     * @widget table
     */
    rows: InvoiceSentRow[];
}
