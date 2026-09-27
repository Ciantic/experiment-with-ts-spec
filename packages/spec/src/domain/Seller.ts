import type { BrandedId } from "../primitives/BrandedId.js";
import type { EInvoiceAddress } from "../primitives/EInvoiceAddress.js";
import type { EInvoiceOperator } from "../primitives/EInvoiceOperator.js";
import type { Language } from "../primitives/Language.js";
import type { Version } from "../primitives/Version.js";

/** The unique identifier for a seller. */
export type SellerId = BrandedId<"SellerId">;

/**
 * The company that issues invoices.
 * 
 * @table seller
 */
export interface Seller {
    /**
     * The unique identifier for the seller.
     * 
     * @fieldName ID
     * @generated
     * @widget text
     */
    id: SellerId;

    /**
     * The display name of the seller.
     * 
     * @fieldName Name
     * @widget text
     */
    name: string;

    /**
     * The business identifier of the seller, such as a VAT number.
     * 
     * @fieldName Business ID
     * @widget text
     */
    businessId: string;

    /**
     * The seller's Finnish e-invoice address (verkkolaskuosoite).
     * 
     * @fieldName E-invoice address
     * @widget text
     */
    eInvoiceAddress?: EInvoiceAddress;

    /**
     * The operator that routes the seller's e-invoices.
     * 
     * @fieldName E-invoice operator
     * @widget text
     */
    eInvoiceOperator?: EInvoiceOperator;

    /**
     * The language this seller's invoices are rendered in by default.
     * 
     * @fieldName Language
     * @widget select
     */
    language?: Language;

    /**
     * The moment the seller record was created.
     * 
     * @fieldName Created at
     * @generated
     * @default now()
     * @widget date
     */
    createdAt?: Date;

    /**
     * The moment the seller record was last updated.
     * 
     * @fieldName Updated at
     * @computed storage=stored formula=now
     * @default now()
     * @widget date
     */
    updatedAt?: Date;

    /**
     * The revision of the seller record, incremented on every write.
     * 
     * @fieldName Version
     * @version
     * @default 0
     * @widget number
     */
    version?: Version;
}
