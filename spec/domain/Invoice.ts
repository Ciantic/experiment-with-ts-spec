import type { BrandedId } from "../primitives/BrandedId.js";
import type { Price } from "../primitives/Price.js";
import type { Customer } from "./Customer.js";
import type { InvoiceRow } from "./InvoiceRow.js";

/** The unique identifier for an invoice. */
export type InvoiceId = BrandedId<"InvoiceId">;

/**
 * An invoice.
 * 
 * @table invoice
 */
export interface Invoice {
    /**
     * The unique identifier for the invoice.
     * 
     * @fieldName ID
     * @generated
     * @widget text
     */
    id: InvoiceId;

    /**
     * The human-readable invoice number shown to the customer.
     * 
     * @fieldName Invoice number
     * @generated
     * @unique
     * @widget text
     */
    number: string;

    /**
     * The customer this invoice is issued to.
     * 
     * @fieldName Customer
     * @relation Customer
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
     * The current lifecycle status of the invoice.
     * 
     * @fieldName Status
     * @widget select
     */
    status: InvoiceStatus;

    /**
     * The net amount of the invoice, before taxes.
     * 
     * @fieldName Net amount
     * @computed storage=stored formula=invoiceNetAmount
     * @widget number
     */
    netAmount: Price;

    /**
     * The tax amount of the invoice.
     * 
     * @fieldName Tax amount
     * @computed storage=stored formula=invoiceTaxAmount
     * @widget number
     */
    taxAmount: Price;

    /**
     * The total amount of the invoice, including taxes.
     * 
     * @fieldName Total amount
     * @computed storage=stored formula=invoiceTotalAmount
     * @widget number
     */
    totalAmount: Price;

    /**
     * The line items that make up the invoice.
     * 
     * @fieldName Rows
     * @children InvoiceRow
     * @widget table
     */
    rows: InvoiceRow[];

    /**
     * Free-form notes to display on the invoice.
     * 
     * @fieldName Notes
     * @widget textarea
     */
    notes: string;
}

/** The lifecycle status of an invoice. */
export type InvoiceStatus =
    | "draft"
    | "sent"
    | "paid"
    | "overdue"
    | "cancelled";
