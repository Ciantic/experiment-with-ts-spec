/** Unit tests for the repository generator, driven by self-contained table fixtures. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ts } from "ts-morph";
import { createPglite, createPglitePool } from "../src/postgres/pglite-setup.ts";
import * as sqlExecutor from "../src/db/sql-executor.ts";
import type { SqlExecutor } from "../src/db/sql-executor.ts";
import { createTransactionalDb } from "../src/db/sql-executor.ts";
import { generateCreate, generateDelete, generateIndex, generateRepositories, generateUpdate } from "./generate-repositories.ts";
import type { Column, Table } from "./postgres-model.ts";

function column(name: string, extras: Partial<Column> = {}): Column {
    // A defaulted column is written when the row supplies it; the version is the database's on create.
    const insertable = extras.insertable ?? extras.version !== true;
    const column: Column = { name, sqlType: "text", notNull: true, primaryKey: false, unique: false, insertable, updatable: extras.version === true || insertable, ...extras };
    // The model records how a patch tells whether a row supplied a column; the fixture does the same.
    if (column.updatable && !column.primaryKey && !column.version && extras.supplied === undefined) {
        column.supplied = `row.${name} !== undefined`;
    }
    return column;
}

/** A table fixture; defaults keep each test focused on the part it exercises. */
function table(name: string, interfaceName: string, columns: Column[]): Table {
    return {
        name,
        interfaceName,
        importSpecifier: `spec/domain/${interfaceName}.ts`,
        columns,
        relations: new Map(),
        triggers: [],
    };
}

const customer = table("customer", "Customer", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("name"),
    column("email"),
]);

const translation = table("translation", "Translation", [
    column("languageCode", { primaryKey: true }),
    column("key", { primaryKey: true }),
    column("value", { notNull: false }),
]);

/** A `create table` for a fixture, derived from its column metadata so this stays domain-free. */
function createTableSql(table: Table): string {
    const definitions = table.columns.map((column) => {
        const parts = [`"${column.name}" ${column.sqlType}`];
        if (column.notNull) {
            parts.push("not null");
        }
        if (column.default !== undefined) {
            parts.push(`default ${column.default}`);
        }
        return `    ${parts.join(" ")}`;
    });
    const keys = table.columns.filter((column) => column.primaryKey).map((column) => `"${column.name}"`);
    if (keys.length > 0) {
        definitions.push(`    primary key (${keys.join(", ")})`);
    }
    return `create table "${table.name}" (\n${definitions.join(",\n")}\n);`;
}

/**
 * A `before update` trigger that owns the version counter, for a fixture with a version column: a
 * statement that sets the version itself is rejected, and every other update bumps it once.
 */
function versionTriggerSql(table: Table): string {
    const version = table.columns.find((column) => column.version);
    if (version === undefined) {
        return "";
    }
    const name = `${table.name}_version`;
    return [
        `create function "${name}"() returns trigger as $$ begin`,
        `    if new."${version.name}" is distinct from old."${version.name}" then`,
        "        raise exception 'the version column is not assignable' using errcode = '40001';",
        "    end if;",
        `    new."${version.name}" := old."${version.name}" + 1;`,
        "    return new;",
        "end; $$ language plpgsql;",
        `create trigger "${name}" before update on "${table.name}" for each row execute function "${name}"();`,
    ].join("\n");
}

/** The three generated CRUD functions, resolved from the three operation modules. */
interface GeneratedRepository {
    create: (db: SqlExecutor, rows: unknown[]) => Promise<void>;
    update: (db: SqlExecutor, rows: unknown[]) => Promise<void>;
    delete: (db: SqlExecutor, rows: unknown[]) => Promise<void>;
}

/** Strips a generated module's type-only imports and evaluates the rest in memory. */
function loadModule(code: string): Record<string, unknown> {
    const transpiled = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    // A generated module imports the port's runtime helpers from here and nothing else at runtime.
    new Function("exports", "require", transpiled)(exports, (specifier: string) => {
        if (specifier === "../sql-executor.ts") {
            return sqlExecutor;
        }
        throw new Error(`the generated repository imported \`${specifier}\` at runtime`);
    });
    return exports;
}

/** The create, update, and delete functions, each resolved from its own generated module. */
function loadRepository(table: Table): GeneratedRepository {
    const pick = (prefix: string, code: string) => {
        const fn = loadModule(code)[`${prefix}${table.interfaceName}`];
        if (typeof fn !== "function") {
            throw new Error(`the generated module does not export ${prefix}${table.interfaceName}`);
        }
        return fn as (db: SqlExecutor, rows: unknown[]) => Promise<void>;
    };
    return {
        create: pick("create", generateCreate(table)),
        update: pick("update", generateUpdate(table)),
        delete: pick("delete", generateDelete(table)),
    };
}

/** The three operation modules for a table, so a test can assert across all of them. */
function moduleCodes(table: Table): string[] {
    return [generateCreate(table), generateUpdate(table), generateDelete(table)];
}

describe("generateCreate", () => {
    it("starts each operation module with the do-not-edit header", () => {
        for (const code of moduleCodes(customer)) {
            expect(code.startsWith("// Generated by scripts/generate-repositories.ts. Do not edit.\n")).toBe(true);
        }
    });

    it("imports the write type for its operation and the executor interface", () => {
        expect(generateCreate(customer)).toContain(
            'import type { CustomerInsert } from "validation/repositories/customerInsertSchema.ts";',
        );
        expect(generateUpdate(customer)).toContain(
            'import type { CustomerPatch } from "validation/repositories/customerPatchSchema.ts";',
        );
        expect(generateDelete(customer)).toContain(
            'import type { CustomerPrimaryKey } from "validation/repositories/customerPrimaryKeySchema.ts";',
        );
        for (const code of [generateCreate(customer), generateDelete(customer)]) {
            expect(code).toContain('import type { SqlExecutor } from "../sql-executor.ts";');
            expect(code).not.toContain("spec/domain");
        }
        // An update reads the affected-row count, so it takes the port's runtime helper with it.
        expect(generateUpdate(customer)).toContain(
            'import { affectedRows, type SqlExecutor } from "../sql-executor.ts";',
        );
        expect(generateUpdate(customer)).not.toContain('import type { SqlExecutor } from "../sql-executor.ts";');
    });

    it("exports the operation taking rows and returning nothing", () => {
        expect(generateCreate(customer)).toContain(
            "export async function createCustomer(db: SqlExecutor, rows: CustomerInsert[]): Promise<void> {",
        );
        expect(generateUpdate(customer)).toContain(
            "export async function updateCustomer(db: SqlExecutor, rows: CustomerPatch[]): Promise<void> {",
        );
        expect(generateDelete(customer)).toContain(
            "export async function deleteCustomer(db: SqlExecutor, rows: CustomerPrimaryKey[]): Promise<void> {",
        );
    });

    it("imports the write type from the validation package rather than declaring it", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
        ]);
        const code = generateCreate(limited);

        expect(code).toContain(
            'import type { LimitedInsert } from "validation/repositories/limitedInsertSchema.ts";',
        );
        expect(code).toContain("export async function createLimited(db: SqlExecutor, rows: LimitedInsert[])");
        expect(code).not.toContain("export type LimitedInsert");
    });

    it("declares no write type locally, so the schema and the type cannot drift", () => {
        expect(moduleCodes(customer).join("\n")).not.toContain("export type Customer");
    });

    it("returns early for an empty array", () => {
        for (const code of moduleCodes(customer)) {
            expect(code.match(/if \(rows\.length === 0\) \{/g)).toHaveLength(1);
        }
    });

    it("inserts every column with one placeholder per value", () => {
        const code = generateCreate(customer);

        expect(code).toContain('insert into "customer" ("id", "name", "email") values ');
        expect(code).toContain("const values = [row.id, row.name, row.email];");
    });

    it("casts each placeholder to its column type, so keys compare against the right type", () => {
        const code = generateCreate(customer);

        expect(code).toContain(
            '        tuples.push("(" + "$" + (offset + 1) + "::uuid" + ", " + "$" + (offset + 2) + "::text" + ", " + "$" + (offset + 3) + "::text" + ")");',
        );
    });

    it("leaves a non-insertable column out of the insert statement", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("derived", { insertable: false }),
        ]);
        const insert = generateCreate(limited).match(/insert into "limited" \(([^)]*)\)/)?.[1] ?? "";

        expect(insert).toContain('"label"');
        expect(insert).not.toContain('"derived"');
    });

    it("reads an inlined optional field through optional chaining", () => {
        const code = generateCreate(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerName", { read: "customer?.name", notNull: false }),
            ]),
        );

        expect(code).toContain("const values = [row.id, row.customer?.name];");
    });

    it("reads each column through its recorded accessor", () => {
        const code = generateCreate(
            table("invoice", "Invoice", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerId", { sqlType: "uuid", read: "customer?.id", notNull: false }),
            ]),
        );

        expect(code).toContain("const values = [row.id, row.customer?.id];");
    });

    it("falls back to the default keyword when a create omits a defaulted column", () => {
        const code = generateCreate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("source", { default: "'manual'" }),
            ]),
        );

        expect(code).toContain('insert into "customer" ("id", "name", "source") values ');
        expect(code).toContain("if (row.source === undefined) {");
        expect(code).toContain('values.push("default");');
        expect(code).toContain("parameters.push(row.source);");
        expect(code).toContain("parameters.push(row.id);");
    });

    it("omits a @version column from insert", () => {
        const code = generateCreate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("version", { sqlType: "int8", default: "0", version: true }),
            ]),
        );

        expect(code).toContain("const values = [row.id, row.name];");
        expect(code).toContain('insert into "customer" ("id", "name") values ');
    });
});

describe("generateUpdate", () => {
    it("builds one statement per row, naming the columns the row supplies", () => {
        const code = generateUpdate(customer);

        expect(code).toContain("export async function updateCustomer(db: SqlExecutor, rows: CustomerPatch[]): Promise<void> {");
        expect(code).toContain("        for (const row of rows) {");
        expect(code).toContain('            if (row.name !== undefined) {');
        expect(code).toContain('                add("name", "text", row.name);');
        expect(code).toContain('                assignments.push("\\"name\\" = data.\\"name\\"");');
        expect(code).toContain(
            "await tx.query('update \"customer\" set ' + assignments.join(\", \") + ' from (values (' + values.join(\", \") + ')) as data(' + names.join(\", \") + ') where \"customer\".\"id\" = data.\"id\"', parameters);",
        );
    });

    it("leaves a non-updatable column out of the patch statement", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("derived", { notNull: false, updatable: false }),
        ]);

        expect(generateUpdate(limited)).toContain('add("label", "text", row.label);');
        expect(generateUpdate(limited)).not.toContain('"derived"');
    });

    it("patches a defaulted column, since a caller may override the default", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("createdAt", { sqlType: "timestamptz", default: "now()" }),
            column("version", { sqlType: "int8", default: "0", version: true }),
        ]);

        expect(generateUpdate(limited)).toContain('add("createdAt", "timestamptz", row.createdAt);');
    });

    it("predicates on the version instead of assigning it, and rejects a row it did not match", () => {
        const code = generateUpdate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("version", { sqlType: "int8", default: "0", version: true }),
            ]),
        );

        // The version travels as a parameter for the `where`, so it is read unconditionally …
        expect(code).toContain('            add("version", "int8", row.version);');
        expect(code).toContain('and "customer"."version" = data."version"', );
        // … but it is the trigger that increments it, never the `set` clause. See docs/versioning.md.
        expect(code).not.toContain('assignments.push("\\"version\\" = data.\\"version\\"");');
        expect(code).not.toContain("if (row.version !== undefined)");
        expect(code).toContain("            if (affectedRows(result) === 0) {");
        expect(code).toContain("code: \"40001\"");
        expect(code).toContain("no row of customer is at the version this patch supplied for ' + row.id");
    });

    it("carries no version for an entity that has none, and still rejects an unmatched row", () => {
        const snapshot = generateUpdate(
            table("invoice_sent", "InvoiceSent", [column("id", { sqlType: "uuid", primaryKey: true }), column("number")]),
        );

        expect(snapshot).not.toContain('add("version"');
        expect(snapshot).not.toContain('"invoice_sent"."version"');
        expect(snapshot).toContain("no row of invoice_sent matches this patch: ' + row.id");
        expect(snapshot).toContain("code: \"40001\"");
    });

    it("names every key column of a composite key in the rejection message", () => {
        const code = generateUpdate(
            table("translation", "Translation", [
                column("lang", { sqlType: "text", primaryKey: true }),
                column("key", { sqlType: "text", primaryKey: true }),
            ]),
        );

        expect(code).toContain("no row of translation matches this patch: ' + row.lang + \"/\" + row.key");
    });

    it("reads each column through its recorded accessor, and tests the outer field for an inlined one", () => {
        const code = generateUpdate(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerName", { read: "customer?.name", notNull: false, supplied: "row.customer !== undefined" }),
            ]),
        );

        expect(code).toContain("            if (row.customer !== undefined) {");
        expect(code).toContain('                add("customerName", "text", row.customer?.name);');
    });

    it("sets the key to itself when an entity with no version is patched with no fields", () => {
        const code = generateUpdate(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("note", { notNull: false }),
            ]),
        );

        expect(code).toContain("            if (assignments.length === 0) {");
        expect(code).toContain('                assignments.push("\\"id\\" = data.\\"id\\"");');
    });

    it("takes one statement without a boundary for a single row, and opens one for several", () => {
        const code = generateUpdate(customer);

        expect(code).toContain("    if (rows.length === 1) {");
        expect(code).toContain("        await write(db);");
        expect(code).toContain("    await db.transaction(write);");
    });

    it("names every key column of a composite key, so a row is matched on all of them", () => {
        const code = generateUpdate(translation);

        expect(code).toContain('            add("languageCode", "text", row.languageCode);');
        expect(code).toContain('            add("key", "text", row.key);');
    });
});

describe("generateDelete", () => {
    it("deletes by the primary key columns only", () => {
        const code = generateDelete(customer);

        expect(code).toContain('delete from "customer" using (values ');
        expect(code).toContain(') as data("id") where "customer"."id" = data."id"');
        expect(code).toContain("const values = [row.id];");
    });

    it("matches every column of a composite key on delete", () => {
        const code = generateDelete(translation);

        expect(code).toContain(') as data("languageCode", "key")');
        expect(code).toContain('where "translation"."languageCode" = data."languageCode" and "translation"."key" = data."key"');
        expect(code).toContain("const values = [row.languageCode, row.key];");
    });
});

describe("generateIndex", () => {
    it("re-exports every operation module grouped by entity", () => {
        const code = generateIndex([
            table("invoice_row", "InvoiceRow", []),
            table("customer", "Customer", []),
        ]);

        expect(code).toBe(
            [
                "// Generated by scripts/generate-repositories.ts. Do not edit.",
                'export * from "./createCustomer.ts";',
                'export * from "./updateCustomer.ts";',
                'export * from "./deleteCustomer.ts";',
                'export * from "./createInvoiceRow.ts";',
                'export * from "./updateInvoiceRow.ts";',
                'export * from "./deleteInvoiceRow.ts";',
                "",
            ].join("\n"),
        );
    });
});

describe("generateRepositories", () => {
    it("emits one file per operation plus a barrel", () => {
        const tables = new Map<string, Table>([
            ["Customer", customer],
            ["Invoice", table("invoice", "Invoice", [column("id", { primaryKey: true })])],
        ]);

        const files = generateRepositories(tables);

        expect([...files.keys()].sort()).toEqual([
            "createCustomer.ts",
            "createInvoice.ts",
            "deleteCustomer.ts",
            "deleteInvoice.ts",
            "index.ts",
            "updateCustomer.ts",
            "updateInvoice.ts",
        ]);
    });
});

const owner = table("owner", "Owner", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("name"),
]);

const widget = table("widget", "Widget", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("name"),
    column("note", { notNull: false }),
    column("ownerId", { sqlType: "uuid", notNull: false, read: "owner?.id" }),
    column("version", { sqlType: "int8", default: "0", version: true }),
]);

const marker = table("marker", "Marker", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("label"),
    column("source", { default: "'manual'" }),
]);

const OWNER_ID = "00000000-0000-0000-0000-0000000000aa";
const WIDGET_ID = "00000000-0000-0000-0000-0000000000bb";
const MARKER_ID = "00000000-0000-0000-0000-0000000000cc";
const MARKER_ID_OVERRIDDEN = "00000000-0000-0000-0000-0000000000dd";
const WIDGET_ID_OTHER = "00000000-0000-0000-0000-0000000000ee";

describe("generated repositories against PGlite", () => {
    let driver: ReturnType<typeof createPglite>;
    let db: SqlExecutor;
    let owners: GeneratedRepository;
    let widgets: GeneratedRepository;
    let translations: GeneratedRepository;
    let markers: GeneratedRepository;

    beforeAll(async () => {
        driver = createPglite();
        db = createTransactionalDb(createPglitePool(driver));
        await driver.exec(createTableSql(owner));
        await driver.exec(createTableSql(widget));
        await driver.exec(versionTriggerSql(widget));
        await driver.exec(createTableSql(translation));
        await driver.exec(createTableSql(marker));
        owners = loadRepository(owner);
        widgets = loadRepository(widget);
        translations = loadRepository(translation);
        markers = loadRepository(marker);
    });

    afterAll(async () => {
        await driver.close();
    });

    beforeEach(async () => {
        await db.query('delete from "widget"');
        await db.query('delete from "owner"');
        await db.query('delete from "translation"');
        await db.query('delete from "marker"');
    });

    it("inserts rows through the generated create function", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: null, owner: { id: OWNER_ID } }]);

        const { rows } = await driver.query<{ id: string; name: string; note: string | null; ownerId: string | null }>(
            'select "id", "name", "note", "ownerId" from "widget"',
        );

        expect(rows).toEqual([{ id: WIDGET_ID, name: "run", note: null, ownerId: OWNER_ID }]);
    });

    it("lets a create supply a defaulted column, and falls back to the default when it omits one", async () => {
        await markers.create(db, [{ id: MARKER_ID, label: "omitted" }]);
        await markers.create(db, [{ id: MARKER_ID_OVERRIDDEN, label: "supplied", source: "import" }]);

        const { rows } = await driver.query<{ id: string; source: string }>(
            'select "id", "source" from "marker" order by "label"',
        );

        expect(rows).toEqual([
            { id: MARKER_ID, source: "manual" },
            { id: MARKER_ID_OVERRIDDEN, source: "import" },
        ]);
    });

    it("carries a related entity's key through the generated read accessor", async () => {
        await owners.create(db, [{ id: OWNER_ID, name: "owner" }]);
        await widgets.create(db, [{ id: WIDGET_ID, name: "child", note: null, owner: { id: OWNER_ID } }]);

        const { rows } = await driver.query<{ ownerId: string | null }>('select "ownerId" from "widget"');

        expect(rows).toEqual([{ ownerId: OWNER_ID }]);
    });

    it("patches only the columns the caller supplies", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "before", note: "keep", owner: { id: OWNER_ID } }]);

        await widgets.update(db, [{ id: WIDGET_ID, name: "after", version: 0n }]);

        const { rows } = await driver.query<{ name: string; note: string | null; version: bigint }>(
            'select "name", "note", "version" from "widget"',
        );

        // The patch carries the version as a precondition, so the trigger still owns the counter.
        expect(rows).toEqual([{ name: "after", note: "keep", version: 1n }]);
    });

    it("increments the version once per matching patch", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: null, owner: { id: OWNER_ID } }]);

        await widgets.update(db, [{ id: WIDGET_ID, name: "one", version: 0n }]);
        await widgets.update(db, [{ id: WIDGET_ID, name: "two", version: 1n }]);

        const { rows } = await driver.query<{ name: string; version: bigint }>(
            'select "name", "version" from "widget"',
        );

        expect(rows).toEqual([{ name: "two", version: 2n }]);
    });

    it("rejects a patch whose version is stale, leaving the row as it was", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: null, owner: { id: OWNER_ID } }]);
        await widgets.update(db, [{ id: WIDGET_ID, name: "first", version: 0n }]);

        // The caller still holds version 0, which the row has moved past.
        await expect(widgets.update(db, [{ id: WIDGET_ID, name: "second", version: 0n }])).rejects.toThrow(
            `no row of widget is at the version this patch supplied for ${WIDGET_ID}`,
        );

        const { rows } = await driver.query<{ name: string; version: bigint }>(
            'select "name", "version" from "widget"',
        );

        expect(rows).toEqual([{ name: "first", version: 1n }]);
    });

    it("rejects a patch with the code the router maps to a conflict", async () => {
        await expect(widgets.update(db, [{ id: WIDGET_ID, name: "run", version: 0n }])).rejects.toMatchObject({
            code: "40001",
        });
    });

    it("rejects the whole call when one row of several is stale", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: "keep", owner: { id: OWNER_ID } }]);
        await widgets.create(db, [{ id: WIDGET_ID_OTHER, name: "run", note: "keep", owner: { id: OWNER_ID } }]);
        await widgets.update(db, [{ id: WIDGET_ID, note: "changed", version: 0n }]);

        await expect(
            widgets.update(db, [
                { id: WIDGET_ID_OTHER, name: "renamed", version: 0n },
                { id: WIDGET_ID, name: "renamed", version: 0n },
            ]),
        ).rejects.toThrow(`no row of widget is at the version this patch supplied for ${WIDGET_ID}`);

        const { rows } = await driver.query<{ id: string; name: string; note: string | null }>(
            'select "id", "name", "note" from "widget" order by "id"',
        );

        // The row the first statement did match is rolled back with the rest of the call.
        expect(rows).toEqual([
            { id: WIDGET_ID, name: "run", note: "changed" },
            { id: WIDGET_ID_OTHER, name: "run", note: "keep" },
        ]);
    });

    it("clears a nullable column when the patch sets it to null", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: "keep", owner: { id: OWNER_ID } }]);

        await widgets.update(db, [{ id: WIDGET_ID, note: null, version: 0n }]);

        const { rows } = await driver.query<{ name: string; note: string | null }>(
            'select "name", "note" from "widget"',
        );

        expect(rows).toEqual([{ name: "run", note: null }]);
    });

    it("lets the database reject a null for a column that cannot hold one", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: "keep", owner: { id: OWNER_ID } }]);

        await expect(widgets.update(db, [{ id: WIDGET_ID, name: null, version: 0n }])).rejects.toThrow();

        const { rows } = await driver.query<{ name: string }>('select "name" from "widget"');
        expect(rows).toEqual([{ name: "run" }]);
    });

    it("patches rows that supply different fields in one call", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: "keep", owner: { id: OWNER_ID } }]);
        await widgets.create(db, [{ id: WIDGET_ID_OTHER, name: "run", note: "keep", owner: { id: OWNER_ID } }]);

        await widgets.update(db, [
            { id: WIDGET_ID, note: "changed", version: 0n },
            { id: WIDGET_ID_OTHER, name: "renamed", version: 0n },
        ]);

        const { rows } = await driver.query<{ id: string; name: string; note: string | null }>(
            'select "id", "name", "note" from "widget" order by "id"',
        );

        expect(rows).toEqual([
            { id: WIDGET_ID, name: "run", note: "changed" },
            { id: WIDGET_ID_OTHER, name: "renamed", note: "keep" },
        ]);
    });

    it("deletes rows through the generated delete function", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "gone", note: null, owner: { id: OWNER_ID } }]);

        await widgets.delete(db, [{ id: WIDGET_ID }]);

        const { rows } = await driver.query('select "id" from "widget"');

        expect(rows).toEqual([]);
    });

    it("treats an empty array as a no-op", async () => {
        await expect(widgets.create(db, [])).resolves.toBeUndefined();
        await expect(widgets.update(db, [])).resolves.toBeUndefined();
        await expect(widgets.delete(db, [])).resolves.toBeUndefined();
    });

    it("addresses a composite-key row by all of its key columns", async () => {
        await translations.create(db, [{ languageCode: "en", key: "greeting", value: "hi" }]);
        await translations.create(db, [{ languageCode: "fr", key: "greeting", value: "salut" }]);

        await translations.update(db, [{ languageCode: "fr", key: "greeting", value: "bonjour" }]);

        const { rows } = await driver.query<{ languageCode: string; key: string; value: string }>(
            'select "languageCode", "key", "value" from "translation" order by "languageCode"',
        );

        expect(rows).toEqual([
            { languageCode: "en", key: "greeting", value: "hi" },
            { languageCode: "fr", key: "greeting", value: "bonjour" },
        ]);
    });

    it("deletes only the composite-key row it names", async () => {
        await translations.create(db, [{ languageCode: "en", key: "greeting", value: "hi" }]);
        await translations.create(db, [{ languageCode: "en", key: "farewell", value: "bye" }]);

        await translations.delete(db, [{ languageCode: "en", key: "farewell" }]);

        const { rows } = await driver.query<{ key: string }>('select "key" from "translation"');

        expect(rows).toEqual([{ key: "greeting" }]);
    });
});
