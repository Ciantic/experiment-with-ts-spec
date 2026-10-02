/**
 * Parse `spec/src` into the model shared by the generators and the linter.
 * See docs/spec-annotations.md.
 */
import { dirname, join, relative as relativePath } from "node:path";
import {
    Node,
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
    "relation",
    "children",
    "inlined",
    "unique",
    "default",
    "version",
    "queryfilter",
] as const;

/** Tags an interface may carry. */
export const INTERFACE_TAGS = ["table"] as const;

/** Tags a type alias may carry. */
export const TYPE_TAGS = ["formula", "primitive", "zod", "pgtype"] as const;

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
]);

/** Widget hints a field may carry. */
export const WIDGETS = ["text", "number", "date", "select", "table", "textarea"] as const;
export type Widget = (typeof WIDGETS)[number];

/** Storage modes a `@computed` field may carry. */
export const STORAGE_MODES = ["generated", "stored", "derived"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/** A problem found while reading the spec. */
export interface Diagnostic {
    filePath: string;
    line: number;
    message: string;
}

/** The `key=value` parameters on a tag comment such as `storage=stored formula=rowNetAmount`. */
export type TagParameters = Map<string, string>;

/** A decoded `@computed` tag. */
export interface ComputedTag {
    /** The `storage=` value, if any. */
    storage: string | undefined;
    /** The `formula=` value, if any. */
    formula: string | undefined;
    /** Every parameter on the tag, so a linter can report the ones it does not know. */
    parameters: TagParameters;
}

/** The tags on a declaration, decoded once so consumers never walk JSDoc themselves. */
export interface Tags {
    /** Every occurrence, keyed by tag name, for rules that need the raw tag. */
    byName: Map<string, JSDocTag[]>;
    fieldName?: string;
    widget?: string;
    generated: boolean;
    computed?: ComputedTag;
    /** The field holds a single related entity, stored as a foreign key. */
    relation: boolean;
    /** The field holds a child collection; the child table carries the foreign key. */
    children: boolean;
    /** The field holds an entity whose scalar fields are flattened into snapshot columns. */
    inlined: boolean;
    unique: boolean;
    default?: string;
    version: boolean;
    table?: string;
    formula: boolean;
    primitive: boolean;
    zod?: string;
    /** A storage-layer type for the alias, e.g. `uuid`. Declared by the spec, consumed by a generator. */
    pgtype?: string;
    /** The field may be an equality filter of its entity's generated `query` read. See docs/queries.md. */
    queryfilter: boolean;
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
    /** String-literal members of a `@formula` alias, in declaration order. */
    formulaNames: string[];
}

/** The parsed spec. */
export interface SpecModel {
    interfaces: Map<string, SpecInterface>;
    aliases: Map<string, SpecTypeAlias>;
    /** Every name declared by a `@formula` alias: the valid `formula=` values. */
    formulaNames: Set<string>;
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
        relation: false,
        children: false,
        inlined: false,
        unique: false,
        version: false,
        formula: false,
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
                case "generated":
                    tags.generated = true;
                    break;
                case "unique":
                    tags.unique = true;
                    break;
                case "version":
                    tags.version = true;
                    break;
                case "formula":
                    tags.formula = true;
                    break;
                case "primitive":
                    tags.primitive = true;
                    break;
                case "computed": {
                    if (!tags.computed) {
                        const parameters = parseParameters(tag);
                        tags.computed = {
                            storage: parameters.get("storage"),
                            formula: parameters.get("formula"),
                            parameters,
                        };
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    return tags;
}

/** The members of a type, unwrapping a single-member alias that has no union node. */
export function typeMembers(declaration: TypeAliasDeclaration): Node[] {
    const typeNode = declaration.getTypeNode();
    if (!typeNode) {
        return [];
    }
    return Node.isUnionTypeNode(typeNode) ? typeNode.getTypeNodes() : [typeNode];
}

/** The string-literal members of a type, in declaration order. */
export function formulaNamesIn(declaration: TypeAliasDeclaration): string[] {
    const names: string[] = [];
    for (const member of typeMembers(declaration)) {
        if (!Node.isLiteralTypeNode(member)) {
            continue;
        }
        const literal = member.getLiteral();
        if (Node.isStringLiteral(literal)) {
            names.push(literal.getLiteralText());
        }
    }
    return names;
}

/** Read formula names from every `@formula`-annotated type under `spec/`, statically. */
export function readFormulaNames(project: Project, specGlob = SPEC_GLOB): Set<string> {
    const names = new Set<string>();
    for (const sourceFile of project.getSourceFiles(specGlob)) {
        for (const declaration of sourceFile.getTypeAliases()) {
            if (!readTags(declaration).formula) {
                continue;
            }
            for (const name of formulaNamesIn(declaration)) {
                names.add(name);
            }
        }
    }
    return names;
}

/** Parse the spec into interfaces, aliases, and the formula vocabulary. */
export function parseSpec(project: Project, options: ParseOptions = {}): SpecModel {
    const entityGlob = options.entityGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const interfaces = new Map<string, SpecInterface>();
    const aliases = new Map<string, SpecTypeAlias>();
    const formulaNames = new Set<string>();

    for (const sourceFile of project.getSourceFiles(aliasGlob)) {
        const filePath = sourceFile.getFilePath();

        for (const declaration of sourceFile.getTypeAliases()) {
            const tags = readTags(declaration);
            const alias: SpecTypeAlias = {
                name: declaration.getName(),
                filePath,
                declaration,
                tags,
                formulaNames: formulaNamesIn(declaration),
            };
            aliases.set(alias.name, alias);
            if (tags.formula) {
                for (const name of alias.formulaNames) {
                    formulaNames.add(name);
                }
            }
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
                    // `id` is the primary key every entity has, so it is always a filter; writing
                    // the tag on it is redundant. The linter reports that rather than ignoring it.
                    if (property.getName() === "id") {
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

    return { interfaces, aliases, formulaNames };
}
