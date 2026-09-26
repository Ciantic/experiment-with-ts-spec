/** Postgres fragments for `@computed` columns. See docs/spec-annotations.md. */

/** Same-row expressions for `invoice_row`. */
export const rowFormulas = {
    rowNetAmount: `round("quantity" * "unitPrice")::bigint`,
    rowTaxAmount: `round("netAmount" * "taxRate" / 100)::bigint`,
    rowTotalAmount: `"netAmount" + "taxAmount"`,
} as const;

/** Invoice-level amounts, aggregated from `invoice_row`. See docs/spec-annotations.md. */
export const invoiceFormulas = {
    invoiceNetAmount: {
        select: `(select coalesce(sum("netAmount"), 0)::bigint from "invoice_row" where "invoiceId" = "invoice"."id")`,
        trigger: `NEW."netAmount" := (select coalesce(sum("netAmount"), 0)::bigint from "invoice_row" where "invoiceId" = NEW."id");`,
    },
    invoiceTaxAmount: {
        select: `(select coalesce(sum("taxAmount"), 0)::bigint from "invoice_row" where "invoiceId" = "invoice"."id")`,
        trigger: `NEW."taxAmount" := (select coalesce(sum("taxAmount"), 0)::bigint from "invoice_row" where "invoiceId" = NEW."id");`,
    },
    invoiceTotalAmount: {
        select: `"netAmount" + "taxAmount"`,
        trigger: `NEW."totalAmount" := NEW."netAmount" + NEW."taxAmount";`,
    },
} as const;

/** Trigger order: netAmount, then taxAmount, then totalAmount. See docs/spec-annotations.md. */
export type RowFormula = keyof typeof rowFormulas;
export type InvoiceFormula = keyof typeof invoiceFormulas;
