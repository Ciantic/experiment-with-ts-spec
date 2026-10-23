// Generated for implementation by: scripts/backend/generate-operations.ts
import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";
import type { EmailAddress } from "spec/primitives/EmailAddress.ts";
import { createEmail, createInvoiceSent } from "../db/repositories/index.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { InvoiceDetailsError, ShortWriteError } from "sdk/errors.ts";

// The seller has no email field, so the demonstration uses one fixed sender.
const DEMO_SENDER = "billing@example.com" as EmailAddress;

/**
 * The value, or a refusal naming the detail the invoice lacks.
 * @throws {InvoiceDetailsError} when the invoice does not carry the detail
 */
function required<T>(value: T | undefined, detail: string): T {
    if (value === undefined) {
        throw new InvoiceDetailsError(`the invoice cannot be sent without ${detail}`);
    }
    return value;
}

/**
 * Send the invoice to the recipient: snapshot it and queue the email in one transaction.
 *
 * @throws {InvoiceDetailsError} when the invoice doesn't have enough details to be sent
 * @throws {ShortWriteError} when either insert returns no key
 */
export const sendInvoice: InvoiceOperations<{ db: SqlExecutor }>["sendInvoice"] = async (ctx, { invoice }) => {
    const customer = required(invoice.customer, "a customer");
    const number = required(invoice.number, "an invoice number");
    const issueDate = required(invoice.issueDate, "an issue date");
    const dueDate = required(invoice.dueDate, "a due date");
    const netAmount = required(invoice.netAmount, "a net amount");
    const taxAmount = required(invoice.taxAmount, "a tax amount");
    const totalAmount = required(invoice.totalAmount, "a total amount");
    const language = required(
        invoice.language ?? customer.language ?? invoice.seller?.language,
        "a language",
    );
    return await ctx.db.transaction(async (tx) => {
        const [sent] = await createInvoiceSent(tx, [
            {
                tenantId: invoice.tenantId,
                invoiceId: invoice.id,
                sentAt: new Date(),
                number,
                customer,
                seller: invoice.seller ?? null,
                language,
                issueDate,
                dueDate,
                notes: invoice.notes ?? "",
                netAmount,
                taxAmount,
                totalAmount,
            },
        ]);
        const [email] = await createEmail(tx, [
            {
                tenantId: invoice.tenantId,
                from: DEMO_SENDER,
                to: customer.email as EmailAddress,
                subject: `Invoice ${number}`,
                body: `Invoice ${number} was issued by ${invoice.seller?.name ?? "the seller"}.`,
            },
        ]);
        if (sent === undefined || email === undefined) {
            throw new ShortWriteError("the send did not write both the sent invoice and the email");
        }
        return { invoiceSentId: sent.id, emailId: email.id };
    });
};
