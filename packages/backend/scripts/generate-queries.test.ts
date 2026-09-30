/** Unit tests for the query generator, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.js";
import {
    buildQueryModel,
    generateQueries,
    renderQueryModule,
} from "./generate-queries.js";

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
        column("id", { primaryKey: true, queryFilter: true }),
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

const seller = table("seller", "Seller", [column("id", { primaryKey: true })]);

const tables = new Map([
    ["Invoice", invoice],
    ["Seller", seller],
]);

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
    it("emits one exported list function, with no interface", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("export function listInvoice<");
        expect(code).not.toContain("export interface");
        expect(code).toContain('resolver.resolveMany<Invoice, S>(db, "invoice"');
    });

    it("takes db first and the filter sets plus the selection second", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain(
            'listInvoice<S extends Selection<Invoice>>(db: SqlExecutor, opts: Filters<Invoice, "id"> & { select: S })',
        );
    });

    it("splits the filters back apart for the resolver", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("const { select, ...args } = opts;");
        expect(code).toContain('resolver.resolveMany<Invoice, S>(db, "invoice", args, { select })');
    });

    it("returns a list", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("Promise<Selected<Invoice, S>[]>");
    });

    it("emits a getter that requires at least one filter", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("export function getInvoice<");
        expect(code).toContain(
            'getInvoice<S extends Selection<Invoice>>(db: SqlExecutor, opts: AtLeastOne<Filters<Invoice, "id">> & { select: S })',
        );
        expect(code).toContain("Promise<Selected<Invoice, S> | undefined>");
        expect(code).toContain('resolver.resolveOne<Invoice, S>(db, "invoice", args, { select })');
    });

    it("leaves the filters out when the entity marks none", () => {
        const code = renderQueryModule("Seller", seller);

        expect(code).toContain("listSeller<S extends Selection<Seller>>(db: SqlExecutor, opts: { select: S })");
        expect(code).not.toContain("Filters<");
    });

    it("emits no getter when the entity marks no filter", () => {
        const code = renderQueryModule("Seller", seller);

        expect(code).not.toContain("getSeller");
        expect(code).not.toContain("AtLeastOne");
    });
});

describe("generateQueries", () => {
    it("emits the model, one module per entity, and a barrel", () => {
        const files = generateQueries(tables);

        expect([...files.keys()].sort()).toEqual([
            "index.ts",
            "invoiceQueries.ts",
            "model.ts",
            "sellerQueries.ts",
        ]);
    });

    it("re-exports every module from the barrel", () => {
        const code = generateQueries(tables).get("index.ts") ?? "";

        expect(code).toContain('export * from "./model.js";');
        expect(code).toContain('export * from "./invoiceQueries.js";');
        expect(code).toContain('export * from "./sellerQueries.js";');
    });
});
