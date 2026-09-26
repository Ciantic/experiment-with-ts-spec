/** Read `spec/domain` into the table model shared by the backend generators. See docs/schema-generation.md. */
import { createRequire } from "node:module";
import { dirname, join, relative as relativePath } from "node:path";
import {
    Node,
    Project,
    SyntaxKind,
    type InterfaceDeclaration,
    type JSDoc,
    type PropertySignature,
    type TypeNode,
} from "ts-morph";

const require = createRequire(import.meta.url);

/** The `spec` package root, resolved through the workspace dependency. */
const SPEC_PACKAGE_ROOT = dirname(require.resolve("spec/package.json"));

/** The spec `src` directory; a source path under it maps back to its package export specifier. */
const SPEC_SRC_ROOT = join(SPEC_PACKAGE_ROOT, "src");

/** This package's root, so paths do not depend on the current working directory. */
export const BACKEND_PACKAGE_ROOT = dirname(import.meta.dirname);

export const DEFAULT_SPEC_GLOB = join(SPEC_PACKAGE_ROOT, "src/domain/**/*.ts");
export const DEFAULT_FORMULAS_FILE = join(BACKEND_PACKAGE_ROOT, "src/postgres/formulas.ts");

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
    Version: "int8",
};

/** Entity-typed fields must carry this annotation to become a foreign key column. */
const RELATION_TAG = "relation";

/** Array-typed fields must carry this annotation to be skipped as a child collection. */
const CHILDREN_TAG = "children";

/** Entity-typed fields may carry this to inline the target's scalar fields instead of emitting a foreign key. */
const INLINED_TAG = "inlined";

/** The formula registries, read statically from `formulas.ts`. */
interface FormulaRegistries {
    row: Record<string, string>;
    invoice: Record<string, { sameRow?: string; childNew?: string; childOld?: string }>;
    timestamp: Record<string, string>;
}

/** A problem found while reading the spec; the generators report these instead of producing output. */
export interface Diagnostic {
    filePath: string;
    line: number;
    message: string;
}

/** A column generated from a domain field. `read` is the accessor the repository generator emits. */
export interface Column {
    name: string;
    sqlType: string;
    notNull: boolean;
    primaryKey: boolean;
    unique: boolean;
    checkValues?: string[];
    references?: { table: string; column: string };
    /** A database column default, written verbatim; the repository does not write the column. */
    default?: string;
    /** An optimistic-lock column: omitted on insert, written on update as the precondition. See docs/versioning.md. */
    version?: boolean;
    read?: string;
}

export interface Table {
    name: string;
    interfaceName: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.js`. */
    importSpecifier: string;
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

/** customer + id -> customerId. Inlined columns are prefixed by the field name. */
function inlinedColumnName(fieldName: string, targetField: string): string {
    return fieldName + targetField.charAt(0).toUpperCase() + targetField.slice(1);
}

/** Quote an identifier, matching the fragments in formulas.ts. */
export function quote(name: string): string {
    return `"${name}"`;
}

/** The module specifier that imports a spec source file, honouring the package's exports map. */
export function specImportSpecifier(sourceFile: string): string {
    const relativeToSrc = relativePath(SPEC_SRC_ROOT, sourceFile).replace(/\.ts$/, ".js");
    return `spec/${relativeToSrc}`;
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
    const registries: FormulaRegistries = { row: {}, invoice: {}, timestamp: {} };
    const sourceFile = project.getSourceFile(formulasFile);
    if (!sourceFile) {
        return registries;
    }

    for (const declaration of sourceFile.getVariableDeclarations()) {
        const name = declaration.getName();
        if (name !== "rowFormulas" && name !== "invoiceFormulas" && name !== "timestampFormulas") {
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
            if (name === "rowFormulas" || name === "timestampFormulas") {
                const text = value ? readStringValue(value) : undefined;
                if (text !== undefined) {
                    (name === "rowFormulas" ? registries.row : registries.timestamp)[key] = text;
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

function stripSemicolon(text: string): string {
    return text.trim().replace(/;$/, "");
}

/** Build the table model shared by the schema and repository generators. */
export function buildSpecTables(
    project: Project,
    options: GenerateOptions = {},
): { tables: Map<string, Table>; diagnostics: Diagnostic[] } {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const formulasFile = options.formulasFile ?? DEFAULT_FORMULAS_FILE;
    const diagnostics: Diagnostic[] = [];
    const interfaces = new Map<string, InterfaceDeclaration>();
    const aliasCache = new Map<string, TypeNode | undefined>();
    const { row: rowRegistry, invoice: invoiceRegistry, timestamp: timestampRegistry } = readFormulas(
        project,
        formulasFile,
    );

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

    /** Expand an `@inlined` entity field into prefixed scalar columns on the parent table. */
    function inlineColumns(
        property: PropertySignature,
        fieldName: string,
        entity: string,
        notNull: boolean,
        table: Table,
    ): void {
        const declaration = interfaces.get(entity);
        if (!declaration) {
            report(property, `\`${fieldName}\`: @${INLINED_TAG} ${entity} has no interface`);
            return;
        }
        for (const inner of declaration.getProperties()) {
            const innerName = inner.getName();
            const innerType = inner.getTypeNode();
            if (!innerType) {
                report(inner, `\`${entity}.${innerName}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(innerType);
            if (!resolved) {
                report(inner, `\`${entity}.${innerName}\`: unsupported type \`${innerType.getText()}\``);
                continue;
            }
            if (resolved.isArray || resolved.entity) {
                report(inner, `\`${entity}.${innerName}\`: @${INLINED_TAG} only inlines scalar fields`);
                continue;
            }
            const column: Column = {
                name: inlinedColumnName(fieldName, innerName),
                sqlType: resolved.sqlType ?? "text",
                notNull: notNull && !inner.hasQuestionToken(),
                primaryKey: false,
                unique: false,
                read: notNull ? `${fieldName}.${innerName}` : `${fieldName}?.${innerName}`,
            };
            if (resolved.checkValues) {
                column.checkValues = resolved.checkValues;
            }
            table.columns.push(column);
        }
    }

    const tables = new Map<string, Table>();

    for (const [interfaceName, declaration] of interfaces) {
        const tableName = tagValue(declaration, "table") ?? snakeCase(interfaceName);
        const table: Table = {
            name: tableName,
            interfaceName,
            importSpecifier: specImportSpecifier(declaration.getSourceFile().getFilePath()),
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
                const inlined = tagValue(property, INLINED_TAG);
                if (inlined) {
                    inlineColumns(property, fieldName, inlined, notNull, table);
                    continue;
                }
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
                    read: notNull ? `${fieldName}.id` : `${fieldName}?.id`,
                });
                continue;
            }

            const isPrimaryKey = fieldName === "id";
            const isForeignKey = !isPrimaryKey && (typeNode.getText().endsWith("Id") ?? false);
            // A default makes the column not null even when the field is optional: the database fills it.
            const defaultValue = tagValue(property, "default");
            const column: Column = {
                name: fieldName,
                sqlType: resolved.sqlType ?? "text",
                notNull: notNull || isPrimaryKey || defaultValue !== undefined,
                primaryKey: isPrimaryKey,
                unique: tagValue(property, "unique") !== undefined,
                read: fieldName,
            };
            if (resolved.checkValues) {
                column.checkValues = resolved.checkValues;
            }
            if (defaultValue !== undefined) {
                column.default = defaultValue;
            }
            if (tagValue(property, "version") !== undefined) {
                column.version = true;
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
            const timestampExpression = timestampRegistry[formula];
            if (timestampExpression !== undefined) {
                table.sameRowAssignments.push(`NEW.${quote(fieldName)} := ${stripSemicolon(timestampExpression)};`);
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

    return { tables, diagnostics };
}
