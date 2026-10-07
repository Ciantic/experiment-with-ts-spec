import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Language } from "../primitives/Language.ts";
import type { Money } from "../primitives/Money.ts";
import type { Version } from "../primitives/Version.ts";
import type { Customer, CustomerId } from "./Customer.ts";
import type { InvoiceRow } from "./InvoiceRow.ts";
import type { Seller, SellerId } from "./Seller.ts";

/** The unique identifier for an invoice. */
export type InvoiceId = BrandedId<"InvoiceId">;

/**
 * An invoice.
 * 
 * @pgTable invoice
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 */
export interface Invoice {
    /**
     * The unique identifier for the invoice.
     * 
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: InvoiceId;

    /**
     * The human-readable invoice number shown to the customer.
     * 
     * @fieldName Invoice number
     * @unique
     * @widget text
     */
    number?: string;

    /**
     * The identifier of the customer this invoice is issued to.
     * 
     * @fieldName Customer ID
     * @queryFilter
     * @foreignKey Customer
     * @widget text
     */
    customerId?: CustomerId;

    /**
     * The customer this invoice is issued to.
     * 
     * @fieldName Customer
     * @relation
     * @widget select
     */
    customer?: Customer;

    /**
     * The identifier of the seller this invoice is issued by.
     * 
     * @fieldName Seller ID
     * @queryFilter
     * @foreignKey Seller
     * @widget text
     */
    sellerId?: SellerId;

    /**
     * The seller this invoice is issued by.
     * 
     * @fieldName Seller
     * @relation
     * @widget select
     */
    seller?: Seller;

    /**
     * The language this invoice is rendered in.
     * 
     * @fieldName Language
     * @widget select
     */
    language?: Language;

    /**
     * The date the invoice was issued.
     * 
     * @fieldName Issue date
     * @queryWhere gte lte
     * @widget date
     */
    issueDate?: Date;

    /**
     * The date by which payment is due.
     * 
     * @fieldName Due date
     * @widget date
     */
    dueDate?: Date;

    /**
     * The net amount of the invoice, before taxes.
     * 
     * @fieldName Net amount
     * @computed
     * @pgTrigger after insert or update or delete on InvoiceRow: update "invoice" set "netAmount" = (select coalesce(sum("netAmount"), 0) from "invoice_row" where "invoiceId" = "invoice"."id") where "id" in (OLD."invoiceId", NEW."invoiceId")
     * @widget number
     */
    netAmount?: Money;

    /**
     * The tax amount of the invoice.
     * 
     * @fieldName Tax amount
     * @computed
     * @pgTrigger after insert or update or delete on InvoiceRow: update "invoice" set "taxAmount" = (select coalesce(sum("taxAmount"), 0) from "invoice_row" where "invoiceId" = "invoice"."id") where "id" in (OLD."invoiceId", NEW."invoiceId")
     * @widget number
     */
    taxAmount?: Money;

    /**
     * The total amount of the invoice, including taxes.
     * 
     * @fieldName Total amount
     * @computed
     * @pgVirtual "netAmount" + "taxAmount"
     * @widget number
     */
    totalAmount?: Money;

    /**
     * The line items that make up the invoice.
     * 
     * @fieldName Rows
     * @children
     * @widget table
     */
    rows?: InvoiceRow[];

    /**
     * Free-form notes to display on the invoice.
     * 
     * @fieldName Notes
     * @widget textarea
     */
    notes?: string;

    /**
     * The moment the invoice draft was created.
     * 
     * @fieldName Created at
     * @createdAt
     * @queryOrderBy default asc
     * @widget date
     */
    createdAt: Date;

    /**
     * The moment the invoice draft was last updated.
     * 
     * @fieldName Updated at
     * @updatedAt
     * @queryOrderBy
     * @widget date
     */
    updatedAt: Date;

    /**
     * The revision of the invoice, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @pgDefault 0
     * @widget number
     */
    version: Version;
}
