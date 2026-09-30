import type { Seller, SellerId } from "../src/domain/Seller.ts";
import type { EInvoiceAddress } from "../src/primitives/EInvoiceAddress.ts";

/** Sample sellers for a seeded development database. See docs/mockdata.md. */
export const sellers: Seller[] = [
    {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SellerId,
        name: "Firma Oy",
        businessId: "9876543-2",
        eInvoiceAddress: "003798765432" as EInvoiceAddress,
        eInvoiceOperator: "apix",
        language: "fi",
    },
    {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as SellerId,
        name: "Nordic Ab",
        businessId: "8765432-1",
        eInvoiceOperator: "basware",
        language: "sv",
    },
];
