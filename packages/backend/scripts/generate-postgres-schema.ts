/** Generate Postgres DDL from `spec/domain`. See docs/schema-generation.md. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Project } from "ts-morph";
import {
    BACKEND_PACKAGE_ROOT,
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    buildSpecTables,
    quote,
    type Column,
    type Diagnostic,
    type GenerateOptions,
    type Table,
    type Trigger,
} from "./postgres-model.ts";

export type { Diagnostic } from "./postgres-model.ts";

/** Where the DDL is written when no `--out` is given. */
const DEFAULT_OUT = join(BACKEND_PACKAGE_ROOT, "src/postgres/schema.sql");

/** Emit tables so that referenced tables come first. */
function orderTables(tables: Map<string, Table>, diagnostics: Diagnostic[], specGlob: string): Table[] {
    const remaining = [...tables.values()];
    const emitted = new Map<string, Table>();
    const ordered: Table[] = [];

    while (remaining.length > 0) {
        const ready = remaining.filter((table) =>
            table.columns.every(
                (column) => !column.references || emitted.has(column.references.table),
            ),
        );
        if (ready.length === 0) {
            diagnostics.push({
                filePath: specGlob,
                line: 1,
                message: `circular foreign keys among: ${remaining.map((table) => table.name).join(", ")}`,
            });
            ordered.push(...remaining);
            break;
        }
        for (const table of ready) {
            ordered.push(table);
            emitted.set(table.name, table);
            remaining.splice(remaining.indexOf(table), 1);
        }
    }

    return ordered;
}

function renderTable(table: Table): string[] {
    const lines: string[] = [`create table ${quote(table.name)} (`];
    const parts: string[] = [];

    for (const column of table.columns) {
        let part = `    ${quote(column.name)} ${column.sqlType}`;
        if (column.generatedExpression !== undefined) {
            part += ` generated always as (${column.generatedExpression}) virtual`;
        }
        if (column.notNull) {
            part += " not null";
        }
        if (column.default) {
            part += ` default ${column.default}`;
        }
        if (column.references) {
            part += ` references ${quote(column.references.table)}(${quote(column.references.column)})`;
        }
        if (column.unique) {
            part += " unique";
        }
        parts.push(part);
    }

    // A table with no key column is already a diagnostic; emitting `primary key ()` would be invalid DDL.
    const primaryKeys = table.columns.filter((column) => column.primaryKey).map((column) => quote(column.name));
    if (primaryKeys.length > 0) {
        parts.push(`    constraint ${quote(`${table.name}_pkey`)} primary key (${primaryKeys.join(", ")})`);
    }

    for (const column of table.columns) {
        if (!column.checkValues || column.checkValues.length === 0) {
            continue;
        }
        const values = column.checkValues.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
        parts.push(
            `    constraint ${quote(`${table.name}_${column.name}_check`)} check (${quote(column.name)} in (${values}))`,
        );
    }

    lines.push(parts.join(",\n"));
    lines.push(");");
    return lines;
}

/** The name of a trigger and its function; the shared row-level before insert or update shape keeps `_compute`. */
function triggerName(table: Table, trigger: Trigger): string {
    if (
        trigger.level === "row" &&
        trigger.timing === "before" &&
        trigger.events.length === 2 &&
        trigger.events[0] === "insert" &&
        trigger.events[1] === "update"
    ) {
        return `${table.name}_compute`;
    }
    const level = trigger.level === "statement" ? "_statement" : "";
    return `${table.name}_${trigger.timing}_${trigger.events.join("_")}${level}`;
}

/** The return each shape needs: a before row trigger must return the row, since null cancels its event. */
function triggerReturn(trigger: Trigger): string {
    // A statement-level return value is ignored, and a before row trigger on delete has no NEW to return.
    if (trigger.level === "statement" || trigger.timing === "after") {
        return "return null;";
    }
    return trigger.events.includes("delete") ? "return coalesce(NEW, OLD);" : "return NEW;";
}

function renderTriggers(table: Table): string[] {
    const lines: string[] = [];
    for (const trigger of table.triggers) {
        if (trigger.statements.length === 0) {
            continue;
        }
        const name = quote(triggerName(table, trigger));
        lines.push(
            `create function ${name}() returns trigger as $$`,
            "begin",
            ...trigger.statements.map((statement) => `    ${statement}`),
            `    ${triggerReturn(trigger)}`,
            "end;",
            "$$ language plpgsql;",
            "",
            `create trigger ${name} ${trigger.timing} ${trigger.events.join(" or ")} on ${quote(table.name)}`,
            `    for each ${trigger.level} execute function ${name}();`,
            "",
        );
    }
    return lines;
}

/** The before-update guard for a @version column: validate the caller's revision, then increment it. */
function renderVersionTrigger(table: Table): string[] {
    const version = table.columns.find((column) => column.version);
    if (!version) {
        return [];
    }
    const functionName = `${table.name}_version`;
    const keys = table.columns.filter((column) => column.primaryKey);
    // `is distinct from` is null-safe, so a caller that omits the version conflicts rather than passing.
    // The message names the row by its key; a composite key reads as one row value.
    const target =
        keys.length === 0
            ? `NEW.${quote(version.name)}`
            : keys.length === 1
                ? `OLD.${quote((keys[0] as Column).name)}`
                : `row(${keys.map((column) => `OLD.${quote(column.name)}`).join(", ")})`;
    return [
        `create function ${quote(functionName)}() returns trigger as $$`,
        "begin",
        `    if NEW.${quote(version.name)} is distinct from OLD.${quote(version.name)} then`,
        `        raise exception 'version conflict on ${table.name} %', ${target}`,
        "            using errcode = '40001';",
        "    end if;",
        `    NEW.${quote(version.name)} := OLD.${quote(version.name)} + 1;`,
        "    return NEW;",
        "end;",
        "$$ language plpgsql;",
        "",
        `create trigger ${quote(functionName)} before update on ${quote(table.name)}`,
        `    for each row execute function ${quote(functionName)}();`,
        "",
    ];
}

/** Render Postgres DDL from the spec. */
export function generateSchema(
    project: Project,
    options: GenerateOptions = {},
): { sql: string; diagnostics: Diagnostic[] } {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const { tables, diagnostics } = buildSpecTables(project, options);
    const ordered = orderTables(tables, diagnostics, specGlob);

    const lines: string[] = [];
    lines.push("-- Generated by scripts/generate-postgres-schema.ts. Do not edit.");
    lines.push("");

    for (const table of ordered) {
        lines.push(...renderTable(table));
        lines.push("");
    }

    for (const table of ordered) {
        lines.push(...renderTriggers(table));
    }

    for (const table of ordered) {
        lines.push(...renderVersionTrigger(table));
    }

    return { sql: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", diagnostics };
}

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    project.addSourceFilesAtPaths(SPEC_GLOB);
    const { sql, diagnostics } = generateSchema(project, {
        specGlob: DEFAULT_SPEC_GLOB,
        aliasGlob: SPEC_GLOB,
    });

    for (const diagnostic of diagnostics) {
        console.error(`${diagnostic.filePath}:${diagnostic.line}: ${diagnostic.message}`);
    }

    if (diagnostics.length > 0) {
        process.exitCode = 1;
        return;
    }

    if (process.argv.includes("--stdout")) {
        process.stdout.write(sql);
        return;
    }

    const outIndex = process.argv.indexOf("--out");
    const outPath = outIndex === -1 ? DEFAULT_OUT : process.argv[outIndex + 1];
    if (!outPath) {
        console.error("--out needs a path");
        process.exitCode = 1;
        return;
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, sql);
    console.log(`wrote ${outPath}`);
}

if (import.meta.main) {
    main();
}
