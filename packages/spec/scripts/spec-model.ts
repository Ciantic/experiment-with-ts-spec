/**
 * Parse `spec/src` into the model shared by the generators and the linter.
 * See docs/spec-annotations.md.
 */
import { dirname, join, relative as relativePath } from "node:path";
import {
    type InterfaceDeclaration,
    type JSDoc,
    type JSDocTag,
    type Project,
    type PropertySignature,
    type TypeAliasDeclaration,
} from "ts-morph";

/** The `spec` package root, derived from this file's location rather than the cwd. */
export const SPEC_PACKAGE_ROOT = dirname(import.meta.dirname);

/** The spec `src` directory; a source path under it maps back to its package export specifier. */
export const SPEC_SRC_ROOT = join(SPEC_PACKAGE_ROOT, "src");

/** Every spec source file. Used for alias discovery, and by the linter as its scan set. */
export const SPEC_GLOB = join(SPEC_SRC_ROOT, "**/*.ts");

/** The domain entities the generators read. */
export const DEFAULT_SPEC_GLOB = join(SPEC_SRC_ROOT, "domain/**/*.ts");

/** Tags a field may carry. */
export const FIELD_TAGS = [
    "fieldName",
    "widget",
    "generated",
    "computed",
    "createdAt",
    "updatedAt",
    "pgvirtual",
    "pgtrigger",
    "pgrollup",
    "relation",
    "children",
    "inlined",
    "primaryKey",
    "foreignKey",
    "unique",
    "default",
    "version",
    "queryfilter",
    "queryorderby",
    "where",
] as const;

/** Tags an interface may carry. */
export const INTERFACE_TAGS = ["table"] as const;

/** Tags a type alias may carry. */
export const TYPE_TAGS = ["primitive", "zod", "pgtype"] as const;

/** Every tag this model recognises. */
export const TAGS = [...FIELD_TAGS, ...INTERFACE_TAGS, ...TYPE_TAGS] as const;

export type FieldTag = (typeof FIELD_TAGS)[number];
export type InterfaceTag = (typeof INTERFACE_TAGS)[number];
export type TypeTag = (typeof TYPE_TAGS)[number];
export type Tag = (typeof TAGS)[number];

/** Retired tags, mapped to the advice a linter reports in their place. */
export const RETIRED_TAGS = new Map<string, string>([
    ["readonly", "use @generated for system-assigned fields or @computed for derived fields"],
    ["type", "the TypeScript type already carries this; drop it"],
    ["values", "the TypeScript type already carries this; drop it"],
    ["formula", "put the expression on the field with @pgvirtual, @pgtrigger, or @pgrollup"],
]);

/** Widget hints a field may carry. */
export const WIDGETS = ["text", "number", "date", "select", "table", "textarea"] as const;
export type Widget = (typeof WIDGETS)[number];

/** The Postgres realization of a `@computed` field, one tag per field. See docs/spec-annotations.md. */
export const COMPUTED_KINDS = ["pgvirtual", "pgtrigger", "pgrollup"] as const;
export type ComputedKind = (typeof COMPUTED_KINDS)[number];

/** The sort directions an `@queryorderby default …` may name. */
export const ORDER_DIRECTIONS = ["asc", "desc"] as const;
export type OrderDirection = (typeof ORDER_DIRECTIONS)[number];

/** True when the text is one of {@link ORDER_DIRECTIONS}. */
export function isOrderDirection(value: string | undefined): value is OrderDirection {
    return value === "asc" || value === "desc";
}

/** The comparison operators a `@where` field may name. */
export const COMPARE_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

/** True when the text is one of {@link COMPARE_OPERATORS}. */
export function isCompareOperator(value: string): value is CompareOperator {
    return (COMPARE_OPERATORS as readonly string[]).includes(value);
}

/** A problem found while reading the spec. */
export interface Diagnostic {
    filePath: string;
    line: number;
    message: string;
}

/** The `key=value` parameters on a tag comment, such as `default asc`. */
export type TagParameters = Map<string, string>;

/** The tags on a declaration, decoded once so consumers never walk JSDoc themselves. */
export interface Tags {
    /** Every occurrence, keyed by tag name, for rules that need the raw tag. */
    byName: Map<string, JSDocTag[]>;
    fieldName?: string;
    widget?: string;
    generated: boolean;
    /** The field is derived; the database owns it, so a create never supplies it. */
    computed: boolean;
    /** The field holds the row's creation moment; the database supplies it. See docs/timestamps.md. */
    createdAt: boolean;
    /** The field holds the row's last-write moment; the database maintains it. See docs/timestamps.md. */
    updatedAt: boolean;
    /** The generated-column expression that materializes a `@computed` field, without `NEW.`. */
    pgvirtual?: string;
    /** The before insert/update statement that maintains a `@computed` field, using `NEW.`. */
    pgtrigger?: string;
    /** The child-change statement that maintains an aggregated `@computed` field, using `NEW.`. */
    pgrollup?: string;
    /** The field holds a single related entity, stored as a foreign key. */
    relation: boolean;
    /** The field holds a child collection; the child table carries the foreign key. */
    children: boolean;
    /** The field holds an entity whose scalar fields are flattened into snapshot columns. */
    inlined: boolean;
    /** The field is part of the table's primary key; one or more per interface. */
    primaryKey: boolean;
    /** The interface this field references, as written in `@foreignKey Customer`. */
    foreignKey?: string;
    unique: boolean;
    default?: string;
    version: boolean;
    table?: string;
    primitive: boolean;
    zod?: string;
    /** A storage-layer type for the alias, e.g. `uuid`. Declared by the spec, consumed by a generator. */
    pgtype?: string;
    /** The field may be an equality filter of its entity's generated `query` read. See docs/queries.md. */
    queryfilter: boolean;
    /** The field may be an ordering key of its entity's generated `query` read. See docs/queries.md. */
    queryOrderBy?: { default?: OrderDirection };
    /** The comparison operators the field may be compared with, as written. See docs/queries.md. */
    where?: string[];
}

/** A field of a spec interface. */
export interface SpecProperty {
    name: string;
    optional: boolean;
    /** The field type as written, e.g. `InvoiceRow[]`. */
    typeText: string;
    declaration: PropertySignature;
    tags: Tags;
}

/** An interface in the spec: an entity, or a reusable structure. */
export interface SpecInterface {
    name: string;
    /** The `@table` value, or the snake_cased interface name. */
    tableName: string;
    filePath: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    declaration: InterfaceDeclaration;
    properties: SpecProperty[];
}

/** A type alias in the spec. */
export interface SpecTypeAlias {
    name: string;
    filePath: string;
    declaration: TypeAliasDeclaration;
    tags: Tags;
}

/** The parsed spec. */
export interface SpecModel {
    interfaces: Map<string, SpecInterface>;
    aliases: Map<string, SpecTypeAlias>;
}

/** Inputs to {@link parseSpec}. */
export interface ParseOptions {
    /** Where entities (interfaces) are read from; defaults to the domain entities. */
    entityGlob?: string;
    /** Where type aliases (including primitives) are read from; defaults to every spec file. */
    aliasGlob?: string;
}

/** InvoiceRow -> invoice_row. */
export function snakeCase(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** True when a create writes the field, rather than the database owning it. See docs/repositories.md. */
export function isInsertable(property: SpecProperty): boolean {
    const tags = property.tags;
    // A `@default` column is left to the database on insert.
    if (tags.default !== undefined) {
        return false;
    }
    // The clock tags and a virtual generated column are the database's entirely.
    if (tags.createdAt || tags.updatedAt || tags.pgvirtual !== undefined) {
        return false;
    }
    // A computed column arrives from a trigger, so it is the caller's only while the column is
    // required: a nullable one may be left out and derived from the rows that follow.
    if (tags.computed) {
        return !property.optional;
    }
    return true;
}

/** The fields a create omits: a branch that is not flattened, or a column the database owns. */
export function omittedFromInsert(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter(
        (property) => property.tags.relation || property.tags.children || !isInsertable(property),
    );
}

/** The `@inlined` fields a create nests, each written as the target entity's own insert shape. */
export function inlinedFromInsert(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => property.tags.inlined);
}

/** True when a patch writes the field: what a create writes, plus the version it carries as its precondition. */
export function isUpdatable(property: SpecProperty): boolean {
    // The version is the one defaulted column a patch supplies; every other one keeps its stored value.
    return Boolean(property.tags.version) || (isInsertable(property) && !property.tags.relation && !property.tags.children);
}

/** The fields a patch omits; the wire schema and the generated patch type share this set, so they agree. */
export function omittedFromPatch(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => !isUpdatable(property));
}

/** An interface's primary key fields, in declaration order, which is the key's column order. */
export function primaryKeyProperties(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => property.tags.primaryKey);
}

/** Invoice -> invoice, GUID -> guid, EInvoiceAddress -> eInvoiceAddress. */
export function lowerFirst(name: string): string {
    // A leading run of capitals is an acronym: lowercase all of it, not just the first letter.
    const acronym = name.match(/^[A-Z]+(?=[A-Z][a-z]|$)/);
    if (acronym) {
        return acronym[0].toLowerCase() + name.slice(acronym[0].length);
    }
    return name.charAt(0).toLowerCase() + name.slice(1);
}

/** The module specifier that imports a spec source file, honouring the package's exports map. */
export function specImportSpecifier(sourceFile: string): string {
    const relativeToSrc = relativePath(SPEC_SRC_ROOT, sourceFile);
    return `spec/${relativeToSrc}`;
}

/** The trimmed comment on a tag, or undefined when it carries none. */
export function tagComment(tag: JSDocTag): string | undefined {
    const text = (tag.getCommentText() ?? "").trim();
    return text === "" ? undefined : text;
}

/** Parse `key=value` pairs out of a tag comment. */
export function parseParameters(tag: JSDocTag): TagParameters {
    const parameters: TagParameters = new Map();
    for (const match of (tag.getCommentText() ?? "").matchAll(/([A-Za-z]+)=(\S+)/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) {
            parameters.set(key, value);
        }
    }
    return parameters;
}

/** Decode the JSDoc tags on a declaration, keeping the raw tags for rules that need them. */
export function readTags(holder: { getJsDocs(): JSDoc[] }): Tags {
    const tags: Tags = {
        byName: new Map(),
        generated: false,
        computed: false,
        createdAt: false,
        updatedAt: false,
        relation: false,
        children: false,
        inlined: false,
        primaryKey: false,
        unique: false,
        version: false,
        primitive: false,
        queryfilter: false,
    };

    for (const doc of holder.getJsDocs()) {
        for (const tag of doc.getTags()) {
            const name = tag.getTagName();
            const instances = tags.byName.get(name);
            if (instances) {
                instances.push(tag);
            } else {
                tags.byName.set(name, [tag]);
            }

            const value = tagComment(tag);
            switch (name) {
                case "fieldName":
                    if (value !== undefined) tags.fieldName ??= value;
                    break;
                case "widget":
                    if (value !== undefined) tags.widget ??= value;
                    break;
                case "relation":
                    tags.relation = true;
                    break;
                case "children":
                    tags.children = true;
                    break;
                case "inlined":
                    tags.inlined = true;
                    break;
                case "primaryKey":
                    tags.primaryKey = true;
                    break;
                case "foreignKey":
                    if (value !== undefined) tags.foreignKey ??= value;
                    break;
                case "default":
                    if (value !== undefined) tags.default ??= value;
                    break;
                case "table":
                    if (value !== undefined) tags.table ??= value;
                    break;
                case "zod":
                    if (value !== undefined) tags.zod ??= value;
                    break;
                case "pgtype":
                    if (value !== undefined) tags.pgtype ??= value;
                    break;
                case "queryfilter":
                    tags.queryfilter = true;
                    break;
                case "queryorderby": {
                    // Bare marks the field orderable; `default asc|desc` also names the entity default.
                    if (tags.queryOrderBy === undefined) {
                        const tokens = (value ?? "").split(/\s+/).filter((token) => token !== "");
                        const order: { default?: OrderDirection } = {};
                        if (tokens[0] === "default" && isOrderDirection(tokens[1])) {
                            order.default = tokens[1];
                        }
                        tags.queryOrderBy = order;
                    }
                    break;
                }
                case "where": {
                    // The operators, as written; an empty list is a lint finding rather than an error here.
                    if (tags.where === undefined) {
                        tags.where = (value ?? "").split(/\s+/).filter((token) => token !== "");
                    }
                    break;
                }
                case "generated":
                    tags.generated = true;
                    break;
                case "unique":
                    tags.unique = true;
                    break;
                case "version":
                    tags.version = true;
                    break;
                case "primitive":
                    tags.primitive = true;
                    break;
                case "computed":
                    tags.computed = true;
                    break;
                case "createdAt":
                    tags.createdAt = true;
                    break;
                case "updatedAt":
                    tags.updatedAt = true;
                    break;
                case "pgvirtual":
                    if (value !== undefined) tags.pgvirtual ??= value;
                    break;
                case "pgtrigger":
                    if (value !== undefined) tags.pgtrigger ??= value;
                    break;
                case "pgrollup":
                    if (value !== undefined) tags.pgrollup ??= value;
                    break;
                default:
                    break;
            }
        }
    }

    return tags;
}

/** Parse the spec into interfaces and aliases. */
export function parseSpec(project: Project, options: ParseOptions = {}): SpecModel {
    const entityGlob = options.entityGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const interfaces = new Map<string, SpecInterface>();
    const aliases = new Map<string, SpecTypeAlias>();

    for (const sourceFile of project.getSourceFiles(aliasGlob)) {
        const filePath = sourceFile.getFilePath();

        for (const declaration of sourceFile.getTypeAliases()) {
            const tags = readTags(declaration);
            const alias: SpecTypeAlias = {
                name: declaration.getName(),
                filePath,
                declaration,
                tags,
            };
            aliases.set(alias.name, alias);
        }
    }

    for (const sourceFile of project.getSourceFiles(entityGlob)) {
        const filePath = sourceFile.getFilePath();

        for (const declaration of sourceFile.getInterfaces()) {
            const name = declaration.getName();
            interfaces.set(name, {
                name,
                tableName: readTags(declaration).table ?? snakeCase(name),
                filePath,
                importSpecifier: specImportSpecifier(filePath),
                declaration,
                properties: declaration.getProperties().map((property) => {
                    const tags = readTags(property);
                    // The primary key is a filter every entity has, so writing the tag on it is
                    // redundant. The linter reports that rather than ignoring it.
                    if (tags.primaryKey) {
                        tags.queryfilter = true;
                    }
                    return {
                        name: property.getName(),
                        optional: property.hasQuestionToken(),
                        typeText: property.getTypeNode()?.getText() ?? "",
                        declaration: property,
                        tags,
                    };
                }),
            });
        }
    }

    return { interfaces, aliases };
}
