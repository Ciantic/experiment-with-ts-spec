/** Generate Postgres DDL from `spec/domain`. See docs/schema-generation.md. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    Node,
    Project,
    SyntaxKind,
    type InterfaceDeclaration,
    type JSDoc,
    type PropertySignature,
    type TypeNode,
} from "ts-morph";

const DEFAULT_SPEC_GLOB = "spec/domain/**/*.ts";
const DEFAULT_FORMULAS_FILE = "spec/postgres/formulas.ts";

/** Input paths, overridable so tests can generate from fixtures. */
export interface GenerateOptions {
    specGlob?: string;
    formulasFile?: string;
}

/** TypeScript primitives to Postgres types. Names match pg-unified-mapping, not the canonical aliases. */
const PRIMITIVE_TYPES: Record<string, string> = {
    string: "text",
    number: "float8",
    boolean: "boolean",
    bigint: "int8",
};

/** Named types to Postgres types, checked before alias resolution. */
const NAMED_TYPES: Record<string, string> = {
    GUID: "uuid",
    Date: "timestamptz",
    Decimal: "decimal",
    Money: "decimal",
    Quantity: "decimal",
    TaxRate: "decimal",
    Email: "text",
    Unit: "text",
    Currency: "text",
    BrandedId: "uuid",
};

/** Entity-typed fields must carry this annotation to become a foreign key column. */
const RELATION_TAG = "relation";

/** Array-typed fields must carry this annotation to be skipped as a child collection. */
const CHILDREN_TAG = "children";

/** The formula registries, read statically from `formulas.ts`. */
interface FormulaRegistries {
    row: Record<string, string>;
    invoice: Record<string, { sameRow?: string; childNew?: string; childOld?: string }>;
}

/** Read a string or template literal's text. */
function readStringValue(node: Node): string | undefined {
    if (Node.isNoSubstitutionTemplateLiteral(node) || Node.isStringLiteral(node)) {
        return node.getLiteralText();
    }
    return undefined;
}

/** Read `formulas.ts` without importing it, so the script runs under plain node. */
export function readFormulas(project: Project, formulasFile = DEFAULT_FORMULAS_FILE): FormulaRegistries {
    const registries: FormulaRegistries = { row: {}, invoice: {} };
    const sourceFile = project.getSourceFile(formulasFile);
    if (!sourceFile) {
        return registries;
    }

    for (const declaration of sourceFile.getVariableDeclarations()) {
        const name = declaration.getName();
        if (name !== "rowFormulas" && name !== "invoiceFormulas") {
            continue;
        }
        const initializer = declaration.getInitializer();
        if (!initializer) {
            continue;
        }
        // The registries are `as const`, so the literal is an AsExpression.
        const literal = Node.isAsExpression(initializer)
            ? initializer.getExpressionIfKind(SyntaxKind.ObjectLiteralExpression)
            : initializer.asKind(SyntaxKind.ObjectLiteralExpression);
        if (!literal) {
            continue;
        }

        for (const property of literal.getProperties()) {
            if (!Node.isPropertyAssignment(property)) {
                continue;
            }
            const key = property.getName().replace(/^["']|["']$/g, "");
            const value = property.getInitializer();
            if (name === "rowFormulas") {
                const text = value ? readStringValue(value) : undefined;
                if (text !== undefined) {
                    registries.row[key] = text;
                }
                continue;
            }
            const nested = value?.asKind(SyntaxKind.ObjectLiteralExpression);
            if (!nested) {
                continue;
            }
            const entry: { sameRow?: string; childNew?: string; childOld?: string } = {};
            for (const inner of nested.getProperties()) {
                if (!Node.isPropertyAssignment(inner)) {
                    continue;
                }
                const innerKey = inner.getName().replace(/^["']|["']$/g, "");
                const innerValue = inner.getInitializer();
                const text = innerValue ? readStringValue(innerValue) : undefined;
                if (text === undefined) {
                    continue;
                }
                if (innerKey === "sameRow" || innerKey === "childNew" || innerKey === "childOld") {
                    entry[innerKey] = text;
                }
            }
            registries.invoice[key] = entry;
        }
    }

    return registries;
}

export interface Diagnostic {
    filePath: string;
    line: number;
    message: string;
}

interface Column {
    name: string;
    sqlType: string;
    notNull: boolean;
    primaryKey: boolean;
    unique: boolean;
    checkValues?: string[];
    references?: { table: string; column: string };
}

interface Table {
    name: string;
    interfaceName: string;
    columns: Column[];
    /** `NEW."x" := <expr>;` assignments, in interface field order. */
    sameRowAssignments: string[];
    /** Child-change statements keyed by the child table that carries them. */
    rollups: Map<string, { newStatements: string[]; oldStatements: string[] }>;
}

interface TypeResolution {
    sqlType?: string;
    checkValues?: string[];
    entity?: string;
    isArray?: boolean;
}

/** InvoiceRow -> invoice_row. */
function snakeCase(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function quote(name: string): string {
    return `"${name}"`;
}

/** Read a positional tag value such as `@relation Customer`. */
function tagValue(holder: { getJsDocs(): JSDoc[] }, name: string): string | undefined {
    for (const doc of holder.getJsDocs()) {
        for (const tag of doc.getTags()) {
            if (tag.getTagName() === name) {
                return (tag.getCommentText() ?? "").trim();
            }
        }
    }
    return undefined;
}

export function generateSchema(
    project: Project,
    options: GenerateOptions = {},
): { sql: string; diagnostics: Diagnostic[] } {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const formulasFile = options.formulasFile ?? DEFAULT_FORMULAS_FILE;
    const diagnostics: Diagnostic[] = [];
    const interfaces = new Map<string, InterfaceDeclaration>();
    const aliasCache = new Map<string, TypeNode | undefined>();
    const { row: rowRegistry, invoice: invoiceRegistry } = readFormulas(project, formulasFile);

    for (const sourceFile of project.getSourceFiles(specGlob)) {
        for (const declaration of sourceFile.getInterfaces()) {
            interfaces.set(declaration.getName(), declaration);
        }
    }

    const relative = (filePath: string) => filePath.replace(`${process.cwd()}/`, "");
    const report = (declaration: InterfaceDeclaration | PropertySignature, message: string) => {
        const sourceFile = declaration.getSourceFile();
        diagnostics.push({
            filePath: relative(sourceFile.getFilePath()),
            line: declaration.getStartLineNumber(),
            message,
        });
    };

    /** Resolve a named alias to its type node, so a branded type is seen as its base type. */
    function aliasTypeNode(name: string): TypeNode | undefined {
        if (aliasCache.has(name)) {
            return aliasCache.get(name);
        }
        let found: TypeNode | undefined;
        for (const sourceFile of project.getSourceFiles(specGlob)) {
            const alias = sourceFile.getTypeAlias(name);
            if (alias) {
                found = alias.getTypeNode();
                break;
            }
        }
        aliasCache.set(name, found);
        return found;
    }

    function resolveNamedType(name: string): TypeResolution | undefined {
        const known = NAMED_TYPES[name];
        if (known) {
            return { sqlType: known };
        }
        if (interfaces.has(name)) {
            return { entity: name };
        }
        const alias = aliasTypeNode(name);
        if (alias) {
            return resolveTypeNode(alias);
        }
        // InvoiceId, CustomerId: the brand name identifies the entity.
        if (name.endsWith("Id")) {
            return { sqlType: "uuid" };
        }
        return undefined;
    }

    function resolveTypeNode(node: TypeNode): TypeResolution | undefined {
        // string, number, boolean, bigint and friends.
        // `(string & {})` reaches here as a parenthesized type, so unwrap it first.
        const parenthesized = node.asKind(SyntaxKind.ParenthesizedType);
        if (parenthesized) {
            return resolveTypeNode(parenthesized.getTypeNode());
        }

        if (node.getKindName().endsWith("Keyword")) {
            const sqlType = PRIMITIVE_TYPES[node.getText()];
            return sqlType ? { sqlType } : undefined;
        }

        const array = node.asKind(SyntaxKind.ArrayType);
        if (array) {
            const element = resolveTypeNode(array.getElementTypeNode());
            const resolution: TypeResolution = { isArray: true };
            if (element?.entity) {
                resolution.entity = element.entity;
            }
            if (element?.sqlType) {
                resolution.sqlType = element.sqlType;
            }
            return resolution;
        }

        const reference = node.asKind(SyntaxKind.TypeReference);
        if (reference) {
            const name = reference.getTypeName().getText();
            return resolveNamedType(name);
        }

        // A lone literal is a closed set of one, not a union.
        const literal = node.asKind(SyntaxKind.LiteralType);
        if (literal) {
            const value = literal.getLiteral().asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
            return value === undefined ? undefined : { sqlType: "text", checkValues: [value] };
        }

        const union = node.asKind(SyntaxKind.UnionType);
        if (union) {
            const literals: string[] = [];
            let openString = false;
            for (const member of union.getTypeNodes()) {
                const literal = member.asKind(SyntaxKind.LiteralType);
                if (literal) {
                    const value = literal.getLiteral().asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
                    if (value !== undefined) {
                        literals.push(value);
                        continue;
                    }
                }
                const resolved = resolveTypeNode(member);
                if (resolved?.sqlType === "text") {
                    openString = true;
                    continue;
                }
                if (resolved?.sqlType) {
                    openString = true;
                }
            }
            // An open union (Unit, Currency) is plain text; a closed one is text with a CHECK.
            if (openString || literals.length === 0) {
                return { sqlType: "text" };
            }
            return { sqlType: "text", checkValues: literals };
        }

        const intersection = node.asKind(SyntaxKind.IntersectionType);
        if (intersection) {
            for (const member of intersection.getTypeNodes()) {
                const resolved = resolveTypeNode(member);
                if (resolved?.sqlType || resolved?.entity) {
                    return resolved;
                }
            }
            return undefined;
        }

        return undefined;
    }

    function entityTableName(entity: string): string | undefined {
        const declaration = interfaces.get(entity);
        if (!declaration) {
            return undefined;
        }
        return tagValue(declaration, "table") ?? snakeCase(entity);
    }

    const tables = new Map<string, Table>();

    for (const [interfaceName, declaration] of interfaces) {
        const tableName = tagValue(declaration, "table") ?? snakeCase(interfaceName);
        const table: Table = {
            name: tableName,
            interfaceName,
            columns: [],
            sameRowAssignments: [],
            rollups: new Map(),
        };

        for (const property of declaration.getProperties()) {
            const fieldName = property.getName();
            const typeNode = property.getTypeNode();
            const notNull = !property.hasQuestionToken();

            if (!typeNode) {
                report(property, `\`${fieldName}\`: cannot resolve a type node`);
                continue;
            }

            const resolved = resolveTypeNode(typeNode);
            if (!resolved) {
                report(property, `\`${fieldName}\`: unsupported type \`${typeNode.getText()}\``);
                continue;
            }

            if (resolved.isArray) {
                if (!tagValue(property, CHILDREN_TAG)) {
                    report(
                        property,
                        `\`${fieldName}\`: array fields need @${CHILDREN_TAG} <Entity> and are not columns`,
                    );
                }
                continue;
            }

            if (resolved.entity) {
                const relation = tagValue(property, RELATION_TAG);
                if (!relation) {
                    report(
                        property,
                        `\`${fieldName}\`: \`${resolved.entity}\` is an entity; add @${RELATION_TAG} ${resolved.entity}`,
                    );
                    continue;
                }
                const targetTable = entityTableName(relation);
                if (!targetTable) {
                    report(property, `\`${fieldName}\`: @${RELATION_TAG} ${relation} has no interface`);
                    continue;
                }
                table.columns.push({
                    name: `${fieldName}Id`,
                    sqlType: "uuid",
                    notNull,
                    primaryKey: false,
                    unique: false,
                    references: { table: targetTable, column: "id" },
                });
                continue;
            }

            const isPrimaryKey = fieldName === "id";
            const isForeignKey = !isPrimaryKey && (typeNode.getText().endsWith("Id") ?? false);
            const column: Column = {
                name: fieldName,
                sqlType: resolved.sqlType ?? "text",
                notNull: notNull || isPrimaryKey,
                primaryKey: isPrimaryKey,
                unique: tagValue(property, "unique") !== undefined,
            };
            if (resolved.checkValues) {
                column.checkValues = resolved.checkValues;
            }

            if (isForeignKey) {
                const entity = typeNode.getText().slice(0, -2);
                const targetTable = entityTableName(entity);
                if (!targetTable) {
                    report(property, `\`${fieldName}\`: no interface for foreign key entity \`${entity}\``);
                    continue;
                }
                column.references = { table: targetTable, column: "id" };
            }

            table.columns.push(column);

            const computed = tagValue(property, "computed");
            if (!computed) {
                continue;
            }
            const formula = /formula=(\S+)/.exec(computed)?.[1];
            if (!formula) {
                continue;
            }
            const rowExpression = rowRegistry[formula];
            if (rowExpression !== undefined) {
                table.sameRowAssignments.push(`NEW.${quote(fieldName)} := ${stripSemicolon(rowExpression)};`);
                continue;
            }
            const invoiceFormula = invoiceRegistry[formula];
            if (invoiceFormula?.sameRow) {
                table.sameRowAssignments.push(stripSemicolon(invoiceFormula.sameRow) + ";");
            }
        }

        if (!table.columns.some((column) => column.primaryKey)) {
            report(declaration, `\`${interfaceName}\`: no \`id\` field to use as primary key`);
        }

        tables.set(interfaceName, table);
    }

    /** Attach each cross-table aggregate to the child table that changes it. */
    for (const [interfaceName, declaration] of interfaces) {
        const parentTable = tables.get(interfaceName);
        if (!parentTable) {
            continue;
        }
        for (const property of declaration.getProperties()) {
            const computed = tagValue(property, "computed");
            const formula = computed ? /formula=(\S+)/.exec(computed)?.[1] : undefined;
            if (!formula) {
                continue;
            }
            const invoiceFormula = invoiceRegistry[formula];
            if (!invoiceFormula?.childNew || !invoiceFormula.childOld) {
                continue;
            }
            for (const child of tables.values()) {
                const hasForeignKey = child.columns.some(
                    (column) => column.references?.table === parentTable.name,
                );
                if (!hasForeignKey) {
                    continue;
                }
                const rollup = parentTable.rollups.get(child.name) ?? {
                    newStatements: [],
                    oldStatements: [],
                };
                rollup.newStatements.push(invoiceFormula.childNew);
                rollup.oldStatements.push(invoiceFormula.childOld);
                parentTable.rollups.set(child.name, rollup);
            }
        }
    }

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
        lines.push(...renderRollupTriggers(table));
    }

    return { sql: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", diagnostics };
}

function stripSemicolon(text: string): string {
    return text.trim().replace(/;$/, "");
}

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

/** Where the DDL is written when no `--out` is given. */
const DEFAULT_OUT = "postgres/schema.sql";

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    const { sql, diagnostics } = generateSchema(project);

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
