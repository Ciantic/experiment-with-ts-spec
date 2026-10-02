import type { BrandedId } from "../primitives/BrandedId.ts";
import type { EInvoiceAddress } from "../primitives/EInvoiceAddress.ts";
import type { EInvoiceOperator } from "../primitives/EInvoiceOperator.ts";
import type { Language } from "../primitives/Language.ts";
import type { Version } from "../primitives/Version.ts";

/** The unique identifier for a customer. */
export type CustomerId = BrandedId<"CustomerId">;

/**
 * A customer that invoices can be issued to.
 * 
 * @table customer
 */
export interface Customer {
    /**
     * The unique identifier for the customer.
     * 
     * @fieldName ID
     * @generated
     * @primaryKey
     * @widget text
     */
    id: CustomerId;

    /**
     * The display name of the customer.
     * 
     * @fieldName Name
     * @widget text
     */
    name: string;

    /**
     * The email address invoices are sent to.
     * 
     * @fieldName Email
     * @widget text
     */
    email: string;

    /**
     * The first line of the customer's billing address.
     * 
     * @fieldName Address
     * @widget text
     */
    address: string;

    /**
     * The business identifier of the customer, such as a VAT number.
     * 
     * @fieldName Business ID
     * @widget text
     */
    businessId: string;

    /**
     * The customer's Finnish e-invoice address (verkkolaskuosoite).
     * 
     * @fieldName E-invoice address
     * @widget text
     */
    eInvoiceAddress?: EInvoiceAddress;

    /**
     * The operator that routes the customer's e-invoices.
     * 
     * @fieldName E-invoice operator
     * @widget text
     */
    eInvoiceOperator?: EInvoiceOperator;

    /**
     * The language this customer's invoices are rendered in by default.
     * 
     * @fieldName Language
     * @widget select
     */
    language?: Language;

    /**
     * The moment the customer record was created.
     * 
     * @fieldName Created at
     * @createdAt
     * @widget date
     */
    createdAt?: Date;

    /**
     * The moment the customer record was last updated.
     * 
     * @fieldName Updated at
     * @updatedAt
     * @widget date
     */
    updatedAt?: Date;

    /**
     * The revision of the customer record, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @default 0
     * @widget number
     */
    version?: Version;
}
