import type { GUID } from "../primitives/GUID.js";

/**
 * A customer that invoices can be issued to.
 */
export interface Customer {
    /**
     * The unique identifier for the customer.
     * 
     * @fieldName ID
     * @readonly
     * @widget text
     */
    id: GUID;

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
}
