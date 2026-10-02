/**
 * Map the parsed spec to the Postgres table model shared by the generators.
 * The parsing lives in `spec/scripts/spec-model.ts`; this file adds the SQL mapping.
 * See docs/schema-generation.md.
 */
import { dirname, join } from "node:path";
import { Node, SyntaxKind, type Project } from "ts-morph";
import {
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    isCompareOperator,
    isInsertable,
    isUpdatable,
    omittedFromInsert,
    omittedFromPatch,
    parseSpec,
    type CompareOperator,
    type Diagnostic,
    type OrderDirection,
    type SpecProperty,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

/** This package's root, so paths do not depend on the current working directory. */
export const BACKEND_PACKAGE_ROOT = dirname(import.meta.dirname);

export { DEFAULT_SPEC_GLOB, SPEC_GLOB };

export const DEFAULT_FORMULAS_FILE = join(BACKEND_PACKAGE_ROOT, "src/postgres/formulas.ts");

/** Input paths, overridable so tests can generate from fixtures. */
export interface GenerateOptions {
    /** Where the entities are read from. */
    specGlob?: string;
    /** Where type aliases (including primitives) are read from; defaults to every spec file. */
    aliasGlob?: string;
    formulasFile?: string;
}

/** TypeScript primitives to Postgres types. Names match pg-unified-mapping, not the canonical aliases. */
const PRIMITIVE_TYPES: Record<string, string> = {
    string: "text",
    number: "float8",
    boolean: "boolean",
    bigint: "int8",
};

/** TypeScript built-ins that are not spec aliases; keywords are handled by PRIMITIVE_TYPES. */
const BUILTIN_TYPES: Record<string, string> = {
    Date: "timestamptz",
};

/** One formula fragment, whatever registry it came from. See docs/spec-annotations.md. */
export interface FormulaEntry {
    /** An expression the generator wraps as `NEW."field" := <expr>;`. */
    expression?: string;
    /** A complete `NEW."field" := …;` statement, emitted verbatim. */
    sameRow?: string;
    childNew?: string;
    childOld?: string;
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
    /** The field may be an equality filter of its entity's generated `query` read. See docs/queries.md. */
    queryFilter?: boolean;
    /** The field is an ordering key; `default` makes it the entity's default ordering. See docs/queries.md. */
    queryOrder?: { default?: OrderDirection };
    /** The comparison operators the field may be compared with. See docs/queries.md. */
    where?: CompareOperator[];
    /** False when a create never writes the column: `@default`, or a stored computation it can derive. */
    insertable: boolean;
    /** False when a patch never writes the column: a branch, a default, or a nullable computation. */
    updatable: boolean;
    read?: string;
}

/** A branch field: a `@relation`, a `@children`, or an `@inlined` entity. See docs/queries.md. */
export interface Relation {
    kind: "relation" | "children" | "inlined";
    /** The target table, for `relation` and `children`. */
    table?: string;
    /** `relation`: this table's foreign-key column. `children`: the child's foreign-key column. */
    column?: string;
    /** `inlined`: target field -> this table's prefixed column. */
    columns?: Record<string, string>;
}

export interface Table {
    name: string;
    interfaceName: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    columns: Column[];
    /** Branch fields, keyed by the interface field name. See docs/queries.md. */
    relations: Map<string, Relation>;
    /** `NEW."x" := <expr>;` assignments, in interface field order. */
    sameRowAssignments: string[];
    /** Child-change statements keyed by the child table that carries them. */
    rollups: Map<string, { newStatements: string[]; oldStatements: string[] }>;
    /** The fields a create omits, in spec order; absent means the create omits nothing. */
    insertOmit?: string[];
    /** The fields a patch omits, in spec order; the patch type and the wire schema both read this. */
    patchOmit?: string[];
}

interface TypeResolution {
    sqlType?: string;
    checkValues?: string[];
    entity?: string;
    isArray?: boolean;
}

/** Quote an identifier, matching the fragments in formulas.ts. */
export function quote(name: string): string {
    return `"${name}"`;
}

/** Read a string or template literal's text. */
function readStringValue(node: Node): string | undefined {
    if (Node.isNoSubstitutionTemplateLiteral(node) || Node.isStringLiteral(node)) {
        return node.getLiteralText();
    }
    return undefined;
}

/** Read every registry exported by `formulas.ts`, keyed by formula name, without importing it. */
export function readFormulas(project: Project, formulasFile = DEFAULT_FORMULAS_FILE): Map<string, FormulaEntry> {
    const formulas = new Map<string, FormulaEntry>();
    const sourceFile = project.getSourceFile(formulasFile);
    if (!sourceFile) {
        return formulas;
    }

    // Every registry is a top-level object literal, regardless of the name it is bound to.
    for (const declaration of sourceFile.getVariableDeclarations()) {
        const initializer = declaration.getInitializer();
        if (!initializer) {
            continue;
        }
        // A registry is `as const` or annotated, so the literal may sit behind an AsExpression.
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
            const key = unquote(property.getName());
            const value = property.getInitializer();
            // A string value is a same-row expression; an object value carries named statements.
            const text = value ? readStringValue(value) : undefined;
            if (text !== undefined) {
                formulas.set(key, { expression: text });
                continue;
            }
            const nested = value?.asKind(SyntaxKind.ObjectLiteralExpression);
            if (!nested) {
                continue;
            }
            const entry: FormulaEntry = {};
            for (const inner of nested.getProperties()) {
                if (!Node.isPropertyAssignment(inner)) {
                    continue;
                }
                const innerKey = unquote(inner.getName());
                const innerValue = inner.getInitializer();
                const innerText = innerValue ? readStringValue(innerValue) : undefined;
                if (innerText === undefined) {
                    continue;
                }
                if (innerKey === "sameRow" || innerKey === "childNew" || innerKey === "childOld") {
                    entry[innerKey] = innerText;
                }
            }
            formulas.set(key, entry);
        }
    }

    return formulas;
}

/** Strip the quotes ts-morph keeps on a string-literal property name. */
function unquote(name: string): string {
    return name.replace(/^["']|["']$/g, "");
}

function stripSemicolon(text: string): string {
    return text.trim().replace(/;$/, "");
}

/** customer + id -> customerId. Inlined columns are prefixed by the field name. */
function inlinedColumnName(fieldName: string, targetField: string): string {
    return fieldName + targetField.charAt(0).toUpperCase() + targetField.slice(1);
}

/** Build the table model shared by the schema and repository generators. */
export function buildSpecTables(
    project: Project,
    options: GenerateOptions = {},
): { tables: Map<string, Table>; diagnostics: Diagnostic[] } {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const formulasFile = options.formulasFile ?? DEFAULT_FORMULAS_FILE;
    const diagnostics: Diagnostic[] = [];
    const formulas = readFormulas(project, formulasFile);
    const { interfaces, aliases } = parseSpec(project, { entityGlob: specGlob, aliasGlob });
    const tables = new Map<string, Table>();

    const relative = (filePath: string) => filePath.replace(`${process.cwd()}/`, "");
    const report = (node: Node, message: string) => {
        const sourceFile = node.getSourceFile();
        diagnostics.push({
            filePath: relative(sourceFile.getFilePath()),
            line: node.getStartLineNumber(),
            message,
        });
    };

    /** Report a problem with a branch field, pointing at the field's declaration when it can be found. */
    const reportField = (table: Table, fieldName: string, message: string) => {
        const spec = interfaces.get(table.interfaceName);
        const property = spec?.properties.find((candidate) => candidate.name === fieldName);
        if (property) {
            report(property.declaration, `\`${fieldName}\`: ${message}`);
        } else if (spec) {
            report(spec.declaration, `\`${fieldName}\`: ${message}`);
        }
    };

    /** The SQL type of an entity's primary key, read from its own `id` field rather than assumed. */
    const pkTypeInProgress = new Set<string>();
    function primaryKeySqlType(entity: string): string {
        const id = interfaces.get(entity)?.properties.find((property) => property.name === "id");
        const typeNode = id?.declaration.getTypeNode();
        // A self-referential `<Entity>Id` alias that is not declared would otherwise recurse forever.
        if (!typeNode || pkTypeInProgress.has(entity)) {
            return "text";
        }
        pkTypeInProgress.add(entity);
        try {
            return resolveTypeNode(typeNode)?.sqlType ?? "text";
        } finally {
            pkTypeInProgress.delete(entity);
        }
    }

    /** Resolve a named alias to its type, reading its `@pgtype` before its underlying type. */
    function resolveNamedType(name: string): TypeResolution | undefined {
        const builtin = BUILTIN_TYPES[name];
        if (builtin) {
            return { sqlType: builtin };
        }
        const alias = aliases.get(name);
        // A primitive declares its storage type; that wins over resolving through its base type.
        if (alias?.tags.pgtype) {
            return { sqlType: alias.tags.pgtype };
        }
        if (interfaces.has(name)) {
            return { entity: name };
        }
        const aliasType = alias?.declaration.getTypeNode();
        if (aliasType) {
            return resolveTypeNode(aliasType);
        }
        // InvoiceId, CustomerId: an identifier named after the entity it keys, typed as that key.
        if (name.endsWith("Id")) {
            const entity = name.slice(0, -2);
            if (interfaces.has(entity)) {
                return { sqlType: primaryKeySqlType(entity) };
            }
        }
        return undefined;
    }

    function resolveTypeNode(node: Node): TypeResolution | undefined {
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
        return interfaces.get(entity)?.tableName;
    }

    /** Expand an `@inlined` entity field into prefixed scalar columns on the parent table. */
    function inlineColumns(
        property: SpecProperty,
        fieldName: string,
        entity: string,
        notNull: boolean,
        table: Table,
    ): void {
        const declaration = interfaces.get(entity);
        if (!declaration) {
            report(property.declaration, `\`${fieldName}\`: @inlined ${entity} has no interface`);
            return;
        }
        const columns: Record<string, string> = {};
        for (const inner of declaration.properties) {
            const innerName = inner.name;
            const innerType = inner.declaration.getTypeNode();
            if (!innerType) {
                report(inner.declaration, `\`${entity}.${innerName}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(innerType);
            if (!resolved) {
                report(inner.declaration, `\`${entity}.${innerName}\`: unsupported type \`${innerType.getText()}\``);
                continue;
            }
            if (resolved.isArray || resolved.entity) {
                report(inner.declaration, `\`${entity}.${innerName}\`: @inlined only inlines scalar fields`);
                continue;
            }
            const columnName = inlinedColumnName(fieldName, innerName);
            const column: Column = {
                name: columnName,
                sqlType: resolved.sqlType ?? "text",
                notNull: notNull && !inner.optional,
                primaryKey: false,
                unique: false,
                insertable: isInsertable(property),
                updatable: isUpdatable(property),
                read: notNull ? `${fieldName}.${innerName}` : `${fieldName}?.${innerName}`,
            };
            if (resolved.checkValues) {
                column.checkValues = resolved.checkValues;
            }
            columns[innerName] = columnName;
            table.columns.push(column);
        }
        table.relations.set(fieldName, { kind: "inlined", table: declaration.tableName, columns });
    }

    for (const spec of interfaces.values()) {
        const table: Table = {
            name: spec.tableName,
            interfaceName: spec.name,
            importSpecifier: spec.importSpecifier,
            columns: [],
            relations: new Map(),
            sameRowAssignments: [],
            rollups: new Map(),
            insertOmit: omittedFromInsert(spec).map((property) => property.name),
            patchOmit: omittedFromPatch(spec).map((property) => property.name),
        };

        for (const property of spec.properties) {
            const fieldName = property.name;
            const typeNode = property.declaration.getTypeNode();
            const notNull = !property.optional;
            const tags = property.tags;

            if (!typeNode) {
                report(property.declaration, `\`${fieldName}\`: cannot resolve a type node`);
                continue;
            }

            const resolved = resolveTypeNode(typeNode);
            if (!resolved) {
                report(property.declaration, `\`${fieldName}\`: unsupported type \`${typeNode.getText()}\``);
                continue;
            }

            // A branch tag carries no entity of its own, so the type must supply one.
            const branchName = tags.relation
                ? "relation"
                : tags.children
                    ? "children"
                    : tags.inlined
                        ? "inlined"
                        : undefined;
            if (branchName && !resolved.entity) {
                report(
                    property.declaration,
                    `\`${fieldName}\`: @${branchName} needs an entity type, found \`${typeNode.getText()}\``,
                );
                continue;
            }

            if (resolved.isArray) {
                if (!tags.children) {
                    report(
                        property.declaration,
                        `\`${fieldName}\`: array fields need @children and are not columns`,
                    );
                    continue;
                }
                const childTable = resolved.entity ? entityTableName(resolved.entity) : undefined;
                if (!childTable) {
                    report(
                        property.declaration,
                        `\`${fieldName}\`: @children needs an array of an entity, found \`${typeNode.getText()}\``,
                    );
                    continue;
                }
                // The child's foreign-key column is resolved once every table is built.
                table.relations.set(fieldName, { kind: "children", table: childTable });
                continue;
            }

            if (resolved.entity) {
                if (tags.inlined) {
                    inlineColumns(property, fieldName, resolved.entity, notNull, table);
                    continue;
                }
                if (!tags.relation) {
                    report(
                        property.declaration,
                        `\`${fieldName}\`: \`${resolved.entity}\` is an entity; add @relation`,
                    );
                    continue;
                }
                const targetTable = entityTableName(resolved.entity);
                if (!targetTable) {
                    report(property.declaration, `\`${fieldName}\`: @relation has no interface for \`${resolved.entity}\``);
                    continue;
                }
                // @relation navigates through the `<field>Id` field the interface declares; it adds no
                // column of its own. The pair is joined once every table's columns exist.
                table.relations.set(fieldName, { kind: "relation", table: targetTable });
                continue;
            }

            const isPrimaryKey = fieldName === "id";
            const isForeignKey = !isPrimaryKey && (typeNode.getText().endsWith("Id") ?? false);
            // A default makes the column not null even when the field is optional: the database fills it.
            const defaultValue = tags.default;
            const column: Column = {
                name: fieldName,
                sqlType: resolved.sqlType ?? "text",
                notNull: notNull || isPrimaryKey || defaultValue !== undefined,
                primaryKey: isPrimaryKey,
                unique: tags.unique,
                queryFilter: tags.queryfilter,
                insertable: isInsertable(property),
                updatable: isUpdatable(property),
                read: fieldName,
            };
            if (tags.queryOrderBy !== undefined) {
                column.queryOrder = tags.queryOrderBy;
            }
            // Only known operators reach the model; the linter reports an unknown one, and a
            // generator run without lint should not emit a comparison it cannot build.
            const operators = tags.where?.filter(isCompareOperator);
            if (operators && operators.length > 0) {
                column.where = operators;
            }
            if (resolved.checkValues) {
                column.checkValues = resolved.checkValues;
            }
            if (defaultValue !== undefined) {
                column.default = defaultValue;
            }
            if (tags.version) {
                column.version = true;
            }

            if (isForeignKey) {
                const entity = typeNode.getText().slice(0, -2);
                const targetTable = entityTableName(entity);
                if (!targetTable) {
                    report(property.declaration, `\`${fieldName}\`: no interface for foreign key entity \`${entity}\``);
                    continue;
                }
                // The key column takes the referenced entity's key type, not a fixed one.
                column.sqlType = primaryKeySqlType(entity);
                column.references = { table: targetTable, column: "id" };
            }

            table.columns.push(column);

            const formula = tags.computed?.formula;
            if (!formula) {
                continue;
            }
            const entry = formulas.get(formula);
            // A string fragment is an expression to wrap; a `sameRow` fragment is a whole statement.
            if (entry?.expression !== undefined) {
                table.sameRowAssignments.push(`NEW.${quote(fieldName)} := ${stripSemicolon(entry.expression)};`);
            } else if (entry?.sameRow !== undefined) {
                table.sameRowAssignments.push(stripSemicolon(entry.sameRow) + ";");
            }
        }

        if (!table.columns.some((column) => column.primaryKey)) {
            report(spec.declaration, `\`${spec.name}\`: no \`id\` field to use as primary key`);
        }

        tables.set(spec.name, table);
    }

    /** Attach each cross-table aggregate to the child table that changes it. */
    for (const spec of interfaces.values()) {
        const parentTable = tables.get(spec.name);
        if (!parentTable) {
            continue;
        }
        for (const property of spec.properties) {
            const formula = property.tags.computed?.formula;
            if (!formula) {
                continue;
            }
            const entry = formulas.get(formula);
            if (!entry?.childNew || !entry.childOld) {
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
                rollup.newStatements.push(entry.childNew);
                rollup.oldStatements.push(entry.childOld);
                parentTable.rollups.set(child.name, rollup);
            }
        }
    }

    /** Point each branch at a declaration that already exists: a relation at its `<field>Id` foreign
     * key, a child collection at the child's foreign key. */
    const byTableName = new Map<string, Table>();
    for (const table of tables.values()) {
        byTableName.set(table.name, table);
    }
    for (const table of tables.values()) {
        for (const [fieldName, relation] of table.relations) {
            if (!relation.table) {
                continue;
            }
            // @relation never adds a column: it requires a `<field>Id` field to navigate through.
            if (relation.kind === "relation") {
                const column = table.columns.find((candidate) => candidate.name === `${fieldName}Id`);
                if (!column) {
                    reportField(table, fieldName, `@relation needs the \`${fieldName}Id\` field`);
                    continue;
                }
                const referenced = column.references?.table;
                if (referenced !== relation.table) {
                    reportField(
                        table,
                        fieldName,
                        `@relation targets \`${relation.table}\`, but \`${fieldName}Id\` references \`${referenced ?? "nothing"}\``,
                    );
                    continue;
                }
                relation.column = column.name;
                continue;
            }
            if (relation.kind !== "children") {
                continue;
            }
            const child = byTableName.get(relation.table);
            const foreignKey = child?.columns.find((column) => column.references?.table === table.name);
            if (!foreignKey) {
                reportField(table, fieldName, `@children ${relation.table} has no foreign key to ${table.name}`);
                continue;
            }
            relation.column = foreignKey.name;
        }
    }

    return { tables, diagnostics };
}
