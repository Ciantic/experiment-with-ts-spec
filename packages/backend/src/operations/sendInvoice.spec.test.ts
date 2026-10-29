// Generated for implementation by: scripts/backend/generate-spec-tests.ts
import { afterEach, describe, expect, it } from "vitest";
import type { Customer, CustomerId } from "spec/invoicing-service/Customer.ts";
import type { Invoice, InvoiceId } from "spec/invoicing-service/Invoice.ts";
import type { Money } from "spec/invoicing-service/primitives/Money.ts";
import type { Seller, SellerId } from "spec/invoicing-service/Seller.ts";
import type { TenantId } from "spec/invoicing-service/Tenant.ts";
import type { Version } from "spec/primitives/Version.ts";
import { InvoiceDetailsError } from "sdk/errors.ts";
import { createAppContext, createInvoice, createTenant, resultRows, type SqlExecutor } from "infra";
import { sendInvoice } from "./sendInvoice.ts";

const tenantId = "0192f0b0-0000-7000-8000-000000000001" as TenantId;
const invoiceId = "0192f0b0-0000-7000-8000-000000000002" as InvoiceId;
const customerId = "0192f0b0-0000-7000-8000-000000000003" as CustomerId;
const sellerId = "0192f0b0-0000-7000-8000-000000000004" as SellerId;
const at = new Date("2026-01-01T00:00:00Z");

const customer: Customer = {
    id: customerId,
    tenantId,
    name: "Fixture customer",
    email: "customer@example.com",
    address: "Fixture street 1",
    businessId: "FI-1234567",
    createdAt: at,
    updatedAt: at,
    version: 0n as Version,
};

const seller: Seller = {
    id: sellerId,
    tenantId,
    name: "Fixture seller",
    businessId: "FI-7654321",
    createdAt: at,
    updatedAt: at,
    version: 0n as Version,
};

/** A complete draft, so a test can drop the detail it wants the send to miss. */
function draft(): Invoice {
    return {
        id: invoiceId,
        tenantId,
        number: "FIXTURE-1",
        customer,
        seller,
        language: "en",
        issueDate: at,
        dueDate: at,
        netAmount: "100.00" as Money,
        taxAmount: "24.00" as Money,
        totalAmount: "124.00" as Money,
        notes: "Fixture notes",
        createdAt: at,
        updatedAt: at,
        version: 0n as Version,
    };
}

/** The value without one property, so a test can drop the detail a send requires. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
    const { [key]: _dropped, ...rest } = value;
    return rest;
}

/** The rows one table holds. */
async function rows(db: SqlExecutor, sql: string): Promise<Array<Record<string, unknown>>> {
    return resultRows(await db.query(sql));
}

/** A fresh schema holding the tenant and invoice the send refers to. */
async function fixture(): Promise<{ db: SqlExecutor; close: () => Promise<void> }> {
    const app = await createAppContext();
    await createTenant(app.database, [{ id: tenantId, name: "Fixture tenant" }]);
    await createInvoice(app.database, [{ id: invoiceId, tenantId }]);
    return { db: app.database, close: () => app.database.close() };
}

let open: { db: SqlExecutor; close: () => Promise<void> } | undefined;

afterEach(async () => {
    await open?.close();
    open = undefined;
});

describe("Sending an invoice", () => {
    it("Sends the invoice successfully", async () => {
        open = await fixture();
        const invoice = draft();

        const answer = await sendInvoice({ db: open.db }, { invoice });

        expect(
            await rows(
                open.db,
                'select "id", "invoiceId", "number", "customerEmail", "language", "notes" from "invoice_sent"',
            ),
        ).toEqual([
            {
                id: answer.invoiceSentId,
                invoiceId: invoice.id,
                number: invoice.number,
                customerEmail: customer.email,
                language: invoice.language,
                notes: invoice.notes,
            },
        ]);
        expect(await rows(open.db, 'select "id", "from", "to", "subject", "status" from "email"')).toEqual([
            {
                id: answer.emailId,
                from: "billing@example.com",
                to: customer.email,
                subject: `Invoice ${invoice.number}`,
                status: "pending",
            },
        ]);
    });
    it("Throws when the invoice is missing details", async () => {
        open = await fixture();
        const details: Array<keyof Invoice> = [
            "customer",
            "number",
            "issueDate",
            "dueDate",
            "netAmount",
            "taxAmount",
            "totalAmount",
        ];

        for (const detail of details) {
            await expect(
                sendInvoice({ db: open.db }, { invoice: without(draft(), detail) as Invoice }),
            ).rejects.toBeInstanceOf(InvoiceDetailsError);
        }

        expect(await rows(open.db, 'select "id" from "invoice_sent"')).toEqual([]);
        expect(await rows(open.db, 'select "id" from "email"')).toEqual([]);
    });
});
