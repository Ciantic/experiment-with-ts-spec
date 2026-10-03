/**
 * Map the parsed spec to the Postgres table model shared by the generators.
 * The parsing lives in `spec/scripts/spec-model.ts`; this file adds the SQL mapping.
 * See docs/schema-generation.md.
 */
import { dirname } from "node:path";
import { Node, SyntaxKind, type Project } from "ts-morph";
import {
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    isCompareOperator,
    isInsertable,
    isUpdatable,
    parseSpec,
    type CompareOperator,
    type Diagnostic,
    type OrderDirection,
    type SpecInterface,
    type SpecProperty,
    type SpecTypeAlias,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

/** This package's root, so paths do not depend on the current working directory. */
export const BACKEND_PACKAGE_ROOT = dirname(import.meta.dirname);
export { DEFAULT_SPEC_GLOB, SPEC_GLOB };

/** Input paths, overridable so tests can generate from fixtures. */
export interface GenerateOptions {
    /** Where the entities are read from. */
    specGlob?: string;
    /** Where type aliases (including primitives) are read from; defaults to every spec file. */
    aliasGlob?: string;
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

/** A column generated from a domain field. `read` is the accessor the repository generator emits. */
export interface Column {
    name: string;
    sqlType: string;
    notNull: boolean;
    /** The column is part of the table's primary key; a composite key has several. */
    primaryKey: boolean;
    unique: boolean;
    checkValues?: string[];
    references?: { table: string; column: string };
    /** A database column default, written verbatim; the repository does not write the column. */
    default?: string;
    /** A virtual generated column's expression, written verbatim without `NEW.`; the database owns the value. */
    generatedExpression?: string;
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
}

interface TypeResolution {
    sqlType?: string;
    checkValues?: string[];
    entity?: string;
    isArray?: boolean;
}

/** The table's primary key columns, in declaration order. A missing `@primaryKey` is a diagnostic. */
export function primaryKeyColumns(table: Table): Column[] {
    const columns = table.columns.filter((candidate) => candidate.primaryKey);
    if (columns.length === 0) {
        throw new Error(`${table.interfaceName} has no @primaryKey column`);
    }
    return columns;
}

/** Quote an identifier, matching the tags in the spec. */
export function quote(name: string): string {
    return `"${name}"`;
}

function stripSemicolon(text: string): string {
    return text.trim().replace(/;$/, "");
}

/** customer + id -> customerId. Inlined columns are prefixed by the field name. */
function inlinedColumnName(fieldName: string, targetField: string): string {
    return fieldName + targetField.charAt(0).toUpperCase() + targetField.slice(1);
}

/** How a spec type node maps to Postgres storage. */
interface TypeResolver {
    resolveTypeNode(node: Node): TypeResolution | undefined;
    primaryKeyFields(entity: string): SpecProperty[];
    primaryKeySqlType(entity: string): string;
}

/** Where a build reports problems it finds in the spec. */
interface Reporter {
    report(node: Node, message: string): void;
    reportField(table: Table, fieldName: string, message: string): void;
}

/** Shared state and lookups for one model build. */
interface BuildContext extends TypeResolver, Reporter {
    interfaces: Map<string, SpecInterface>;
    diagnostics: Diagnostic[];
}

/** Build the table model shared by the schema and repository generators. */
export function buildSpecTables(
    project: Project,
    options: GenerateOptions = {},
): { tables: Map<string, Table>; diagnostics: Diagnostic[] } {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const { interfaces, aliases } = parseSpec(project, { entityGlob: specGlob, aliasGlob });
    const diagnostics: Diagnostic[] = [];
    const context: BuildContext = {
        interfaces,
        diagnostics,
        ...createTypeResolver(interfaces, aliases),
        ...createReporter(interfaces, diagnostics),
    };
    const tables = new Map<string, Table>();

    for (const spec of interfaces.values()) {
        tables.set(spec.name, buildTable(context, spec));
    }

    attachRollups(tables, interfaces);
    resolveBranchColumns(tables, context);

    return { tables, diagnostics };
}

/** Build one table: its columns, branch relations, and trigger assignments. */
function buildTable(context: BuildContext, spec: SpecInterface): Table {
    const table: Table = {
        name: spec.tableName,
        interfaceName: spec.name,
        importSpecifier: spec.importSpecifier,
        columns: [],
        relations: new Map(),
        sameRowAssignments: [],
        rollups: new Map(),
    };

    for (const property of spec.properties) {
        addProperty(context, table, property);
    }

    if (!table.columns.some((column) => column.primaryKey)) {
        context.report(spec.declaration, `\`${spec.name}\`: no \`@primaryKey\` field`);
    }
    return table;
}

/** Add the column or branch relation a field declares. */
function addProperty(context: BuildContext, table: Table, property: SpecProperty): void {
    const fieldName = property.name;
    const typeNode = property.declaration.getTypeNode();
    const tags = property.tags;

    if (!typeNode) {
        context.report(property.declaration, `\`${fieldName}\`: cannot resolve a type node`);
        return;
    }

    // A primary key column and a foreign key column are told apart by their tags, not their
    // names: `@primaryKey` is the table's key, `@foreignKey Customer` points at another table.
    const isPrimaryKey = tags.primaryKey;
    const foreignKeyTarget = isPrimaryKey ? undefined : tags.foreignKey;

    // A foreign key's storage type comes from the table it points at, so its own type node
    // is documentation and may be an alias this model cannot resolve.
    const foreignKeyTable = foreignKeyTarget ? entityTableName(context, foreignKeyTarget) : undefined;
    if (foreignKeyTarget && !foreignKeyTable) {
        context.report(
            property.declaration,
            `\`${fieldName}\`: @foreignKey has no interface for \`${foreignKeyTarget}\``,
        );
        return;
    }

    const resolved = context.resolveTypeNode(typeNode);
    if (!resolved && !foreignKeyTarget) {
        context.report(property.declaration, `\`${fieldName}\`: unsupported type \`${typeNode.getText()}\``);
        return;
    }

    if (addBranch(context, table, property, typeNode, resolved)) {
        return;
    }

    addScalarColumn(context, table, property, resolved, isPrimaryKey, foreignKeyTarget, foreignKeyTable);
}

/** Add the branch relation a branch tag declares; returns false for a plain column. */
function addBranch(
    context: BuildContext,
    table: Table,
    property: SpecProperty,
    typeNode: Node,
    resolved: TypeResolution | undefined,
): boolean {
    const fieldName = property.name;
    const tags = property.tags;

    // A branch tag carries no entity of its own, so the type must supply one.
    const branchName = tags.relation
        ? "relation"
        : tags.children
            ? "children"
            : tags.inlined
                ? "inlined"
                : undefined;
    if (branchName && !resolved?.entity) {
        context.report(
            property.declaration,
            `\`${fieldName}\`: @${branchName} needs an entity type, found \`${typeNode.getText()}\``,
        );
        return true;
    }

    if (resolved?.isArray) {
        if (!tags.children) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: array fields need @children and are not columns`,
            );
            return true;
        }
        const childTable = resolved.entity ? entityTableName(context, resolved.entity) : undefined;
        if (!childTable) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: @children needs an array of an entity, found \`${typeNode.getText()}\``,
            );
            return true;
        }
        // The child's foreign-key column is resolved once every table is built.
        table.relations.set(fieldName, { kind: "children", table: childTable });
        return true;
    }

    if (resolved?.entity) {
        if (tags.inlined) {
            inlineColumns(context, table, property, resolved.entity);
            return true;
        }
        if (tags.foreignKey !== undefined) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: @foreignKey must be on the scalar key field, not the entity`,
            );
            return true;
        }
        if (!tags.relation) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: \`${resolved.entity}\` is an entity; add @relation`,
            );
            return true;
        }
        const targetTable = entityTableName(context, resolved.entity);
        if (!targetTable) {
            context.report(property.declaration, `\`${fieldName}\`: @relation has no interface for \`${resolved.entity}\``);
            return true;
        }
        // @relation navigates through the `@foreignKey <entity>` field the interface declares;
        // it adds no column of its own. The pair is joined once every table's columns exist.
        table.relations.set(fieldName, { kind: "relation", table: targetTable });
        return true;
    }

    return false;
}

/** Add the scalar column a field declares, or report why it cannot be one. */
function addScalarColumn(
    context: BuildContext,
    table: Table,
    property: SpecProperty,
    resolved: TypeResolution | undefined,
    isPrimaryKey: boolean,
    foreignKeyTarget: string | undefined,
    foreignKeyTable: string | undefined,
): void {
    const fieldName = property.name;
    const notNull = !property.optional;
    const tags = property.tags;

    // A default makes the column not null even when the field is optional: the database fills it.
    // The clock tags supply their own default, so they make the column not null the same way.
    const defaultValue = tags.default ?? (tags.createdAt || tags.updatedAt ? "now()" : undefined);
    const column: Column = {
        name: fieldName,
        sqlType: resolved?.sqlType ?? "text",
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
    if (resolved?.checkValues) {
        column.checkValues = resolved.checkValues;
    }
    if (defaultValue !== undefined) {
        column.default = defaultValue;
    }
    if (tags.pgvirtual !== undefined) {
        column.generatedExpression = stripSemicolon(tags.pgvirtual);
    }
    if (tags.version) {
        column.version = true;
    }

    if (foreignKeyTarget && foreignKeyTable) {
        const targetKey = context.primaryKeyFields(foreignKeyTarget);
        if (targetKey.length === 0) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: @foreignKey ${foreignKeyTarget} has no @primaryKey field`,
            );
            return;
        }
        // One column cannot carry a composite key, so a reference to one is a diagnostic.
        if (targetKey.length > 1) {
            context.report(
                property.declaration,
                `\`${fieldName}\`: @foreignKey ${foreignKeyTarget} has a composite @primaryKey`,
            );
            return;
        }
        // The key column takes the referenced table's key type and names its key column.
        column.sqlType = context.primaryKeySqlType(foreignKeyTarget);
        column.references = { table: foreignKeyTable, column: targetKey[0]?.name as string };
    }

    table.columns.push(column);

    // A trigger statement maintains the field on every write; the clock tag contributes its own.
    if (tags.pgtrigger !== undefined) {
        table.sameRowAssignments.push(stripSemicolon(tags.pgtrigger) + ";");
    }
    if (tags.updatedAt) {
        table.sameRowAssignments.push(`NEW.${quote(fieldName)} := now();`);
    }
}

/** Expand an `@inlined` entity field into prefixed scalar columns on the parent table. */
function inlineColumns(context: BuildContext, table: Table, property: SpecProperty, entity: string): void {
    const fieldName = property.name;
    const notNull = !property.optional;

    const declaration = context.interfaces.get(entity);
    if (!declaration) {
        context.report(property.declaration, `\`${fieldName}\`: @inlined ${entity} has no interface`);
        return;
    }
    const columns: Record<string, string> = {};
    for (const inner of declaration.properties) {
        const innerName = inner.name;
        const innerType = inner.declaration.getTypeNode();
        if (!innerType) {
            context.report(inner.declaration, `\`${entity}.${innerName}\`: cannot resolve a type node`);
            continue;
        }
        const resolved = context.resolveTypeNode(innerType);
        if (!resolved) {
            context.report(inner.declaration, `\`${entity}.${innerName}\`: unsupported type \`${innerType.getText()}\``);
            continue;
        }
        if (resolved.isArray || resolved.entity) {
            context.report(inner.declaration, `\`${entity}.${innerName}\`: @inlined only inlines scalar fields`);
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

function entityTableName(context: BuildContext, entity: string): string | undefined {
    return context.interfaces.get(entity)?.tableName;
}

/** Attach each cross-table aggregate to the child table that changes it. */
function attachRollups(tables: Map<string, Table>, interfaces: Map<string, SpecInterface>): void {
    for (const spec of interfaces.values()) {
        const parentTable = tables.get(spec.name);
        if (!parentTable) {
            continue;
        }
        for (const property of spec.properties) {
            const rollupStatement = property.tags.pgrollup;
            if (rollupStatement === undefined) {
                continue;
            }
            // One statement is written for the child change and mirrored for the child removal.
            const newStatement = stripSemicolon(rollupStatement) + ";";
            const oldStatement = newStatement.replaceAll("NEW.", "OLD.");
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
                rollup.newStatements.push(newStatement);
                rollup.oldStatements.push(oldStatement);
                parentTable.rollups.set(child.name, rollup);
            }
        }
    }
}

/** Point each branch at the column it navigates through, once every table's columns exist. */
function resolveBranchColumns(tables: Map<string, Table>, context: BuildContext): void {
    const byTableName = new Map<string, Table>();
    for (const table of tables.values()) {
        byTableName.set(table.name, table);
    }
    for (const table of tables.values()) {
        for (const [fieldName, relation] of table.relations) {
            if (!relation.table) {
                continue;
            }
            // @relation never adds a column: it requires a `@foreignKey` field to navigate through.
            if (relation.kind === "relation") {
                const candidates = table.columns.filter(
                    (candidate) => candidate.references?.table === relation.table,
                );
                const column = candidates[0];
                if (!column) {
                    // Name the tables the FKs do point at, so a `@relation` aimed at the wrong one reads.
                    const targets = [
                        ...new Set(
                            table.columns
                                .map((candidate) => candidate.references?.table)
                                .filter((target): target is string => target !== undefined),
                        ),
                    ];
                    const hint =
                        targets.length > 0
                            ? `; this table references ${targets.map((target) => `\`${target}\``).join(", ")}`
                            : "";
                    context.reportField(
                        table,
                        fieldName,
                        `@relation needs a @foreignKey field referencing \`${relation.table}\`${hint}`,
                    );
                    continue;
                }
                if (candidates.length > 1) {
                    context.reportField(
                        table,
                        fieldName,
                        `@relation matches more than one foreign key referencing \`${relation.table}\``,
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
                context.reportField(table, fieldName, `@children ${relation.table} has no foreign key to ${table.name}`);
                continue;
            }
            relation.column = foreignKey.name;
        }
    }
}

/** Resolve spec type nodes to their Postgres storage. */
function createTypeResolver(
    interfaces: Map<string, SpecInterface>,
    aliases: Map<string, SpecTypeAlias>,
): TypeResolver {
    /** The fields an entity declares as its primary key, in declaration order. */
    function primaryKeyFields(entity: string): SpecProperty[] {
        return (interfaces.get(entity)?.properties ?? []).filter((property) => property.tags.primaryKey);
    }

    /** The SQL type of a single-column primary key, read from its `@primaryKey` field rather than assumed. */
    function primaryKeySqlType(entity: string): string {
        const typeNode = primaryKeyFields(entity)[0]?.declaration.getTypeNode();
        return typeNode ? resolveTypeNode(typeNode)?.sqlType ?? "text" : "text";
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

    return { resolveTypeNode, primaryKeyFields, primaryKeySqlType };
}

/** Collect diagnostics, with file paths relative to the working directory. */
function createReporter(
    interfaces: Map<string, SpecInterface>,
    diagnostics: Diagnostic[],
): Reporter {
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

    return { report, reportField };
}
