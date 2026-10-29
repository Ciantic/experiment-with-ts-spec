/** The `sendInvoice` behaviour the spec does not declare, over the seeded mock data. See docs/testing.md and docs/operations.md. */
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Invoice } from "spec/invoicing-service/Invoice.ts";
import type { Money } from "spec/invoicing-service/primitives/Money.ts";
import { customers, invoices, sellers, tenants } from "spec/mockdata/index.ts";
import { createAppContext, createCustomer, createInvoice, createPgliteDriver, createSeller, createTenant, createTransactionalDb, resultRows, type SqlExecutor } from "infra";
import { sendInvoice } from "./sendInvoice.ts";

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
interface Fixture {
    db: SqlExecutor;
    close: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
    const { driver } = await createAppContext({ driver: createPgliteDriver(PGlite) });
    const db = createTransactionalDb(driver);
    await createTenant(db, tenants);
    await createCustomer(db, customers);
    await createSeller(db, sellers);
    await createInvoice(db, invoices);
    return { db, close: () => driver.close() };
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

    it("writes nothing when the email cannot be queued, so the send is one transaction", async () => {
        open = await fixture();

        await expect(
            sendInvoice({ db: refusing(open.db, /insert into "email"/i) }, { invoice: first }),
        ).rejects.toThrow("the write was refused");
        expect(await rows(open.db, SENT_ROWS)).toEqual([]);
        expect(await rows(open.db, EMAIL_ROWS)).toEqual([]);
    });
});
