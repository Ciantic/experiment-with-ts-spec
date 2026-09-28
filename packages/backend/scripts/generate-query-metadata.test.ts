/** Unit tests for the query generator, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.js";
import {
    buildQueryModel,
    generateQueries,
    renderQueryModule,
    type QuerySpec,
} from "./generate-query-metadata.js";

function column(name: string, extras: Partial<Column> = {}): Column {
    return { name, sqlType: "text", notNull: true, primaryKey: false, unique: false, ...extras };
}

function table(
    name: string,
    interfaceName: string,
    columns: Column[],
    relations: Table["relations"] = new Map(),
): Table {
    return {
        name,
        interfaceName,
        importSpecifier: `spec/domain/${interfaceName}.js`,
        columns,
        relations,
        sameRowAssignments: [],
        rollups: new Map(),
    };
}

const invoice = table(
    "invoice",
    "Invoice",
    [
        column("id", { primaryKey: true }),
        column("number"),
        column("customerId", { references: { table: "customer", column: "id" } }),
        column("customerName"),
        column("totalAmount"),
    ],
    new Map([
        ["customer", { kind: "relation", table: "customer", column: "customerId" }],
        ["rows", { kind: "children", table: "invoice_row", column: "invoiceId" }],
        ["snapshot", { kind: "inlined", table: "customer", columns: { name: "customerName" } }],
    ]),
);

const tables = new Map([["Invoice", invoice]]);

const listInvoices: QuerySpec = {
    name: "ListInvoices",
    entity: "Invoice",
    cardinality: "many",
    importSpecifier: "spec/queries/InvoiceQueries.js",
};

const getInvoice: QuerySpec = {
    name: "GetInvoice",
    entity: "Invoice",
    cardinality: "one",
    importSpecifier: "spec/queries/InvoiceQueries.js",
};

describe("buildQueryModel", () => {
    it("keeps scalar fields and drops branch columns", () => {
        const model = buildQueryModel(tables);
        const fields = model.tables.invoice?.fields ?? {};

        expect(Object.keys(fields)).toEqual(["id", "number", "totalAmount"]);
    });

    it("records the primary key", () => {
        const model = buildQueryModel(tables);

        expect(model.tables.invoice?.key).toBe("id");
    });

    it("describes each kind of branch", () => {
        const relations = buildQueryModel(tables).tables.invoice?.relations ?? {};

        expect(relations.customer).toEqual({ kind: "relation", table: "customer", column: "customerId" });
        expect(relations.rows).toEqual({ kind: "children", table: "invoice_row", column: "invoiceId" });
        expect(relations.snapshot).toEqual({
            kind: "inlined",
            table: "customer",
            columns: { name: "customerName" },
        });
    });
});

describe("renderQueryModule", () => {
    it("emits the interface and factory for the entity", () => {
        const code = renderQueryModule("Invoice", "invoice", "spec/domain/Invoice.js", [listInvoices, getInvoice]);

        expect(code).toContain("export interface InvoiceQueries {");
        expect(code).toContain("export function invoiceQueries(db: SqlExecutor): InvoiceQueries {");
        expect(code).toContain("resolver.resolveMany<Invoice, S>(db, \"invoice\"");
        expect(code).toContain("resolver.resolveOne<Invoice, S>(db, \"invoice\"");
    });

    it("takes one argument: the args plus the selection", () => {
        const code = renderQueryModule("Invoice", "invoice", "spec/domain/Invoice.js", [listInvoices, getInvoice]);

        expect(code).toContain("getInvoice<S extends Selection<Invoice>>(opts: GetInvoice & { select: S })");
        expect(code).toContain("listInvoices<S extends Selection<Invoice>>(opts: ListInvoices & { select: S })");
    });

    it("splits the argument back into filters and a selection for the resolver", () => {
        const code = renderQueryModule("Invoice", "invoice", "spec/domain/Invoice.js", [listInvoices, getInvoice]);

        expect(code).toContain("const { select, ...args } = opts;");
        expect(code).toContain('resolver.resolveOne<Invoice, S>(db, "invoice", args, { select })');
        expect(code).toContain('resolver.resolveMany<Invoice, S>(db, "invoice", args, { select })');
    });

    it("returns a list for `many` and an optional row for `one`", () => {
        const code = renderQueryModule("Invoice", "invoice", "spec/domain/Invoice.js", [listInvoices, getInvoice]);

        expect(code).toContain("Promise<Selected<Invoice, S>[]>");
        expect(code).toContain("Promise<Selected<Invoice, S> | undefined>");
    });

    it("sorts methods by name", () => {
        const code = renderQueryModule("Invoice", "invoice", "spec/domain/Invoice.js", [listInvoices, getInvoice]);
        const getIndex = code.indexOf("getInvoice<S extends");
        const listIndex = code.indexOf("listInvoices<S extends");

        expect(getIndex).toBeGreaterThan(-1);
        expect(getIndex).toBeLessThan(listIndex);
    });
});

describe("generateQueries", () => {
    it("emits the model, one module per entity, and a barrel", () => {
        const files = generateQueries(tables, [listInvoices, getInvoice]);

        expect([...files.keys()].sort()).toEqual(["index.ts", "invoiceQueries.ts", "model.ts"]);
    });

    it("throws when a query names an entity with no table", () => {
        const orphan: QuerySpec = { ...listInvoices, entity: "Nope" };

        expect(() => generateQueries(tables, [orphan])).toThrow("@query Nope has no table");
    });
});
