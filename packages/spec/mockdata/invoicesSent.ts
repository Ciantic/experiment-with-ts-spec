import type { Customer, CustomerId } from "../src/invoicing-service/Customer.ts";
import type { InvoiceId } from "../src/invoicing-service/Invoice.ts";
import type { InvoiceSent, InvoiceSentId } from "../src/invoicing-service/InvoiceSent.ts";
import type { Seller, SellerId } from "../src/invoicing-service/Seller.ts";
import type { TenantId } from "../src/invoicing-service/Tenant.ts";
import type { EInvoiceAddress } from "../src/invoicing-service/primitives/EInvoiceAddress.ts";
import type { Money } from "../src/invoicing-service/primitives/Money.ts";
import type { Version } from "../src/primitives/Version.ts";
import { invoiceSentRows } from "./invoiceSentRows.ts";

/** The customer as frozen onto the sent invoice, not the live record. */
const acmeSnapshot: Customer = {
    id: "11111111-1111-7111-8111-111111111111" as CustomerId,
    tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
    name: "Acme Oy",
    email: "billing@acme.example",
    address: "Mannerheimintie 1, 00100 Helsinki",
    businessId: "1234567-8",
    eInvoiceAddress: "003712345678" as EInvoiceAddress,
    eInvoiceOperator: "maventa",
    language: "fi",
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    updatedAt: new Date("2026-01-01T08:00:00.000Z"),
    version: 0n as Version,
};

/** The seller as frozen onto the sent invoice, not the live record. */
const firmaSnapshot: Seller = {
    id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" as SellerId,
    tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
    name: "Firma Oy",
    businessId: "9876543-2",
    eInvoiceAddress: "003798765432" as EInvoiceAddress,
    eInvoiceOperator: "apix",
    language: "fi",
    createdAt: new Date("2026-01-01T07:00:00.000Z"),
    updatedAt: new Date("2026-01-01T07:00:00.000Z"),
    version: 0n as Version,
};

/** Sample sent invoices for a seeded development database. See docs/mockdata.md. */
export const invoicesSent: InvoiceSent[] = [
    {
        id: "00000000-0000-7000-8000-000000000301" as InvoiceSentId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        invoiceId: "00000000-0000-7000-8000-000000000101" as InvoiceId,
        sentAt: new Date("2026-01-06T09:15:00.000Z"),
        number: "2026-0001",
        customer: acmeSnapshot,
        seller: firmaSnapshot,
        language: "fi",
        issueDate: new Date("2026-01-05T00:00:00.000Z"),
        dueDate: new Date("2026-01-19T00:00:00.000Z"),
        notes: "Sent as an e-invoice.",
        netAmount: "100.00" as Money,
        taxAmount: "25.50" as Money,
        totalAmount: "125.50" as Money,
        rows: invoiceSentRows,
    },
];
