/** Unit tests for the query generator, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import {
    buildQueryModel,
    generateQueries,
    renderQueryModule,
} from "./generate-queries.ts";

function column(name: string, extras: Partial<Column> = {}): Column {
    // A defaulted column is neither insertable nor patchable, except the version; a fixture that says
    // otherwise passes the flag itself.
    const insertable = extras.insertable ?? extras.default === undefined;
    return { name, sqlType: "text", notNull: true, primaryKey: false, unique: false, insertable, updatable: extras.version === true || insertable, ...extras };
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
        importSpecifier: `spec/domain/${interfaceName}.ts`,
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

/** An entity whose `createdAt` is the default ordering and `updatedAt` is merely orderable. */
const stamped = table("stamped", "Stamped", [
    column("id", { primaryKey: true, queryFilter: true }),
    column("createdAt", { queryOrder: { default: "asc" } }),
    column("updatedAt", { queryOrder: {} }),
]);

/** An entity whose `amount` may be compared with a whitelist of operators. */
const sized = table("sized", "Sized", [
    column("id", { primaryKey: true, queryFilter: true }),
    column("amount", { where: ["gte", "lte"] }),
]);

const tables = new Map([
    ["Invoice", invoice],
    ["Seller", seller],
]);

describe("buildQueryModel", () => {
    it("keeps scalar fields and drops inlined columns", () => {
        const model = buildQueryModel(tables);
        const fields = model.tables.invoice?.fields ?? {};

        expect(Object.keys(fields)).toEqual(["id", "number", "customerId", "totalAmount"]);
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

    it("records the orderable fields and the entity default ordering", () => {
        const model = buildQueryModel(new Map([["Stamped", stamped]]));
        const meta = model.tables.stamped;

        expect(meta?.order).toEqual(["createdAt", "updatedAt"]);
        expect(meta?.defaultOrder).toEqual({ field: "createdAt", direction: "asc" });
    });

    it("omits order metadata when the entity marks nothing orderable", () => {
        const model = buildQueryModel(tables).tables.invoice;

        expect(model?.order).toBeUndefined();
        expect(model?.defaultOrder).toBeUndefined();
    });

    it("records the comparable fields and their operators", () => {
        const model = buildQueryModel(new Map([["Sized", sized]]));

        expect(model.tables.sized?.where).toEqual({ amount: ["gte", "lte"] });
    });

    it("omits where metadata when the entity marks nothing comparable", () => {
        const model = buildQueryModel(tables).tables.invoice;

        expect(model?.where).toBeUndefined();
    });
});

describe("renderQueryModule", () => {
    it("emits one exported query function, with no interface", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("export function queryInvoice<");
        expect(code).not.toContain("export interface");
        expect(code).toContain('resolver.resolveMany<Invoice, S>(db, "invoice"');
    });

    it("takes db first and the filter object plus the selection second", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain(
            'queryInvoice<S extends Selection<Invoice>>(db: SqlExecutor, opts: { filter?: Filters<Invoice, "id">; limit?: number; offset?: number; select: S })',
        );
    });

    it("passes the filter object and the selection through to the resolver", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).not.toContain("const { select, ...args } = opts;");
        expect(code).toContain(
            'resolver.resolveMany<Invoice, S>(db, "invoice", opts.filter ?? {}, { select: opts.select, limit: opts.limit, offset: opts.offset })',
        );
    });

    it("passes the ordering through to the resolver when the entity is orderable", () => {
        const code = renderQueryModule("Stamped", stamped);

        expect(code).toContain(
            'resolver.resolveMany<Stamped, S>(db, "stamped", opts.filter ?? {}, { select: opts.select, order: opts.order, limit: opts.limit, offset: opts.offset })',
        );
    });

    it("returns a list", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain("Promise<Selected<Invoice, S>[]>");
    });

    it("leaves the filters out when the entity marks none", () => {
        const code = renderQueryModule("Seller", seller);

        expect(code).toContain(
            "querySeller<S extends Selection<Seller>>(db: SqlExecutor, opts: { limit?: number; offset?: number; select: S })",
        );
        expect(code).not.toContain("Filters<");
    });

    it("emits no getter", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).not.toContain("getInvoice");
        expect(code).not.toContain("AtLeastOne");
        expect(code).not.toContain("resolveOne");
    });

    it("takes order clauses for the whitelisted fields", () => {
        const code = renderQueryModule("Stamped", stamped);

        expect(code).toContain("import type { Filters, Order, Selected, Selection } from");
        expect(code).toContain('order?: Order<"createdAt" | "updatedAt">[]');
    });

    it("omits the order key from the opts type when the entity marks nothing orderable", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).not.toContain("Order<");
        expect(code).toContain('opts: { filter?: Filters<Invoice, "id">; limit?: number; offset?: number; select: S }');
    });

    it("gives every read a limit and an offset", () => {
        const code = renderQueryModule("Seller", seller);

        expect(code).toContain("limit?: number; offset?: number; select: S");
    });

    it("takes comparisons for the whitelisted operators", () => {
        const code = renderQueryModule("Sized", sized);

        expect(code).toContain("import type { Filters, Selected, Selection, Where } from");
        expect(code).toContain('where?: Where<Sized, { amount: "gte" | "lte" }>');
        expect(code).toContain("where: opts.where");
    });

    it("omits the where key from the opts type when the entity marks nothing comparable", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).not.toContain("Where<");
        expect(code).not.toContain("where: opts.where");
    });
});

describe("generateQueries", () => {
    it("emits the model, one module per entity, and a barrel", () => {
        const files = generateQueries(tables);

        expect([...files.keys()].sort()).toEqual([
            "index.ts",
            "model.ts",
            "queryInvoice.ts",
            "querySeller.ts",
        ]);
    });

    it("re-exports every module from the barrel", () => {
        const code = generateQueries(tables).get("index.ts") ?? "";

        expect(code).toContain('export * from "./model.ts";');
        expect(code).toContain('export * from "./queryInvoice.ts";');
        expect(code).toContain('export * from "./querySeller.ts";');
    });
});
