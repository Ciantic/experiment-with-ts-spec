/** Generate Postgres DDL from `spec/domain`. See docs/schema-generation.md. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Project } from "ts-morph";
import {
    BACKEND_PACKAGE_ROOT,
    DEFAULT_FORMULAS_FILE,
    DEFAULT_SPEC_GLOB,
    buildSpecTables,
    quote,
    type Diagnostic,
    type GenerateOptions,
    type Table,
} from "./spec-model.ts";

export type { Diagnostic } from "./spec-model.ts";

/** Where the DDL is written when no `--out` is given. */
const DEFAULT_OUT = join(BACKEND_PACKAGE_ROOT, "src/postgres/schema.sql");

/** Emit tables so that referenced tables come first. */
function orderTables(tables: Map<string, Table>, diagnostics: Diagnostic[], formulasFile: string): Table[] {
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
                filePath: formulasFile,
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

    const primaryKeys = table.columns.filter((column) => column.primaryKey).map((column) => quote(column.name));
    parts.push(`    constraint ${quote(`${table.name}_pkey`)} primary key (${primaryKeys.join(", ")})`);

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

function renderSameRowTrigger(table: Table): string[] {
    if (table.sameRowAssignments.length === 0) {
        return [];
    }
    const functionName = `${table.name}_compute`;
    const body = table.sameRowAssignments.map((line) => `    ${line}`).join("\n");
    return [
        `create function ${quote(functionName)}() returns trigger as $$`,
        "begin",
        body,
        "    return NEW;",
        "end;",
        "$$ language plpgsql;",
        "",
        `create trigger ${quote(functionName)} before insert or update on ${quote(table.name)}`,
        `    for each row execute function ${quote(functionName)}();`,
        "",
    ];
}

/** The before-update guard for a @version column: validate the caller's revision, then increment it. */
function renderVersionTrigger(table: Table): string[] {
    const version = table.columns.find((column) => column.version);
    if (!version) {
        return [];
    }
    const functionName = `${table.name}_version`;
    const key = table.columns.find((column) => column.primaryKey);
    // `is distinct from` is null-safe, so a caller that omits the version conflicts rather than passing.
    const target = key ? `OLD.${quote(key.name)}` : `NEW.${quote(version.name)}`;
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

function renderRollupTriggers(table: Table): string[] {
    const lines: string[] = [];
    for (const [childTable, rollup] of table.rollups) {
        const baseName = `${childTable}_rollup_${table.name}`;
        const setFunction = quote(`${baseName}_set`);
        const unsetFunction = quote(`${baseName}_unset`);
        lines.push(
            `create function ${setFunction}() returns trigger as $$`,
            "begin",
            ...rollup.newStatements.map((statement) => `    ${statement}`),
            "    return null;",
            "end;",
            "$$ language plpgsql;",
            "",
            `create trigger ${setFunction} after insert or update on ${quote(childTable)}`,
            `    for each row execute function ${setFunction}();`,
            "",
            `create function ${unsetFunction}() returns trigger as $$`,
            "begin",
            ...rollup.oldStatements.map((statement) => `    ${statement}`),
            "    return null;",
            "end;",
            "$$ language plpgsql;",
            "",
            `create trigger ${unsetFunction} after delete on ${quote(childTable)}`,
            `    for each row execute function ${unsetFunction}();`,
            "",
        );
    }
    return lines;
}

/** Render Postgres DDL from the spec. */
export function generateSchema(
    project: Project,
    options: GenerateOptions = {},
): { sql: string; diagnostics: Diagnostic[] } {
    const formulasFile = options.formulasFile ?? DEFAULT_FORMULAS_FILE;
    const { tables, diagnostics } = buildSpecTables(project, options);
    const ordered = orderTables(tables, diagnostics, formulasFile);

    const lines: string[] = [];
    lines.push("-- Generated by scripts/generate-postgres-schema.ts. Do not edit.");
    lines.push("");

    for (const table of ordered) {
        lines.push(...renderTable(table));
        lines.push("");
    }

    for (const table of ordered) {
        lines.push(...renderSameRowTrigger(table));
    }

    for (const table of ordered) {
        lines.push(...renderVersionTrigger(table));
    }

    for (const table of ordered) {
        lines.push(...renderRollupTriggers(table));
    }

    return { sql: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", diagnostics };
}

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    project.addSourceFilesAtPaths(DEFAULT_SPEC_GLOB);
    const { sql, diagnostics } = generateSchema(project, {
        specGlob: DEFAULT_SPEC_GLOB,
        formulasFile: DEFAULT_FORMULAS_FILE,
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
