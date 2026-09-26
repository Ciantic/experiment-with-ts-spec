import type { BrandedId } from "../primitives/BrandedId.js";
import type { Money } from "../primitives/Money.js";
import type { Quantity } from "../primitives/Quantity.js";
import type { TaxRate } from "../primitives/TaxRate.js";
import type { Unit } from "../primitives/Unit.js";
import type { InvoiceId } from "./Invoice.js";

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
     * @computed storage=stored formula=rowNetAmount
     * @widget number
     */
    netAmount: Money;

    /**
     * The tax amount for this row.
     * 
     * @fieldName Tax amount
     * @computed storage=stored formula=rowTaxAmount
     * @widget number
     */
    taxAmount: Money;

    /**
     * The total amount for this row, including taxes.
     * 
     * @fieldName Total amount
     * @computed storage=stored formula=rowTotalAmount
     * @widget number
     */
    totalAmount: Money;
}
