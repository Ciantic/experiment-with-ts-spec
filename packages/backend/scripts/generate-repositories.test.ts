/** Unit tests for the repository generator, driven by self-contained table fixtures. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ts } from "ts-morph";
import { createPglite, createPglitePool } from "../src/postgres/pglite-setup.ts";
import * as sqlExecutor from "../src/db/sql-executor.ts";
import type { SqlExecutor } from "../src/db/sql-executor.ts";
import { createTransactionalDb } from "../src/db/sql-executor.ts";
import {
    createStatement,
    deleteStatement,
    generateCreate,
    generateDelete,
    generateIndex,
    generateRepositories,
    generateUpdate,
    generateUpsert,
    statementSql,
    updateStatement,
    upsertStatement,
} from "./generate-repositories.ts";
import { renderCreateTable, renderVersionTrigger } from "./generate-postgres-schema.ts";
import type { Column, Table } from "./postgres-model.ts";
import { WRITE_OPERATIONS } from "spec/scripts/spec-model.ts";

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
        repositoryOperations: [...WRITE_OPERATIONS],
        queries: ["query"],
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

/** A key, a plain column, and the optimistic-lock claim a versioned entity carries. */
const versioned = table("customer", "Customer", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("name"),
    column("version", { sqlType: "int8", default: "0", version: true }),
]);

/** An entity with nothing to write but its key, so a statement still has to name a `set`. */
const keyOnly = table("key_only", "KeyOnly", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("derived", { notNull: false, insertable: false }),
]);

/** An identity key the database assigns: a create leaves it out, and an upsert names it to match its conflict. */
const ticket = table("ticket", "Ticket", [
    column("id", { sqlType: "integer", primaryKey: true, identity: true, insertable: false }),
    column("label"),
]);

/** A defaulted column a row may omit, so a write binds a flag beside its values. */
const defaulted = table("email", "Email", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("subject"),
    column("status", { default: "'pending'" }),
]);

/** The DDL for a fixture: the table and its version trigger, rendered by the same generator that writes `schema.sql`. */
function fixtureDdl(table: Table): string {
    return [...renderCreateTable(table), ...renderVersionTrigger(table)].join("\n");
}

/** The three generated CRUD functions, resolved from the three operation modules. */
interface GeneratedRepository {
    create: (db: SqlExecutor, rows: unknown[]) => Promise<unknown[]>;
    upsert: (db: SqlExecutor, rows: unknown[]) => Promise<unknown[]>;
    update: (db: SqlExecutor, rows: unknown[]) => Promise<unknown>;
    delete: (db: SqlExecutor, rows: unknown[]) => Promise<unknown>;
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
        return fn as (db: SqlExecutor, rows: unknown[]) => Promise<unknown[]>;
    };
    return {
        create: pick("create", generateCreate(table)),
        upsert: pick("upsert", generateUpsert(table)),
        update: pick("update", generateUpdate(table)),
        delete: pick("delete", generateDelete(table)),
    };
}

/** Every operation module for a table, so a test can assert across all of them. */
function moduleCodes(table: Table): string[] {
    return [generateCreate(table), generateUpsert(table), generateUpdate(table), generateDelete(table)];
}

/**
 * A db that records the SQL it is handed, and answers as a one-row write would: a statement that reads
 * its rows back matches them on the keys it was handed, so the answer echoes those keys. A delete binds
 * a flat parameter list and reads nothing back, so it has no rows to echo.
 */
function recordingDb(statements: string[], keyColumns: string[] = ["id"]): SqlExecutor {
    const handle: SqlExecutor = {
        query: async (sql, parameters) => {
            statements.push(sql);
            const arrays = Array.isArray(parameters?.[0]) ? (parameters as unknown[][]) : [];
            const rows = (arrays[0] ?? []).map((_, index) =>
                Object.fromEntries(keyColumns.map((name, position) => [name, arrays[position]?.[index]])),
            );
            return { affectedRows: rows.length, rows };
        },
        transaction: (run) => run(handle),
    };
    return handle;
}

/** A row for a fixture: every column carries its own name, so a key read and the value bound for it agree. */
function rowFor(table: Table): Record<string, string> {
    return Object.fromEntries(table.columns.map((column) => [column.name, column.name]));
}

/** The fixtures the tie-back walks, with the key columns their statements bind first. */
const tiedBack: Array<[string, Table, string[]]> = [
    ["customer", customer, ["id"]],
    ["translation", translation, ["languageCode", "key"]],
    ["versioned", versioned, ["id"]],
    ["defaulted", defaulted, ["id"]],
    ["keyOnly", keyOnly, ["id"]],
];

/** The one-row tuple list a delete builds, which is the part of its SQL the runtime finishes. */
function deleteTuples(table: Table, keyColumns: string[]): string {
    const cast = (name: string) => table.columns.find((column) => column.name === name)?.sqlType ?? "text";
    const placeholders = keyColumns.map((name, index) => `$${index + 1}::${cast(name)}`).join(", ");
    return `(${placeholders})`;
}

describe("createStatement", () => {
    it("builds the insert from the table alone, with no database and no rows", () => {
        expect(statementSql(createStatement(customer))).toBe(
            'insert into "customer" ("id", "name", "email") select v."id", v."name", v."email" ' +
                'from unnest($1::uuid[], $2::text[], $3::text[]) as v("id", "name", "email") ' +
                'returning "customer"."id"',
        );
    });

    it("binds one array per written column, in the order the placeholders number them", () => {
        expect(createStatement(customer).arrays.map((array) => [array.alias, array.cast, array.element])).toEqual([
            ["id", "uuid[]", "row.id ?? null"],
            ["name", "text[]", "row.name ?? null"],
            ["email", "text[]", "row.email ?? null"],
        ]);
    });

    it("falls back to the column default for a row that omits it, binding a flag beside the values", () => {
        expect(statementSql(createStatement(defaulted))).toBe(
            'insert into "email" ("id", "subject", "status") select v."id", v."subject", ' +
                "case when v.\"status#present\" then v.\"status\" else 'pending' end " +
                'from unnest($1::uuid[], $2::text[], $3::text[], $4::bool[]) ' +
                'as v("id", "subject", "status", "status#present") ' +
                'returning "email"."id"',
        );
        expect(createStatement(defaulted).arrays.map((array) => array.alias)).toEqual([
            "id",
            "subject",
            "status",
            "status#present",
        ]);
    });

    it("leaves the version out of the insert, since a create takes it from its default", () => {
        expect(statementSql(createStatement(versioned))).toBe(
            'insert into "customer" ("id", "name") select v."id", v."name" ' +
                'from unnest($1::uuid[], $2::text[]) as v("id", "name") ' +
                'returning "customer"."id"',
        );
    });

    it("leaves a column a create never writes out of the statement and out of the arrays", () => {
        const limited = createStatement(
            table("limited", "Limited", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("label"),
                column("derived", { insertable: false }),
            ]),
        );

        expect(statementSql(limited)).toContain('("id", "label") select');
        expect(statementSql(limited)).not.toContain("derived");
        expect(limited.arrays.map((array) => array.alias)).toEqual(["id", "label"]);
    });

    it("leaves the identity column out and returns the key the database assigned", () => {
        expect(statementSql(createStatement(ticket))).toBe(
            'insert into "ticket" ("label") select v."label" ' +
                'from unnest($1::text[]) as v("label") returning "ticket"."id"',
        );
        expect(createStatement(ticket).arrays.map((array) => array.alias)).toEqual(["label"]);
    });
});

describe("updateStatement", () => {
    it("builds the patch from the table alone, keeping a stored value where a row omits a column", () => {
        expect(statementSql(updateStatement(customer))).toBe(
            'update "customer" as u set "name" = case when v."name#present" then v."name" else u."name" end, ' +
                '"email" = case when v."email#present" then v."email" else u."email" end ' +
                'from unnest($1::uuid[], $2::text[], $3::bool[], $4::text[], $5::bool[]) ' +
                'as v("id", "name", "name#present", "email", "email#present") ' +
                'where u."id" = v."id" returning u."id"',
        );
    });

    it("binds the key, then a value and a flag for every column a patch may supply", () => {
        expect(updateStatement(customer).arrays.map((array) => [array.alias, array.cast])).toEqual([
            ["id", "uuid[]"],
            ["name", "text[]"],
            ["name#present", "bool[]"],
            ["email", "text[]"],
            ["email#present", "bool[]"],
        ]);
    });

    it("matches every column of a composite key, and returns all of them", () => {
        expect(statementSql(updateStatement(translation))).toBe(
            'update "translation" as u set "value" = case when v."value#present" then v."value" else u."value" end ' +
                'from unnest($1::text[], $2::text[], $3::text[], $4::bool[]) ' +
                'as v("languageCode", "key", "value", "value#present") ' +
                'where u."languageCode" = v."languageCode" and u."key" = v."key" ' +
                'returning u."languageCode", u."key"',
        );
    });

    it("claims the version in the where instead of assigning it, leaving the counter to the trigger", () => {
        const sql = statementSql(updateStatement(versioned));

        expect(sql).toBe(
            'update "customer" as u set "name" = case when v."name#present" then v."name" else u."name" end ' +
                'from unnest($1::uuid[], $2::int8[], $3::text[], $4::bool[]) ' +
                'as v("id", "version", "name", "name#present") ' +
                'where u."id" = v."id" and u."version" = v."version" returning u."id"',
        );
        // The version rides along in the key arrays, and the `set` list never names it.
        expect(updateStatement(versioned).arrays.map((array) => array.alias)).toEqual([
            "id",
            "version",
            "name",
            "name#present",
        ]);
        expect(/set (.*?) from unnest/.exec(sql)?.[1]).not.toContain("version");
    });

    it("sets the key to itself for an entity with no writable column, so the statement still writes a row", () => {
        expect(statementSql(updateStatement(keyOnly))).toBe(
            'update "key_only" as u set "id" = u."id" from unnest($1::uuid[]) as v("id") ' +
                'where u."id" = v."id" returning u."id"',
        );
    });
});

describe("upsertStatement", () => {
    it("builds the insert and the replacement from the table alone", () => {
        expect(statementSql(upsertStatement(customer))).toBe(
            'insert into "customer" ("id", "name", "email") select v."id", v."name", v."email" ' +
                'from unnest($1::uuid[], $2::text[], $3::text[]) as v("id", "name", "email") ' +
                'on conflict ("id") do update set "name" = excluded."name", "email" = excluded."email" ' +
                'returning "customer"."id"',
        );
    });

    it("conflicts on every column of a composite key, and replaces the rest", () => {
        expect(statementSql(upsertStatement(translation))).toBe(
            'insert into "translation" ("languageCode", "key", "value") ' +
                'select v."languageCode", v."key", v."value" ' +
                'from unnest($1::text[], $2::text[], $3::text[]) as v("languageCode", "key", "value") ' +
                'on conflict ("languageCode", "key") do update set "value" = excluded."value" ' +
                'returning "translation"."languageCode", "translation"."key"',
        );
    });

    it("claims the version, writing it and comparing it instead of assigning it", () => {
        expect(statementSql(upsertStatement(versioned))).toBe(
            'insert into "customer" as u ("id", "name", "version") select v."id", v."name", v."version" ' +
                'from unnest($1::uuid[], $2::text[], $3::int8[]) as v("id", "name", "version") ' +
                'on conflict ("id") do update set "name" = excluded."name" ' +
                'where u."version" = excluded."version" returning u."id"',
        );
        // The claim is always written, so it binds no flag.
        expect(upsertStatement(versioned).arrays.map((array) => array.alias)).toEqual(["id", "name", "version"]);
    });

    it("carries no alias or version predicate, and still returns the keys, for an entity with no version", () => {
        const sql = statementSql(upsertStatement(customer));

        expect(sql).not.toContain(" as u ");
        expect(sql).not.toContain("where");
        expect(sql).toContain('returning "customer"."id"');
    });

    it("falls back to the column default on the conflict path, which can only read `excluded`", () => {
        expect(statementSql(upsertStatement(defaulted))).toContain(
            "case when v.\"status#present\" then v.\"status\" else 'pending' end ",
        );
        expect(statementSql(upsertStatement(defaulted))).toContain('"status" = excluded."status"');
    });

    it("sets the key to the stored one when the entity has no column to replace", () => {
        expect(statementSql(upsertStatement(keyOnly))).toBe(
            'insert into "key_only" ("id") select v."id" from unnest($1::uuid[]) as v("id") ' +
                'on conflict ("id") do update set "id" = "key_only"."id" ' +
                'returning "key_only"."id"',
        );
    });

    it("names the identity key, which is what the conflict matches and what the caller claims", () => {
        expect(statementSql(upsertStatement(ticket))).toBe(
            'insert into "ticket" ("label", "id") select v."label", v."id" ' +
                'from unnest($1::text[], $2::integer[]) as v("label", "id") ' +
                'on conflict ("id") do update set "label" = excluded."label" ' +
                'returning "ticket"."id"',
        );
        // The claim is always present, so it binds no presence flag beside its values.
        expect(upsertStatement(ticket).arrays.map((array) => array.alias)).toEqual(["label", "id"]);
    });
});

describe("deleteStatement", () => {
    it("deletes by the primary key columns only, around the tuple list the runtime builds", () => {
        expect(deleteStatement(customer)).toEqual({
            before: 'delete from "customer" using (values ',
            after: ') as data("id") where "customer"."id" = data."id"',
        });
    });

    it("matches every column of a composite key on delete", () => {
        expect(deleteStatement(translation)).toEqual({
            before: 'delete from "translation" using (values ',
            after:
                ') as data("languageCode", "key") where "translation"."languageCode" = data."languageCode" and "translation"."key" = data."key"',
        });
    });
});

describe("statementSql", () => {
    it("is the SQL a generated module runs, so the planner and the emitted module cannot disagree", async () => {
        for (const [name, fixture, keyColumns] of tiedBack) {
            const statements: string[] = [];
            const repository = loadRepository(fixture);
            const rows = [rowFor(fixture)];

            await repository.create(recordingDb(statements, keyColumns), rows);
            await repository.update(recordingDb(statements, keyColumns), rows);
            await repository.upsert(recordingDb(statements, keyColumns), rows);
            await repository.delete(recordingDb(statements, keyColumns), rows);

            const deletion = deleteStatement(fixture);
            expect(statements, name).toEqual([
                statementSql(createStatement(fixture)),
                statementSql(updateStatement(fixture)),
                statementSql(upsertStatement(fixture)),
                // A delete is the one statement the runtime finishes, one tuple per row.
                `${deletion.before}${deleteTuples(fixture, keyColumns)}${deletion.after}`,
            ]);
        }
    });
});

describe("generateCreate", () => {
    it("starts each operation module with the do-not-edit header", () => {
        for (const code of moduleCodes(customer)) {
            expect(code.startsWith("// Generated by scripts/generate-repositories.ts. Do not edit.\n")).toBe(true);
        }
    });

    it("imports the write types for its operation and the executor interface", () => {
        expect(generateCreate(customer)).toContain(
            'import type { CustomerInsert } from "validation/repositories/customerInsertSchema.ts";',
        );
        expect(generateUpdate(customer)).toContain(
            'import type { CustomerPatch } from "validation/repositories/customerPatchSchema.ts";',
        );
        expect(generateDelete(customer)).toContain(
            'import type { CustomerPrimaryKey } from "validation/repositories/customerPrimaryKeySchema.ts";',
        );
        // A create reports the keys it wrote, so it names the key type the delete also takes.
        expect(generateCreate(customer)).toContain(
            'import type { CustomerPrimaryKey } from "validation/repositories/customerPrimaryKeySchema.ts";',
        );
        expect(generateUpsert(customer)).toContain(
            'import type { CustomerPrimaryKey } from "validation/repositories/customerPrimaryKeySchema.ts";',
        );
        for (const code of [generateCreate(customer), generateDelete(customer)]) {
            expect(code).not.toContain("spec/domain");
        }
        // A delete is one statement, so it takes the executor type alone; a create reads its keys back, so it takes the helpers too.
        expect(generateDelete(customer)).toContain('import type { SqlExecutor } from "../sql-executor.ts";');
        expect(generateCreate(customer)).toContain(
            'import { MAX_STATEMENT_PARAMETERS, resultRows, type SqlExecutor } from "../sql-executor.ts";',
        );
        // A patch reads the rows a statement wrote back, so it takes the port's runtime helpers with it.
        expect(generateUpdate(customer)).toContain(
            'import { MAX_STATEMENT_PARAMETERS, resultRows, type SqlExecutor } from "../sql-executor.ts";',
        );
        expect(generateUpdate(customer)).not.toContain('import type { SqlExecutor } from "../sql-executor.ts";');
    });

    it("exports the operation taking rows and returning the keys it wrote", () => {
        expect(generateCreate(customer)).toContain(
            "export async function createCustomer(db: SqlExecutor, rows: CustomerInsert[]): Promise<CustomerPrimaryKey[]> {",
        );
        expect(generateUpsert(customer)).toContain(
            "export async function upsertCustomer(db: SqlExecutor, rows: CustomerUpsert[]): Promise<CustomerPrimaryKey[]> {",
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

    it("inserts a chunk of rows, filling one array per column and handing them to the statement", () => {
        const code = generateCreate(customer);

        expect(code).toContain("                idValues.push(row.id ?? null);");
        expect(code).toContain("                nameValues.push(row.name ?? null);");
        expect(code).toContain("                [idValues, nameValues, emailValues],");
    });

    it("reads an inlined optional field through optional chaining", () => {
        const code = generateCreate(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerName", { read: "customer?.name", notNull: false }),
            ]),
        );

        expect(code).toContain("                customerNameValues.push(row.customer?.name ?? null);");
    });

    it("reads each column through its recorded accessor", () => {
        const code = generateCreate(
            table("invoice", "Invoice", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerId", { sqlType: "uuid", read: "customer?.id", notNull: false }),
            ]),
        );

        expect(code).toContain("                customerIdValues.push(row.customer?.id ?? null);");
    });

    it("falls back to the column default when a create omits it, and writes a null the caller sends", () => {
        const code = generateCreate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("source", { default: "'manual'" }),
            ]),
        );

        expect(code).toContain("                sourceValues.push(row.source ?? null);");
        expect(code).toContain("                sourcePresent.push(row.source !== undefined);");
        // Only a defaulted column carries the flag, since every other column is always written.
        expect(code).not.toContain("namePresent");
        expect(code).not.toContain("idPresent");
    });

    it("omits a @version column from insert", () => {
        const code = generateCreate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("version", { sqlType: "int8", default: "0", version: true }),
            ]),
        );

        expect(code).toContain("                idValues.push(row.id ?? null);");
        expect(code).toContain("                nameValues.push(row.name ?? null);");
        expect(code).not.toContain("versionValues");
    });

    it("splits a create into chunks that each stay inside the parameter limit", () => {
        const code = generateCreate(customer);

        expect(code).toContain(
            "/** The rows one insert carries, so its parameters stay inside MAX_STATEMENT_PARAMETERS. */",
        );
        expect(code).toContain("const PARAMETERS_PER_ROW = 3;");
        expect(code).toContain("const ROWS_PER_STATEMENT = Math.floor(MAX_STATEMENT_PARAMETERS / PARAMETERS_PER_ROW);");
        expect(code).toContain("const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);");
        expect(code).toContain("for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {");
        expect(code).toContain("for (const row of chunk) {");
    });

    it("rejects a create whose statement wrote fewer rows than it carried", () => {
        const code = generateCreate(customer);

        expect(code).toContain("const result = await tx.query(");
        expect(code).toContain("const written = resultRows(result);");
        expect(code).toContain("if (written.length !== chunk.length) {");
        expect(code).toContain(
            "throw new Error('the insert wrote ' + written.length + ' of the ' + chunk.length + ' customer rows this create supplied');",
        );
    });

    it("takes the shape of a patch runner: one write closure, and a boundary only past a single statement", () => {
        const code = generateCreate(customer);

        expect(code).toContain("    const write = async (tx: SqlExecutor): Promise<void> => {");
        expect(code).toContain("    if (rows.length <= ROWS_PER_STATEMENT) {");
        expect(code).toContain("        await write(db);");
        expect(code).toContain("    await db.transaction(write);");
        // Nothing but the exported function and its three constants is declared at module scope.
        expect(code.match(/^const |^async function |^function /gm)).toEqual(["const ", "const ", "const "]);
    });

    it("sizes a chunk by the arrays a row binds, so a wider entity carries fewer rows", () => {
        const wide = table("wide", "Wide", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("a"),
            column("b"),
            column("c"),
            column("d"),
        ]);
        const defaulted = table("defaulted", "Defaulted", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("a"),
            column("b"),
            column("c", { default: "'x'" }),
        ]);

        expect(generateCreate(wide)).toContain("const PARAMETERS_PER_ROW = 5;");
        // A defaulted column binds a further array for the flag, so it costs a row like any other.
        expect(generateCreate(defaulted)).toContain("const PARAMETERS_PER_ROW = 5;");
    });
});

describe("generateUpdate", () => {
    it("carries a chunk of rows in one statement, marking whether each row supplied a column", () => {
        const code = generateUpdate(customer);

        expect(code).toContain("export async function updateCustomer(db: SqlExecutor, rows: CustomerPatch[]): Promise<void> {");
        expect(code).toContain("        for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {");
        expect(code).toContain("            const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);");
        expect(code).toContain("                nameValues.push(row.name ?? null);");
        expect(code).toContain("                namePresent.push(row.name !== undefined);");
        expect(code).toContain('\'"name" = case when v."name#present" then v."name" else u."name" end, \'');
        expect(code).toContain(
            '\'from unnest($1::uuid[], $2::text[], $3::bool[], $4::text[], $5::bool[]) as v(\' +',
        );
        expect(code).toContain('\'"id", "name", "name#present", "email", "email#present") \' +');
        expect(code).toContain('\'where u."id" = v."id" \'');
        expect(code).toContain("                [idValues, nameValues, namePresent, emailValues, emailPresent],");
    });

    it("reads the rows the statement wrote back, so a chunk that wrote fewer names the rows it left out", () => {
        const code = generateUpdate(customer);

        expect(code).toContain('\'returning u."id"\',');
        expect(code).toContain('            const written = new Set(resultRows(result).map((row) => String(row["id"])));');
        expect(code).toContain("            if (written.size !== chunk.length) {");
        expect(code).toContain("                const missed = chunk.filter((row) => !written.has(keyOf(row)));");
        expect(code).toContain(
            "                throw Object.assign(new Error('no row of customer matches this patch: ' + named.map(keyOf).join(\", \")), { code: \"40001\" });",
        );
    });

    it("leaves a non-updatable column out of the patch statement", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("derived", { notNull: false, updatable: false }),
        ]);

        expect(generateUpdate(limited)).not.toContain('"derived"');
        // The column is left out of the statement and out of the arrays it binds: the key, and one value and flag.
        expect(generateUpdate(limited)).toContain("const PARAMETERS_PER_ROW = 3;");
    });

    it("patches a defaulted column, since a caller may override the default", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("createdAt", { sqlType: "timestamptz", default: "now()" }),
            column("version", { sqlType: "int8", default: "0", version: true }),
        ]);

        expect(generateUpdate(limited)).toContain('"createdAt" = case when v."createdAt#present"');
        expect(generateUpdate(limited)).toContain("                createdAtValues.push(row.createdAt ?? null);");
        expect(generateUpdate(limited)).toContain("                createdAtPresent.push(row.createdAt !== undefined);");
    });

    it("predicates on the version instead of assigning it, and rejects a row it did not match", () => {
        const code = generateUpdate(
            table("customer", "Customer", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("name"),
                column("version", { sqlType: "int8", default: "0", version: true }),
            ]),
        );

        // The version travels among the values the `where` compares, so it is read unconditionally …
        expect(code).toContain("                versionValues.push(row.version ?? null);");
        // … but it is the trigger that increments it, never the `set` clause, and a patch cannot omit it.
        expect(code).not.toContain('"version" = case when');
        expect(code).not.toContain("versionPresent");
        expect(code).toContain("no row of customer is at the version this patch supplied for ' + named.map(keyOf).join(\", \")");
        expect(code).toContain('code: "40001"');
    });

    it("carries no version for an entity that has none, and still rejects an unmatched row", () => {
        const snapshot = generateUpdate(
            table("invoice_sent", "InvoiceSent", [column("id", { sqlType: "uuid", primaryKey: true }), column("number")]),
        );

        expect(snapshot).not.toContain("versionValues");
        expect(snapshot).not.toContain('u."version"');
        expect(snapshot).toContain("no row of invoice_sent matches this patch: ' + named.map(keyOf).join(\", \")");
        expect(snapshot).toContain('code: "40001"');
    });

    it("names every key column of a composite key in the rejection message", () => {
        const code = generateUpdate(
            table("translation", "Translation", [
                column("lang", { sqlType: "text", primaryKey: true }),
                column("key", { sqlType: "text", primaryKey: true }),
            ]),
        );

        expect(code).toContain('const keyOf = (row: TranslationPatch): string => String(row.lang + "/" + row.key);');
        expect(code).toContain('new Set(resultRows(result).map((row) => String(row["lang"]) + "/" + String(row["key"])))');
    });

    it("reads each column through its recorded accessor, and tests the outer field for an inlined one", () => {
        const code = generateUpdate(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerName", { read: "customer?.name", notNull: false, supplied: "row.customer !== undefined" }),
            ]),
        );

        expect(code).toContain("                customerNameValues.push(row.customer?.name ?? null);");
        expect(code).toContain("                customerNamePresent.push(row.customer !== undefined);");
    });

    it("sets the key to itself when the entity has no writable column, so the statement still writes", () => {
        const code = generateUpdate(
            table("gate", "Gate", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("derived", { notNull: false, updatable: false }),
            ]),
        );

        expect(code).toContain('\'"id" = u."id" \'');
        // The key alone, since the entity has no writable column to bind.
        expect(code).toContain("const PARAMETERS_PER_ROW = 1;");
    });

    it("takes one statement without a boundary for a single row, and opens one for several", () => {
        const code = generateUpdate(customer);

        expect(code).toContain("    if (rows.length === 1) {");
        expect(code).toContain("        await write(db);");
        expect(code).toContain("    await db.transaction(write);");
    });

    it("sizes a chunk by the arrays a row binds, a value and a flag per writable column", () => {
        const narrow = generateUpdate(
            table("narrow", "Narrow", [column("id", { sqlType: "uuid", primaryKey: true }), column("label")]),
        );
        const wide = generateUpdate(
            table("wide", "Wide", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                ...Array.from({ length: 4 }, (_, index) => column(`c${index}`)),
            ]),
        );

        expect(narrow).toContain("const PARAMETERS_PER_ROW = 3;");
        expect(wide).toContain("const PARAMETERS_PER_ROW = 9;");
    });

    it("names every key column of a composite key, so a row is matched on all of them", () => {
        const code = generateUpdate(translation);

        expect(code).toContain("                languageCodeValues.push(row.languageCode ?? null);");
        expect(code).toContain("                keyValues.push(row.key ?? null);");
    });
});

describe("generateUpsert", () => {
    it("inserts a chunk of rows, replacing the row each key already holds", () => {
        const code = generateUpsert(customer);

        expect(code).toContain(
            'import type { CustomerUpsert } from "validation/repositories/customerUpsertSchema.ts";',
        );
        expect(code).toContain(
            "export async function upsertCustomer(db: SqlExecutor, rows: CustomerUpsert[]): Promise<CustomerPrimaryKey[]> {",
        );
        expect(code).toContain("                nameValues.push(row.name ?? null);");
        // The key is what the conflict matched, so the `set` list leaves it alone.
        expect(code).not.toContain("excluded.\"id\"");
    });

    it("claims the version a create leaves to its default, and compares it instead of assigning it", () => {
        const code = generateUpsert(versioned);

        // The version is the one column a create omits and an upsert always writes.
        expect(code).toContain("                versionValues.push(row.version ?? null);");
        expect(code).toContain("const PARAMETERS_PER_ROW = 3;");
        // The assignments end where the predicate begins, so the version is never one of them.
        expect(code).not.toContain('\'"version" = excluded."version"');
        // The claim is always present, so it carries no flag.
        expect(code).not.toContain("versionPresent");
    });

    it("returns the keys it wrote, so a chunk that skipped a row names it as a stale claim", () => {
        const code = generateUpsert(versioned);

        expect(code).toContain("const keyName = (row: CustomerUpsert): string => String(row.id);");
        expect(code).toContain('            const writtenKeys = new Set(written.map((row) => String(row["id"])));');
        expect(code).toContain("                const missed = chunk.filter((row) => !writtenKeys.has(keyName(row)));");
        expect(code).toContain(
            "throw Object.assign(new Error('no row of customer is at the version this upsert claims for ' + named.map(keyName).join(\", \")), { code: \"40001\" });",
        );
        // The rows the predicate matched come back as the call's keys.
        expect(code).toContain("            keys.push(...written.map(keyOf));");
    });

    it("replaces a conflicting row outright when the entity has no version", () => {
        const snapshot = generateUpsert(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("number"),
            ]),
        );

        expect(snapshot).not.toContain("versionValues");
        // Nothing to compare, so the target needs no alias and no predicate.
        expect(snapshot).not.toContain("as u");
        expect(snapshot).toContain('returning "invoice_sent"."id"');
        expect(snapshot).toContain("            const written = resultRows(result);");
        expect(snapshot).toContain("if (written.length !== chunk.length) {");
        expect(snapshot).toContain(
            "throw new Error('the upsert wrote ' + written.length + ' of the ' + chunk.length + ' invoice_sent rows this upsert supplied');",
        );
    });

    it("falls back to the column default for a field a row omits, so the replacement carries it too", () => {
        const code = generateUpsert(
            table("email", "Email", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("subject"),
                column("status", { default: "'pending'" }),
            ]),
        );

        expect(code).toContain("                statusPresent.push(row.status !== undefined);");
    });

    it("matches every column of a composite key, and conflicts on all of them", () => {
        const code = generateUpsert(translation);

        expect(code).toContain("                languageCodeValues.push(row.languageCode ?? null);");
    });

    it("sets the key to the stored one when the entity has no column to replace", () => {
        const code = generateUpsert(
            table("gate", "Gate", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("derived", { notNull: false, insertable: false }),
            ]),
        );

        expect(code).toContain("const PARAMETERS_PER_ROW = 1;");
    });

    it("reads an inlined optional field through optional chaining", () => {
        const code = generateUpsert(
            table("invoice_sent", "InvoiceSent", [
                column("id", { sqlType: "uuid", primaryKey: true }),
                column("customerName", { read: "customer?.name", notNull: false }),
            ]),
        );

        expect(code).toContain("                customerNameValues.push(row.customer?.name ?? null);");
    });

    it("leaves a non-insertable column out, since an upsert writes what a create writes", () => {
        const limited = table("limited", "Limited", [
            column("id", { sqlType: "uuid", primaryKey: true }),
            column("label"),
            column("derived", { insertable: false }),
        ]);
        const code = generateUpsert(limited);

        expect(code).toContain('\'insert into "limited" ("id", "label") select \' +');
        expect(code).not.toContain('"derived"');
    });

    it("takes no boundary for a versionless call one statement carries, since every row it matches is written", () => {
        expect(generateUpsert(customer)).toContain("    if (rows.length <= ROWS_PER_STATEMENT) {");
        expect(generateUpsert(customer)).toContain("    await db.transaction(write);");
    });

    it("opens a boundary for a longer versioned call, since a chunk writes the rows it matched before it rejects", () => {
        const code = generateUpsert(versioned);

        expect(code).toContain("    if (rows.length === 1) {");
        expect(code).toContain("        await write(db);");
        expect(code).toContain("    await db.transaction(write);");
    });

    it("takes the port helpers its own check uses, and no more", () => {
        expect(generateUpsert(customer)).toContain(
            'import { MAX_STATEMENT_PARAMETERS, resultRows, type SqlExecutor } from "../sql-executor.ts";',
        );
        expect(generateUpsert(versioned)).toContain(
            'import { MAX_STATEMENT_PARAMETERS, resultRows, type SqlExecutor } from "../sql-executor.ts";',
        );
    });

    it("sizes a chunk by the arrays a row binds, counting the version array", () => {
        expect(generateUpsert(customer)).toContain("const PARAMETERS_PER_ROW = 3;");
        expect(generateUpsert(versioned)).toContain("const PARAMETERS_PER_ROW = 3;");
    });
});

describe("generateDelete", () => {
    it("deletes by the primary key columns only", () => {
        const code = generateDelete(customer);

        expect(code).toContain("const values = [row.id];");
    });

    it("matches every column of a composite key on delete", () => {
        const code = generateDelete(translation);

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
                'export * from "./upsertCustomer.ts";',
                'export * from "./updateCustomer.ts";',
                'export * from "./deleteCustomer.ts";',
                'export * from "./createInvoiceRow.ts";',
                'export * from "./upsertInvoiceRow.ts";',
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
            "upsertCustomer.ts",
            "upsertInvoice.ts",
        ]);
    });

    it("emits only the operations a table declares, and lists them in the barrel", () => {
        const audit: Table = {
            ...table("audit_log", "AuditLog", [column("id", { sqlType: "uuid", primaryKey: true })]),
            repositoryOperations: ["create"],
        };

        const files = generateRepositories(new Map([["AuditLog", audit]]));

        expect([...files.keys()].sort()).toEqual(["createAuditLog.ts", "index.ts"]);
        expect(files.get("index.ts")).toContain('export * from "./createAuditLog.ts";');
        expect(files.get("index.ts")).not.toContain("upsertAuditLog");
        expect(files.get("index.ts")).not.toContain("updateAuditLog");
        expect(files.get("index.ts")).not.toContain("deleteAuditLog");
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

/** Enough columns that one statement carries only a few rows, so the chunk boundary is reachable here. */
const WIDE_COLUMNS = 200;

const wide = table("wide", "Wide", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    ...Array.from({ length: WIDE_COLUMNS - 1 }, (_, index) => column(`c${index}`)),
]);

const gate = table("gate", "Gate", [
    column("id", { sqlType: "uuid", primaryKey: true }),
    column("label"),
]);

/** A `before insert` trigger that drops the rows it names: Postgres skips such a row without raising. */
function skipTriggerSql(table: Table): string {
    const name = `${table.name}_skip`;
    return [
        `create function "${name}"() returns trigger as $$ begin`,
        `    if new."label" = 'skip' then`,
        "        return null;",
        "    end if;",
        "    return new;",
        "end; $$ language plpgsql;",
        `create trigger "${name}" before insert on "${table.name}" for each row execute function "${name}"();`,
    ].join("\n");
}

/** A row of the wide fixture, with every non-key column holding the given value. */
function wideRow(id: string, value: string): Record<string, string> {
    const row: Record<string, string> = { id };
    for (let index = 0; index < WIDE_COLUMNS - 1; index += 1) {
        row[`c${index}`] = value;
    }
    return row;
}

/** The id of wide row `index`: the last uuid group is twelve hex digits. */
function wideId(index: number): string {
    return `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

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
    let wides: GeneratedRepository;
    let gates: GeneratedRepository;
    let tickets: GeneratedRepository;

    beforeAll(async () => {
        driver = createPglite();
        db = createTransactionalDb(createPglitePool(driver));
        await driver.exec(fixtureDdl(owner));
        await driver.exec(fixtureDdl(widget));
        await driver.exec(fixtureDdl(translation));
        await driver.exec(fixtureDdl(marker));
        await driver.exec(fixtureDdl(wide));
        await driver.exec(fixtureDdl(gate));
        await driver.exec(fixtureDdl(ticket));
        await driver.exec(skipTriggerSql(gate));
        owners = loadRepository(owner);
        widgets = loadRepository(widget);
        translations = loadRepository(translation);
        markers = loadRepository(marker);
        wides = loadRepository(wide);
        gates = loadRepository(gate);
        tickets = loadRepository(ticket);
    });

    afterAll(async () => {
        await driver.close();
    });

    beforeEach(async () => {
        await db.query('delete from "widget"');
        await db.query('delete from "owner"');
        await db.query('delete from "translation"');
        await db.query('delete from "marker"');
        await db.query('delete from "wide"');
        await db.query('delete from "gate"');
        // A delete leaves the identity sequence where it stood, so restart it to keep the assigned keys predictable.
        await db.query('truncate "ticket" restart identity');
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

    it("upserts a row no statement has written yet, claiming the version it carries", async () => {
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "created", note: null, owner: null, version: 0n }]);

        const { rows } = await driver.query<{ name: string; version: bigint }>(
            'select "name", "version" from "widget"',
        );

        expect(rows).toEqual([{ name: "created", version: 0n }]);
    });

    it("replaces the whole row it keys on when the claim matches, leaving the counter to the trigger", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "before", note: "carried", owner: { id: OWNER_ID } }]);

        // An upsert is a replacement, so a column the row states is overwritten whatever it held.
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "after", note: null, owner: null, version: 0n }]);

        const { rows } = await driver.query<{ name: string; note: string | null; ownerId: string | null; version: bigint }>(
            'select "name", "note", "ownerId", "version" from "widget"',
        );

        expect(rows).toEqual([{ name: "after", note: null, ownerId: null, version: 1n }]);
    });

    it("writes a null through the generated upsert, clearing a nullable column", async () => {
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "run", note: "keep", owner: null, version: 0n }]);
        // An upsert writes the whole row, so `null` reaches the statement as a value like any other.
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "run", note: null, owner: null, version: 0n }]);

        const { rows } = await driver.query<{ note: string | null }>('select "note" from "widget"');

        expect(rows).toEqual([{ note: null }]);
    });

    it("rejects an upsert whose claim the stored row has moved past, leaving the row as it was", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: null, owner: null }]);
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "first", note: null, owner: null, version: 0n }]);

        await expect(
            widgets.upsert(db, [{ id: WIDGET_ID, name: "second", note: null, owner: null, version: 0n }]),
        ).rejects.toMatchObject({
            code: "40001",
            message: `no row of widget is at the version this upsert claims for ${WIDGET_ID}`,
        });

        const { rows } = await driver.query<{ name: string; version: bigint }>(
            'select "name", "version" from "widget"',
        );

        expect(rows).toEqual([{ name: "first", version: 1n }]);
    });

    it("rolls a call back when one row of several is a stale claim", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "run", note: null, owner: null }]);
        await widgets.upsert(db, [{ id: WIDGET_ID, name: "first", note: null, owner: null, version: 0n }]);

        await expect(
            widgets.upsert(db, [
                { id: WIDGET_ID_OTHER, name: "created", note: null, owner: null, version: 0n },
                { id: WIDGET_ID, name: "second", note: null, owner: null, version: 0n },
            ]),
        ).rejects.toThrow(`no row of widget is at the version this upsert claims for ${WIDGET_ID}`);

        const { rows } = await driver.query<{ id: string; name: string }>(
            'select "id", "name" from "widget" order by "id"',
        );

        // The row the statement did write is rolled back with the row it skipped.
        expect(rows).toEqual([{ id: WIDGET_ID, name: "first" }]);
    });

    it("replaces a row outright when the entity carries no version, naming no claim", async () => {
        await translations.upsert(db, [{ languageCode: "en", key: "greeting", value: "hi" }]);
        await translations.upsert(db, [{ languageCode: "en", key: "greeting", value: "hello" }]);

        const { rows } = await driver.query<{ value: string }>('select "value" from "translation"');

        expect(rows).toEqual([{ value: "hello" }]);
    });

    it("carries a replacement too large for one statement in a further statement", async () => {
        const rows = Array.from({ length: 400 }, (_, index) => wideRow(wideId(index), "before"));
        expect(rows.length).toBeGreaterThan(Math.floor(sqlExecutor.MAX_STATEMENT_PARAMETERS / WIDE_COLUMNS));
        await wides.create(db, rows);

        await wides.upsert(db, rows.map((row) => ({ ...row, c0: "after" })));

        const { rows: stored } = await driver.query<{ count: number }>(
            'select count(*)::int as count from "wide" where "c0" = $1',
            ["after"],
        );
        expect(stored).toEqual([{ count: 400 }]);
    });

    it("reports a versionless upsert the database would not write every row of", async () => {
        // The `gate` fixture drops a row it is handed, which no statement can write. One statement
        // carries this call, so the rows it did write stand: the create behaves the same way.
        await expect(
            gates.upsert(db, [
                { id: WIDGET_ID, label: "kept" },
                { id: WIDGET_ID_OTHER, label: "skip" },
            ]),
        ).rejects.toThrow("the upsert wrote 1 of the 2 gate rows this upsert supplied");

        const { rows } = await driver.query<{ id: string }>('select "id" from "gate"');
        expect(rows).toEqual([{ id: WIDGET_ID }]);
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

    it("patches a call too large for one statement, carrying the rest in a further statement", async () => {
        const rows = Array.from({ length: 400 }, (_, index) => wideRow(wideId(index), "before"));
        // The premise: this many rows of this many columns cannot travel in a single statement.
        expect(rows.length).toBeGreaterThan(Math.floor(sqlExecutor.MAX_STATEMENT_PARAMETERS / (1 + 2 * (WIDE_COLUMNS - 1))));
        await wides.create(db, rows);

        await wides.update(db, rows.map((row) => ({ id: row.id, c0: "after" })));

        const { rows: stored } = await driver.query<{ count: number }>(
            'select count(*)::int as count from "wide" where "c0" = $1',
            ["after"],
        );
        expect(stored).toEqual([{ count: 400 }]);
    });

    it("rolls a chunked patch back when a later statement finds no row of its chunk", async () => {
        const rows = Array.from({ length: 200 }, (_, index) => wideRow(wideId(index), "before"));
        await wides.create(db, rows);
        const patches = [
            ...rows.map((row) => ({ id: row.id, c0: "after" })),
            // The last chunk also names an id no row carries, and the chunks before it have written.
            { id: wideId(999), c0: "after" },
        ];

        await expect(wides.update(db, patches)).rejects.toThrow(
            `no row of wide matches this patch: ${wideId(999)}`,
        );

        const { rows: stored } = await driver.query<{ count: number }>(
            'select count(*)::int as count from "wide" where "c0" = $1',
            ["after"],
        );
        expect(stored).toEqual([{ count: 0 }]);
    });

    it("deletes rows through the generated delete function", async () => {
        await widgets.create(db, [{ id: WIDGET_ID, name: "gone", note: null, owner: { id: OWNER_ID } }]);

        await widgets.delete(db, [{ id: WIDGET_ID }]);

        const { rows } = await driver.query('select "id" from "widget"');

        expect(rows).toEqual([]);
    });

    it("treats an empty array as a no-op", async () => {
        await expect(widgets.create(db, [])).resolves.toEqual([]);
        await expect(widgets.upsert(db, [])).resolves.toEqual([]);
        await expect(widgets.update(db, [])).resolves.toBeUndefined();
        await expect(widgets.delete(db, [])).resolves.toBeUndefined();
    });

    it("answers each create and upsert with the keys it wrote, in the order it carried the rows", async () => {
        const created = await widgets.create(db, [
            { id: WIDGET_ID, name: "first", note: null, owner: null },
            { id: WIDGET_ID_OTHER, name: "second", note: null, owner: null },
        ]);

        expect(created).toEqual([{ id: WIDGET_ID }, { id: WIDGET_ID_OTHER }]);

        const upserted = await widgets.upsert(db, [
            { id: WIDGET_ID, name: "first", note: null, owner: null, version: 0n },
            { id: WIDGET_ID_OTHER, name: "second", note: null, owner: null, version: 0n },
        ]);

        expect(upserted).toEqual([{ id: WIDGET_ID }, { id: WIDGET_ID_OTHER }]);
    });

    it("answers a create with the key the database assigned, and writes rows at those keys", async () => {
        const keys = await tickets.create(db, [{ label: "first" }, { label: "second" }]);

        expect(keys).toEqual([{ id: 1 }, { id: 2 }]);

        const { rows } = await driver.query<{ id: number; label: string }>(
            'select "id", "label" from "ticket" order by "id"',
        );
        expect(rows).toEqual([
            { id: 1, label: "first" },
            { id: 2, label: "second" },
        ]);
    });

    it("keeps the assigned key usable: a patch and a delete address the row the create made", async () => {
        const [created] = (await tickets.create(db, [{ label: "before" }])) as Array<{ id: number }>;

        await tickets.update(db, [{ id: created?.id, label: "after" }]);
        const patched = await driver.query<{ label: string }>('select "label" from "ticket"');

        expect(patched.rows).toEqual([{ label: "after" }]);

        await tickets.delete(db, [{ id: created?.id }]);
        const remaining = await driver.query('select "id" from "ticket"');

        expect(remaining.rows).toEqual([]);
    });

    it("replaces the row an upsert claims, rather than inserting a second one at a fresh key", async () => {
        const [created] = (await tickets.create(db, [{ label: "before" }])) as Array<{ id: number }>;

        // The key came from the create, which is the only thing that makes an upsert of it idempotent.
        const keys = await tickets.upsert(db, [{ id: created?.id as number, label: "after" }]);

        expect(keys).toEqual([{ id: 1 }]);
        const { rows } = await driver.query<{ id: number; label: string }>(
            'select "id", "label" from "ticket"',
        );
        expect(rows).toEqual([{ id: 1, label: "after" }]);
    });

    it("inserts at a key the sequence has not reached, which is what a claim on a free key means", async () => {
        const keys = await tickets.upsert(db, [{ id: 7, label: "claimed" }]);

        expect(keys).toEqual([{ id: 7 }]);
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

    it("inserts a call too large for one statement, carrying the rest in a further statement", async () => {
        const rows = Array.from({ length: 400 }, (_, index) => wideRow(wideId(index), `v${index}`));
        // The premise: this many rows of this many columns cannot travel in a single statement.
        expect(rows.length).toBeGreaterThan(Math.floor(sqlExecutor.MAX_STATEMENT_PARAMETERS / WIDE_COLUMNS));

        await wides.create(db, rows);

        const { rows: stored } = await driver.query<{ count: number }>('select count(*)::int as count from "wide"');
        expect(stored).toEqual([{ count: 400 }]);
    });

    it("rolls a chunked create back when a later statement fails, leaving no row behind", async () => {
        const rows = [
            ...Array.from({ length: 399 }, (_, index) => wideRow(wideId(index), `v${index}`)),
            // The last row repeats an id the first statement already wrote.
            wideRow(wideId(0), "duplicate"),
        ];

        await expect(wides.create(db, rows)).rejects.toThrow();

        const { rows: stored } = await driver.query<{ count: number }>('select count(*)::int as count from "wide"');
        expect(stored).toEqual([{ count: 0 }]);
    });

    it("rejects a create whose statement wrote fewer rows than it carried", async () => {
        const rows = [
            { id: "00000000-0000-0000-0000-0000000000f1", label: "keep" },
            { id: "00000000-0000-0000-0000-0000000000f2", label: "skip" },
        ];

        // The database drops the second row without raising, so only the count gives the loss away.
        await expect(gates.create(db, rows)).rejects.toThrow(
            "the insert wrote 1 of the 2 gate rows this create supplied",
        );
    });
});
