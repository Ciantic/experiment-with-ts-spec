/** Unit tests for the query generator, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import { WRITE_OPERATIONS, type DeclaredType } from "../spec/spec-model.ts";
import type { Column, Table } from "./postgres-model.ts";
import {
    buildQueryModel,
    generateQueries,
    renderQueryModule,
    renderTenantsModule,
    renderWatchModule,
} from "./generate-queries.ts";

function column(name: string, extras: Partial<Column> = {}): Column {
    // A defaulted column is neither insertable nor patchable, except the version; a fixture that says otherwise passes the flag itself.
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
        importSpecifier: `spec/fixtures/${interfaceName}.ts`,
        columns,
        relations,
        triggers: [],
        repositoryOperations: [...WRITE_OPERATIONS],
        queries: ["query"],
        watch: [],
        watchFilters: [],
    };
}

const invoice = table(
    "invoice",
    "Invoice",
    [
        column("id", { primaryKey: true, queryFilter: { required: false } }),
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
    column("id", { primaryKey: true, queryFilter: { required: false } }),
    column("createdAt", { queryOrder: { default: "asc" } }),
    column("updatedAt", { queryOrder: {} }),
]);

/** An entity whose `amount` may be compared with a whitelist of operators. */
const sized = table("sized", "Sized", [
    column("id", { primaryKey: true, queryFilter: { required: false } }),
    column("amount", { where: ["gte", "lte"] }),
]);

/** An entity whose `tenantId` every read must name. */
const scoped = table("scoped", "Scoped", [
    column("id", { primaryKey: true, queryFilter: { required: false } }),
    column("tenantId", { queryFilter: { required: true } }),
]);

/** An entity whose filters fall back to a value when a read omits them. */
const defaulted = table("defaulted", "Defaulted", [
    column("id", { primaryKey: true, queryFilter: { required: false } }),
    column("state", { queryFilter: { required: false, default: { kind: "literal", value: "open" } } }),
    column("priority", { queryFilter: { required: false, default: { kind: "literal", value: 0 } } }),
    column("deletedAt", { notNull: false, queryFilter: { required: false, default: { kind: "isNull" } } }),
    column("approvedAt", { notNull: false, queryFilter: { required: false, default: { kind: "isNotNull" } } }),
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
        expect(relations.snapshot).toEqual({ kind: "inlined", columns: { name: "customerName" } });
    });

    it("records the required filters", () => {
        const model = buildQueryModel(new Map([["Scoped", scoped]]));

        expect(model.tables.scoped?.requiredFilters).toEqual(["tenantId"]);
    });

    it("omits the required metadata when every filter is optional", () => {
        const model = buildQueryModel(tables).tables.invoice;

        expect(model?.requiredFilters).toBeUndefined();
    });

    it("records the filters' literal defaults", () => {
        const model = buildQueryModel(new Map([["Defaulted", defaulted]]));

        expect(model.tables.defaulted?.filterDefaults).toEqual({
            state: { kind: "literal", value: "open" },
            priority: { kind: "literal", value: 0 },
            deletedAt: { kind: "isNull" },
            approvedAt: { kind: "isNotNull" },
        });
    });

    it("omits default metadata when no filter declares one", () => {
        const model = buildQueryModel(tables).tables.invoice;

        expect(model?.filterDefaults).toBeUndefined();
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

    it("requires the filter object when a field is a required filter", () => {
        const code = renderQueryModule("Scoped", scoped);

        expect(code).toContain('filter: Filters<Scoped, "id" | "tenantId", "tenantId">');
        expect(code).not.toContain("filter?");
    });

    it("names no required key when every filter is optional", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).toContain('filter?: Filters<Invoice, "id">');
    });

    it("takes comparisons for the whitelisted operators", () => {
        const code = renderQueryModule("Sized", sized);

        expect(code).toContain("import type { Filters, Selected, Selection, Where } from");
        expect(code).toContain('where?: Where<Sized, { amount: "gte" | "lte" }>');
        expect(code).toContain("where: opts.where");
    });

    it("names a null test among the whitelisted operators", () => {
        const nullable = table("nullable", "Nullable", [
            column("id", { primaryKey: true, queryFilter: { required: false } }),
            column("deletedAt", { notNull: false, where: ["isNull", "isNotNull"] }),
        ]);
        const code = renderQueryModule("Nullable", nullable);

        expect(code).toContain('where?: Where<Nullable, { deletedAt: "isNull" | "isNotNull" }>');
    });

    it("omits the where key from the opts type when the entity marks nothing comparable", () => {
        const code = renderQueryModule("Invoice", invoice);

        expect(code).not.toContain("Where<");
        expect(code).not.toContain("where: opts.where");
    });
});

describe("renderWatchModule", () => {
    it("renders an all-only watch with no key filter", () => {
        const code = renderWatchModule("Invoice", { ...invoice, watch: ["all"] });

        expect(code).toContain('import type { AllWatchEvent, WatchOperation } from "sdk/watch.ts";');
        expect(code).toContain(
            "export function watchInvoice(\n    db: SqlExecutor,\n    opts?: { ops?: readonly WatchOperation[] | undefined; signal?: AbortSignal },\n): AsyncIterable<AllWatchEvent> {",
        );
        expect(code).toContain('return watchAll(db, "invoice", opts?.ops, opts?.signal);');
        expect(code).not.toContain("watchInvoiceRows");
    });

    it("renders a rows-only watch with a required key filter", () => {
        const code = renderWatchModule("Invoice", { ...invoice, watch: ["rows"] });

        expect(code).toContain('import type { InvoicePrimaryKey } from "sdk/schemas.ts";');
        expect(code).toContain('import type { WatchEvent, WatchOperation } from "sdk/watch.ts";');
        expect(code).toContain(
            "export function watchInvoiceRows(\n    db: SqlExecutor,\n    opts: { pks: InvoicePrimaryKey[]; ops?: readonly WatchOperation[] | undefined; signal?: AbortSignal },\n): AsyncIterable<WatchEvent<InvoicePrimaryKey>> {",
        );
        expect(code).toContain('return watchRows(db, "invoice", opts.pks, ["id"], opts.ops, opts.signal);');
        expect(code).not.toContain("export function watchInvoice(");
    });

    it("renders one function per scope when all and rows are both declared", () => {
        const code = renderWatchModule("Invoice", { ...invoice, watch: ["all", "rows"] });

        expect(code).toContain("export function watchInvoice(");
        expect(code).toContain("export function watchInvoiceRows(");
        expect(code).not.toContain("): AsyncIterable<WatchEvent<InvoicePrimaryKey>>;");
    });

    it("accepts a typed filter when @watchFilter names a field", () => {
        const code = renderWatchModule("Invoice", {
            ...invoice,
            watch: ["all", "rows"],
            watchFilters: ["customerId"],
        });

        expect(code).toContain('import type { Invoice } from "spec/fixtures/Invoice.ts";');
        expect(code).toContain(
            'import type { AllWatchEvent, WatchEvent, WatchFilter, WatchOperation } from "sdk/watch.ts";',
        );
        expect(code).toContain('filter?: WatchFilter<Invoice, "customerId"> | undefined;');
        expect(code).toContain('return watchAll(db, "invoice", opts?.ops, opts?.signal, opts?.filter);');
        expect(code).toContain(
            'return watchRows(db, "invoice", opts.pks, ["id"], opts.ops, opts.signal, opts.filter);',
        );
    });
});

/** The spec's tenancy key type, which every lookup returns. */
const TENANT_ID: DeclaredType = { name: "TenantId", importSpecifier: "spec/fixtures/Tenant.ts" };

describe("renderTenantsModule", () => {
    const widget = {
        ...table("widget", "Widget", [
            column("id", { primaryKey: true, sqlType: "uuid" }),
            column("tenantId", { sqlType: "uuid" }),
        ]),
        tenantOwned: { field: "tenantId", optional: false },
    };

    it("selects the distinct tenants of the named keys with one array parameter", () => {
        const code = renderTenantsModule(widget, TENANT_ID);

        expect(code).toContain('import type { TenantId } from "spec/fixtures/Tenant.ts";');
        expect(code).toContain('import type { WidgetPrimaryKey } from "sdk/repositories/widgetPrimaryKeySchema.ts";');
        expect(code).toContain(
            "export async function getWidgetTenants(db: SqlExecutor, pks: readonly WidgetPrimaryKey[]): Promise<TenantId[]> {",
        );
        expect(code).toContain("const result = await db.query<{ tenant: TenantId }>(");
        expect(code).not.toContain("as readonly WidgetPrimaryKey[]");
        expect(code).toContain('select distinct "tenantId" as "tenant" from "widget" where "id" = any($1)');
        expect(code).toContain("[pks.map((key) => key.id)]");
        expect(code).toContain("return result.rows.map((row) => row.tenant);");
    });

    it("matches a composite key with one unnest per key column", () => {
        const part = {
            ...table("widget_part", "WidgetPart", [
                column("widgetId", { primaryKey: true, sqlType: "uuid" }),
                column("partKey", { primaryKey: true }),
                column("tenantId", { sqlType: "uuid" }),
            ]),
            tenantOwned: { field: "tenantId", optional: false },
        };
        const code = renderTenantsModule(part, TENANT_ID);

        expect(code).toContain(
            "export async function getWidgetPartTenants(db: SqlExecutor, pks: readonly WidgetPartPrimaryKey[]): Promise<TenantId[]> {",
        );
        expect(code).toContain(
            'where ("widgetId", "partKey") in (select * from unnest($1::uuid[], $2::text[]))',
        );
        expect(code).toContain("[pks.map((row) => row.widgetId), pks.map((row) => row.partKey)]");
    });

    it("answers no keys without a statement", () => {
        const code = renderTenantsModule(widget, TENANT_ID);

        expect(code).toContain("if (pks.length === 0) {");
    });

    it("returns null for an optional owner, so a stored row with no tenant is visible", () => {
        const optional = { ...widget, tenantOwned: { field: "tenantId", optional: true } };
        const code = renderTenantsModule(optional, TENANT_ID);

        expect(code).toContain(
            "export async function getWidgetTenants(db: SqlExecutor, pks: readonly WidgetPrimaryKey[]): Promise<(TenantId | null)[]> {",
        );
        expect(code).toContain("const result = await db.query<{ tenant: TenantId | null }>(");
        expect(code).toContain("with `null` for a row that has none");
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

    it("writes one watch module for an entity that declares a notification scope", () => {
        const notified = { ...invoice, watch: ["all"] as Table["watch"] };
        const files = generateQueries(new Map([["Invoice", notified]]));

        expect([...files.keys()].sort()).toEqual([
            "index.ts",
            "model.ts",
            "queryInvoice.ts",
            "watchInvoice.ts",
        ]);
        expect(files.get("index.ts")).toContain('export * from "./watchInvoice.ts";');
    });

    it("writes a tenant lookup for a @tenantOwned entity and exports it", () => {
        const owned = { ...invoice, tenantOwned: { field: "tenantId", optional: false } };
        const files = generateQueries(new Map([["Invoice", owned]]), TENANT_ID);

        expect([...files.keys()].sort()).toEqual([
            "getInvoiceTenants.ts",
            "index.ts",
            "model.ts",
            "queryInvoice.ts",
        ]);
        expect(files.get("index.ts")).toContain('export * from "./getInvoiceTenants.ts";');
    });

    it("writes no tenant lookup for a global entity", () => {
        const files = generateQueries(tables);

        expect([...files.keys()]).not.toContain("getInvoiceTenants.ts");
    });

    it("re-exports every module from the barrel", () => {
        const code = generateQueries(tables).get("index.ts") ?? "";

        expect(code).toContain('export * from "./model.ts";');
        expect(code).toContain('export * from "./queryInvoice.ts";');
        expect(code).toContain('export * from "./querySeller.ts";');
    });

    it("emits no module for an entity that carries no @queries, keeping it in the model", () => {
        const tables = new Map<string, Table>([
            ["Invoice", invoice],
            ["Seller", { ...seller, queries: [] }],
        ]);

        const files = generateQueries(tables);

        expect([...files.keys()].sort()).toEqual(["index.ts", "model.ts", "queryInvoice.ts"]);
        expect(files.get("index.ts")).not.toContain("querySeller");
        // A read may still navigate into the table, so the model names it whether or not it reads.
        expect(files.get("model.ts")).toContain('"seller"');
    });
});
