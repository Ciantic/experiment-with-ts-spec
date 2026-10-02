import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Money } from "../primitives/Money.ts";
import type { Quantity } from "../primitives/Quantity.ts";
import type { TaxRate } from "../primitives/TaxRate.ts";
import type { Unit } from "../primitives/Unit.ts";
import type { Version } from "../primitives/Version.ts";
import type { InvoiceId } from "./Invoice.ts";

/** The unique identifier for an invoice row. */
export type InvoiceRowId = BrandedId<"InvoiceRowId">;

/**
 * A single line item on an invoice.
 * 
 * @table invoice_row
 */
export interface InvoiceRow {
    /**
     * The unique identifier for the row.
     * 
     * @fieldName ID
     * @generated
     * @widget text
     */
    id: InvoiceRowId;

    /**
     * The identifier of the invoice this row belongs to.
     * 
     * @fieldName Invoice
     * @generated
     * @widget text
     */
    invoiceId: InvoiceId;

    /**
     * The description of the goods or services on this row.
     * 
     * @fieldName Description
     * @widget text
     */
    description?: string;

    /**
     * The number of units billed on this row.
     * 
     * @fieldName Quantity
     * @widget number
     */
    quantity?: Quantity;

    /**
     * The unit of measure the quantity is expressed in, such as hours or pieces.
     * 
     * @fieldName Unit
     * @widget text
     */
    unit?: Unit;

    /**
     * The price per unit, in the invoice currency.
     * 
     * @fieldName Unit price
     * @widget number
     */
    unitPrice?: Money;

    /**
     * The tax rate applied to this row, as a fraction (0.255 is 25.5%).
     * 
     * @fieldName Tax rate
     * @widget number
     */
    taxRate?: TaxRate;

    /**
     * The net amount for this row, before taxes.
     * 
     * @fieldName Net amount
     * @computed
     * @pgtrigger NEW."netAmount" := round(NEW."quantity" * NEW."unitPrice", 2)
     * @widget number
     */
    netAmount?: Money;

    /**
     * The tax amount for this row.
     * 
     * @fieldName Tax amount
     * @computed
     * @pgtrigger NEW."taxAmount" := round(NEW."netAmount" * NEW."taxRate", 2)
     * @widget number
     */
    taxAmount?: Money;

    /**
     * The total amount for this row, including taxes.
     * 
     * @fieldName Total amount
     * @computed
     * @pgtrigger NEW."totalAmount" := NEW."netAmount" + NEW."taxAmount"
     * @widget number
     */
    totalAmount?: Money;

    /**
     * The moment the row was created.
     * 
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt?: Date;

    /**
     * The moment the row was last updated.
     * 
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt?: Date;

    /**
     * The revision of the row, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @default 0
     * @widget number
     */
    version?: Version;
}
