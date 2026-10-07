import type { BrandedId } from "../primitives/BrandedId.ts";
import type { Money } from "../primitives/Money.ts";
import type { Quantity } from "../primitives/Quantity.ts";
import type { TaxRate } from "../primitives/TaxRate.ts";
import type { Unit } from "../primitives/Unit.ts";
import type { InvoiceSentId } from "./InvoiceSent.ts";

/** The unique identifier for a sent invoice row. */
export type InvoiceSentRowId = BrandedId<"InvoiceSentRowId">;

/**
 * A single line item on a sent invoice.
 * 
 * @pgTable invoice_sent_row
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 */
export interface InvoiceSentRow {
    /**
     * The unique identifier for the row.
     * 
     * @fieldName ID
     * @primaryKey
     * @widget text
     */
    id: InvoiceSentRowId;

    /**
     * The identifier of the sent invoice this row belongs to.
     * 
     * @fieldName Invoice
     * @foreignKey InvoiceSent
     * @widget text
     */
    invoiceSentId: InvoiceSentId;

    /**
     * The description of the goods or services on this row.
     * 
     * @fieldName Description
     * @widget text
     */
    description: string;

    /**
     * The number of units billed on this row.
     * 
     * @fieldName Quantity
     * @widget number
     */
    quantity: Quantity;

    /**
     * The unit of measure the quantity is expressed in, such as hours or pieces.
     * 
     * @fieldName Unit
     * @widget text
     */
    unit: Unit;

    /**
     * The price per unit, in the invoice currency.
     * 
     * @fieldName Unit price
     * @widget number
     */
    unitPrice: Money;

    /**
     * The tax rate applied to this row, as a fraction (0.255 is 25.5%).
     * 
     * @fieldName Tax rate
     * @widget number
     */
    taxRate: TaxRate;

    /**
     * The net amount for this row, before taxes.
     * 
     * @fieldName Net amount
     * @computed
     * @pgTrigger NEW."netAmount" := round(NEW."quantity" * NEW."unitPrice", 2)
     * @widget number
     */
    netAmount: Money;

    /**
     * The tax amount for this row.
     * 
     * @fieldName Tax amount
     * @computed
     * @pgTrigger NEW."taxAmount" := round(NEW."netAmount" * NEW."taxRate", 2)
     * @widget number
     */
    taxAmount: Money;

    /**
     * The total amount for this row, including taxes.
     * 
     * @fieldName Total amount
     * @computed
     * @pgTrigger NEW."totalAmount" := NEW."netAmount" + NEW."taxAmount"
     * @widget number
     */
    totalAmount: Money;
}
