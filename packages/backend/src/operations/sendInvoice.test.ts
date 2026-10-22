/** Tests for the `sendInvoice` operation, over the seeded mock data. See docs/testing.md and docs/operations.md. */
import { afterEach, describe, expect, it } from "vitest";
import type { Invoice } from "spec/domain/Invoice.ts";
import type { Money } from "spec/primitives/Money.ts";
import { customers, invoices, sellers, tenants } from "spec/mockdata/index.ts";
import { InvoiceDetailsError } from "sdk/errors.ts";
import { createAppContext } from "../context.ts";
import { createCustomer, createInvoice, createSeller, createTenant } from "../db/repositories/index.ts";
import { resultRows, type SqlExecutor } from "../db/sql-executor.ts";
import { sendInvoice } from "./sendInvoice.ts";

/** A database with the mock tenants, parties, and drafts written, and the executor the operation runs on. */
interface Fixture {
    db: SqlExecutor;
    close: () => Promise<void>;
}

/** The mock invoices with the parties each names, which is the draft a caller supplies. */
const drafts: Invoice[] = invoices.map((invoice) => {
    const customer = customers.find((row) => row.id === invoice.customerId)!;
    const seller = sellers.find((row) => row.id === invoice.sellerId)!;
    // Mock drafts without rows carry no amounts yet, and a draft with none is still sendable at zero.
    const netAmount = invoice.netAmount ?? ("0.00" as Money);
    const taxAmount = invoice.taxAmount ?? ("0.00" as Money);
    const total = (Number(netAmount) + Number(taxAmount)).toFixed(2) as Money;
    return { ...invoice, customer, seller, netAmount, taxAmount, totalAmount: total };
});

/** The invoice every write assertion starts from. */
const first = drafts[0]!;

/** Open a fresh schema and write the mock tenants, customers, sellers, and invoices. */
async function fixture(): Promise<Fixture> {
    const app = await createAppContext();
    await createTenant(app.database, tenants);
    await createCustomer(app.database, customers);
    await createSeller(app.database, sellers);
    await createInvoice(app.database, invoices);
    return { db: app.database, close: () => app.database.close() };
}

/** The value without one property, so a test can drop the detail a send requires. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
    const { [key]: _dropped, ...rest } = value;
    return rest;
}

/** Wrap the executor so the first statement matching `refuse` throws, leaving every other statement alone. */
function refusing(db: SqlExecutor, refuse: RegExp): SqlExecutor {
    const wrap = (inner: SqlExecutor): SqlExecutor => ({
        query: async (sql, parameters) => {
            if (refuse.test(sql)) {
                throw new Error("the write was refused");
            }
            return await inner.query(sql, parameters);
        },
        transaction: (run) => inner.transaction((tx) => run(wrap(tx))),
        transactionWith: (options, run) => inner.transactionWith(options, (tx) => run(wrap(tx))),
    });
    return wrap(db);
}

/** The rows one table holds. */
async function rows(db: SqlExecutor, sql: string): Promise<Array<Record<string, unknown>>> {
    return resultRows(await db.query(sql));
}

const SENT_ROWS = 'select "id", "invoiceId", "number", "language", "notes", "customerEmail" from "invoice_sent"';
const EMAIL_ROWS = 'select "id", "to", "subject", "status" from "email"';

let open: Fixture | undefined;

afterEach(async () => {
    await open?.close();
    open = undefined;
});

describe("sendInvoice", () => {
    it("writes the sent invoice and the queued email, and answers both keys", async () => {
        open = await fixture();

        const answer = await sendInvoice({ db: open.db }, { invoice: first });

        expect(await rows(open.db, SENT_ROWS)).toEqual([
            {
                id: answer.invoiceSentId,
                invoiceId: first.id,
                number: first.number,
                language: first.language,
                notes: first.notes,
                customerEmail: first.customer!.email,
            },
        ]);
        expect(await rows(open.db, EMAIL_ROWS)).toEqual([
            {
                id: answer.emailId,
                to: first.customer!.email,
                subject: `Invoice ${first.number}`,
                status: "pending",
            },
        ]);
    });

    it("freezes the customer and the seller onto the sent invoice", async () => {
        open = await fixture();

        await sendInvoice({ db: open.db }, { invoice: first });

        expect(
            await rows(
                open.db,
                'select "customerName", "customerBusinessId", "sellerName", "sellerBusinessId" from "invoice_sent"',
            ),
        ).toEqual([
            {
                customerName: first.customer!.name,
                customerBusinessId: first.customer!.businessId,
                sellerName: first.seller!.name,
                sellerBusinessId: first.seller!.businessId,
            },
        ]);
    });

    it("resolves the language from the draft, else the customer, else the seller", async () => {
        open = await fixture();

        const fromDraft = first;
        const fromCustomer = without(drafts[1]!, "language");
        const fromSeller = { ...without(drafts[2]!, "language"), customer: without(drafts[2]!.customer!, "language") };

        for (const invoice of [fromDraft, fromCustomer, fromSeller]) {
            await sendInvoice({ db: open.db }, { invoice });
        }

        const languages = (await rows(open.db, 'select "language" from "invoice_sent" order by "number"')).map(
            (row) => row.language,
        );
        expect(languages).toEqual([first.language, drafts[1]!.customer!.language, drafts[2]!.seller!.language]);
    });

    it("refuses a draft that lacks a detail, and writes nothing", async () => {
        open = await fixture();
        const draft = without(first, "number") as Invoice;

        await expect(sendInvoice({ db: open.db }, { invoice: draft })).rejects.toThrow(InvoiceDetailsError);
        expect(await rows(open.db, SENT_ROWS)).toEqual([]);
        expect(await rows(open.db, EMAIL_ROWS)).toEqual([]);
    });

    it("writes nothing when the email cannot be queued, so the send is one transaction", async () => {
        open = await fixture();

        await expect(
            sendInvoice({ db: refusing(open.db, /insert into "email"/i) }, { invoice: first }),
        ).rejects.toThrow("the write was refused");
        expect(await rows(open.db, SENT_ROWS)).toEqual([]);
        expect(await rows(open.db, EMAIL_ROWS)).toEqual([]);
    });
});
