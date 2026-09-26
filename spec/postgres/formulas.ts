/** Postgres fragments for `@computed` columns. See docs/spec-annotations.md. */

/** Same-row expressions for `invoice_row`, assigned in this order. See docs/schema-generation.md. */
export const rowFormulas = {
    rowNetAmount: `round(NEW."quantity" * NEW."unitPrice", 2)`,
    rowTaxAmount: `round(NEW."netAmount" * NEW."taxRate", 2)`,
    rowTotalAmount: `NEW."netAmount" + NEW."taxAmount"`,
} as const;

/** Invoice amounts: a same-row total, plus the child-change statements for the aggregates. */
export const invoiceFormulas = {
    invoiceNetAmount: {
        childNew: `update "invoice" set "netAmount" = (select coalesce(sum("netAmount"), 0) from "invoice_row" where "invoiceId" = NEW."invoiceId") where "id" = NEW."invoiceId";`,
        childOld: `update "invoice" set "netAmount" = (select coalesce(sum("netAmount"), 0) from "invoice_row" where "invoiceId" = OLD."invoiceId") where "id" = OLD."invoiceId";`,
    },
    invoiceTaxAmount: {
        childNew: `update "invoice" set "taxAmount" = (select coalesce(sum("taxAmount"), 0) from "invoice_row" where "invoiceId" = NEW."invoiceId") where "id" = NEW."invoiceId";`,
        childOld: `update "invoice" set "taxAmount" = (select coalesce(sum("taxAmount"), 0) from "invoice_row" where "invoiceId" = OLD."invoiceId") where "id" = OLD."invoiceId";`,
    },
    invoiceTotalAmount: {
        sameRow: `NEW."totalAmount" := NEW."netAmount" + NEW."taxAmount";`,
    },
} as const;

export type RowFormula = keyof typeof rowFormulas;
export type InvoiceFormula = keyof typeof invoiceFormulas;
