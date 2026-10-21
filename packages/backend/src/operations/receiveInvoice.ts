import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";

/**
 * Receive an invoice from the system.
 */
export const receiveInvoice: InvoiceOperations<unknown>["receiveInvoice"] = async (ctx) => {
    return null as unknown as Promise<void>;
};
