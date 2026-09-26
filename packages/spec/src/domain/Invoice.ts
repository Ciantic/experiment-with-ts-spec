import type { BrandedId } from "../primitives/BrandedId.js";
import type { Money } from "../primitives/Money.js";
import type { Version } from "../primitives/Version.js";
import type { Customer } from "./Customer.js";
import type { InvoiceRow } from "./InvoiceRow.js";

/** The unique identifier for an invoice. */
export type InvoiceId = BrandedId<"InvoiceId">;

/**
 * Invoice-level formulas: one same-row total plus two cross-table aggregates.
 *
 * @formula
 */
export type InvoiceFormula = "invoiceNetAmount" | "invoiceTaxAmount" | "invoiceTotalAmount";

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
     * The net amount of the invoice, before taxes.
     * 
     * @fieldName Net amount
     * @computed storage=stored formula=invoiceNetAmount
     * @widget number
     */
    netAmount: Money;

    /**
     * The tax amount of the invoice.
     * 
     * @fieldName Tax amount
     * @computed storage=stored formula=invoiceTaxAmount
     * @widget number
     */
    taxAmount: Money;

    /**
     * The total amount of the invoice, including taxes.
     * 
     * @fieldName Total amount
     * @computed storage=stored formula=invoiceTotalAmount
     * @widget number
     */
    totalAmount: Money;

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

    /**
     * The moment the invoice draft was created.
     * 
     * @fieldName Created at
     * @generated
     * @default now()
     * @widget date
     */
    createdAt?: Date;

    /**
     * The moment the invoice draft was last updated.
     * 
     * @fieldName Updated at
     * @computed storage=stored formula=now
     * @default now()
     * @widget date
     */
    updatedAt?: Date;

    /**
     * The revision of the invoice, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @default 0
     * @widget number
     */
    version?: Version;
}
