/**
 * Parse `spec/src` into the model shared by the generators and the linter.
 * See docs/spec-annotations.md.
 */
import { dirname, join, relative as relativePath } from "node:path";
import {
    Node,
    Project,
    SyntaxKind,
    ts,
    type JSDoc,
    type JSDocTag,
} from "ts-morph";
import { DEFAULT_PG_TYPES } from "./pg-types.ts";

/** The `spec` package root, derived from this file's location rather than the cwd. */
export const SPEC_PACKAGE_ROOT = dirname(import.meta.dirname);

/** The spec `src` directory; a source path under it maps back to its package export specifier. */
export const SPEC_SRC_ROOT = join(SPEC_PACKAGE_ROOT, "src");

/** Every spec source file: the scan set for the parsers, the generators, and the linter. */
export const SPEC_GLOB = join(SPEC_SRC_ROOT, "**/*.ts");

/** Tags a field may carry. */
export const FIELD_TAGS = [
    "fieldName",
    "widget",
    "computed",
    "createdAt",
    "updatedAt",
    "pgVirtual",
    "pgTrigger",
    "relation",
    "children",
    "inlined",
    "primaryKey",
    "foreignKey",
    "unique",
    "pgDefault",
    "pgAutoIncrement",
    "version",
    "queryFilter",
    "queryOrderBy",
    "queryWhere",
] as const;

/** Tags an interface may carry. */
export const INTERFACE_TAGS = [
    "entity",
    "pgTable",
    "pgTrigger",
    "repository",
    "restRepository",
    "queries",
    "restQueries",
] as const;

/** Tags a type alias may carry. */
export const TYPE_TAGS = ["primitive", "zod", "pgType"] as const;

/** Every tag this model recognises. */
export const TAGS = [...FIELD_TAGS, ...INTERFACE_TAGS, ...TYPE_TAGS] as const;

export type FieldTag = (typeof FIELD_TAGS)[number];
export type InterfaceTag = (typeof INTERFACE_TAGS)[number];
export type TypeTag = (typeof TYPE_TAGS)[number];
export type Tag = (typeof TAGS)[number];

/** Retired or renamed tags, mapped to the advice a linter reports in their place. */
export const RETIRED_TAGS = new Map<string, string>([
    ["readonly", "use @computed for a derived field; a system-assigned column needs no tag"],
    ["generated", "no tag marks a column as system-assigned; drop it"],
    ["default", "use @pgDefault instead"],
    ["table", "use @pgTable instead"],
    ["pgvirtual", "use @pgVirtual instead"],
    ["pgtrigger", "use @pgTrigger instead"],
    ["pgrollup", "use @pgTrigger with `on <Child>` instead"],
    ["pgRollup", "use @pgTrigger with `on <Child>` instead"],
    ["pgdefault", "use @pgDefault instead"],
    ["pgtable", "use @pgTable instead"],
    ["pgtype", "use @pgType instead"],
    ["queryfilter", "use @queryFilter instead"],
    ["queryorderby", "use @queryOrderBy instead"],
    ["where", "use @queryWhere instead"],
    ["type", "the TypeScript type already carries this; drop it"],
    ["values", "the TypeScript type already carries this; drop it"],
    ["formula", "put the expression on the field with @pgVirtual or @pgTrigger"],
]);

/** Widget hints a field may carry. */
export const WIDGETS = ["text", "number", "date", "select", "table", "textarea"] as const;
export type Widget = (typeof WIDGETS)[number];

/** The Postgres realization of a `@computed` field, one tag per field. See docs/spec-annotations.md. */
export const COMPUTED_KINDS = ["pgVirtual", "pgTrigger"] as const;
export type ComputedKind = (typeof COMPUTED_KINDS)[number];

/** The timings a `@pgTrigger` header may name. */
export const TRIGGER_TIMINGS = ["before", "after"] as const;
export type TriggerTiming = (typeof TRIGGER_TIMINGS)[number];

/** The row events a `@pgTrigger` header may name. */
export const TRIGGER_EVENTS = ["insert", "update", "delete"] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** The levels a `@pgTrigger` runs at. Postgres runs a trigger per statement unless it says `for each row`. */
export const TRIGGER_LEVELS = ["row", "statement"] as const;
export type TriggerLevel = (typeof TRIGGER_LEVELS)[number];

/** True when the text is one of {@link TRIGGER_LEVELS}. */
export function isTriggerLevel(value: string | undefined): value is TriggerLevel {
    return (TRIGGER_LEVELS as readonly string[]).includes(value ?? "");
}

/** The sort directions an `@queryOrderBy default …` may name. */
export const ORDER_DIRECTIONS = ["asc", "desc"] as const;
export type OrderDirection = (typeof ORDER_DIRECTIONS)[number];

/** True when the text is one of {@link ORDER_DIRECTIONS}. */
export function isOrderDirection(value: string | undefined): value is OrderDirection {
    return value === "asc" || value === "desc";
}

/** The `key=action` options a `@foreignKey` value may carry. */
export const FOREIGN_KEY_OPTIONS = ["onDelete", "onUpdate"] as const;
export type ForeignKeyOption = (typeof FOREIGN_KEY_OPTIONS)[number];

/** True when the text is one of {@link FOREIGN_KEY_OPTIONS}. */
export function isForeignKeyOption(value: string): value is ForeignKeyOption {
    return (FOREIGN_KEY_OPTIONS as readonly string[]).includes(value);
}

/** The referential actions a `@foreignKey` option may name, as written. See docs/spec-annotations.md. */
export const REFERENTIAL_ACTIONS = ["cascade", "restrict", "noAction", "setNull", "setDefault"] as const;
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/** True when the text is one of {@link REFERENTIAL_ACTIONS}. */
export function isReferentialAction(value: string | undefined): value is ReferentialAction {
    return (REFERENTIAL_ACTIONS as readonly string[]).includes(value ?? "");
}

/** A `@foreignKey <Entity>` value: the interface the column points at and its referential actions. */
export interface ForeignKey {
    /** The interface the column points at, as written. */
    entity: string;
    /** The `on delete` action, when the field declares one. */
    onDelete?: ReferentialAction;
    /** The `on update` action, when the field declares one. */
    onUpdate?: ReferentialAction;
}

/** The comparison operators a `@queryWhere` field may name. */
export const COMPARE_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

/** True when the text is one of {@link COMPARE_OPERATORS}. */
export function isCompareOperator(value: string): value is CompareOperator {
    return (COMPARE_OPERATORS as readonly string[]).includes(value);
}

/** The write operations `@repository` and `@restRepository` may name, in canonical order. */
export const WRITE_OPERATIONS = ["create", "upsert", "update", "delete"] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/** The read operations `@queries` and `@restQueries` may name, in canonical order. */
export const READ_OPERATIONS = ["query"] as const;
export type ReadOperation = (typeof READ_OPERATIONS)[number];

/** The JavaScript type a spec value has at the boundary, whatever its storage type spells. */
export type JsType = "string" | "number" | "bigint" | "boolean" | "Date" | "Uint8Array" | "object";

/**
 * The JavaScript type a TypeScript type denotes by its own name rather than through an alias the spec declares:
 * a keyword (`string`, `bigint`) or a built-in the spec names (`Date`, `Record`).
 */
export const JS_TYPES: Record<string, JsType> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    bigint: "bigint",
    Date: "Date",
    Uint8Array: "Uint8Array",
    Record: "object",
};

/** Where a declaration sits in the spec, as a diagnostic reports it. */
export interface SpecLocation {
    /** The source path relative to the working directory. */
    filePath: string;
    line: number;
}

/** A problem found while reading the spec. */
export interface Diagnostic extends SpecLocation {
    message: string;
}

/** The location a declaration points at within the spec. */
function locationOf(declaration: Node): SpecLocation {
    return {
        filePath: declaration.getSourceFile().getFilePath().replace(`${process.cwd()}/`, ""),
        line: declaration.getStartLineNumber(),
    };
}

/** The `key=value` parameters on a tag comment, such as `default asc`. */
export type TagParameters = Map<string, string>;

/** A JSDoc tag as written: its name, its comment, and where it sits. */
export interface SpecTag {
    /** The tag name, without the leading `@`. */
    name: string;
    /** The tag's comment text, trimmed, or undefined when it carries none. */
    value: string | undefined;
    /** The line the tag sits on. */
    line: number;
}

/** A declaration's tags as written, in the order and spelling the author used. Lint only. */
export interface WrittenTags {
    /** Every occurrence, in source order. */
    all: SpecTag[];
    /** Every occurrence, keyed by tag name. */
    byName: Map<string, SpecTag[]>;
}

/**
 * The tags on a declaration: the decoded flags a generator maps from, and the tags as written.
 * `written` holds the declared tags alone, so a rule about a missing tag does not see a default in.
 */
export interface Tags {
    /** For linting only; a generator reads a decoded flag instead. */
    written: WrittenTags;
    fieldName?: string;
    widget?: string;
    /** The field is derived; the database owns it, so a create never supplies it. */
    computed: boolean;
    /** The field holds the row's creation moment; the database supplies it. See docs/timestamps.md. */
    createdAt: boolean;
    /** The field holds the row's last-write moment; the database maintains it. See docs/timestamps.md. */
    updatedAt: boolean;
    /** The generated-column expression that materializes a `@computed` field, without `NEW.`. */
    pgVirtual?: string;
    /** The row trigger that maintains a `@computed` field: its attachment, timing, events, and statement. */
    pgTrigger?: PgTrigger;
    /** The field holds a single related entity, stored as a foreign key. */
    relation: boolean;
    /** The field holds a child collection; the child table carries the foreign key. */
    children: boolean;
    /** The field holds an entity whose scalar fields are flattened into snapshot columns. */
    inlined: boolean;
    /** The field is part of the table's primary key; one or more per interface. */
    primaryKey: boolean;
    /** The interface this field references and its referential actions, from `@foreignKey Customer onDelete=cascade`. */
    foreignKey?: ForeignKey;
    unique: boolean;
    /** The database column default, written verbatim into the DDL. */
    pgDefault?: string;
    /** The database assigns the column at insert, so no write supplies it and a create reads it back. */
    pgAutoIncrement: boolean;
    version: boolean;
    /** The interface is an entity the generators read; an untagged interface is a contract. See docs/spec-annotations.md. */
    entity: boolean;
    /** The Postgres table name for the interface. */
    pgTable?: string;
    /** The write operations `@repository` declares, in {@link WRITE_OPERATIONS} order. See docs/repositories.md. */
    repository?: WriteOperation[];
    /** The write operations `@restRepository` exposes, in {@link WRITE_OPERATIONS} order. See docs/rest-api.md. */
    restRepository?: WriteOperation[];
    /** The read operations `@queries` declares, in {@link READ_OPERATIONS} order. See docs/queries.md. */
    queries?: ReadOperation[];
    /** The read operations `@restQueries` exposes, in {@link READ_OPERATIONS} order. See docs/rest-api.md. */
    restQueries?: ReadOperation[];
    primitive: boolean;
    zod?: string;
    /** A storage-layer type for the alias, e.g. `uuid`: what it declares, else what it inherits through its own type. */
    pgType?: string;
    /** The field may be an equality filter of its entity's generated `query` read. See docs/queries.md. */
    queryFilter: boolean;
    /** The field may be an ordering key of its entity's generated `query` read. See docs/queries.md. */
    queryOrderBy?: { default?: OrderDirection };
    /** The comparison operators the field may be compared with, as written. See docs/queries.md. */
    queryWhere?: string[];
}

/** One member of an object type literal, e.g. the `count: number` in `{ count: number }`. */
export interface SpecTypeMember {
    name: string;
    optional: boolean;
    type: SpecType;
}

/** The shape a field's type was written in, with parentheses unwrapped and aliases left as references. See docs/spec-annotations.md. */
export type SpecType =
    | { kind: "keyword"; name: string }
    | { kind: "reference"; name: string; arguments: string[] }
    | { kind: "array"; element: SpecType }
    | { kind: "union"; members: SpecType[] }
    | { kind: "intersection"; members: SpecType[] }
    | { kind: "object"; members: SpecTypeMember[] }
    | { kind: "stringLiteral"; value: string }
    | { kind: "numberLiteral"; value: number }
    /** The declaration carried no type annotation at all. */
    | { kind: "missing" }
    /** A shape this model does not name, such as a function or conditional type; `text` is what was written. */
    | { kind: "unknown"; text: string };

/** A field of a spec interface. */
export interface SpecProperty {
    name: string;
    optional: boolean;
    /** The field type as written, e.g. `InvoiceRow[]`. */
    typeText: string;
    /** The field type as a shape. */
    type: SpecType;
    location: SpecLocation;
    tags: Tags;
}

/** An interface in the spec: an entity, or a reusable structure. */
export interface SpecInterface {
    name: string;
    /** The Postgres table name: the `@pgTable` value, or the snake_cased interface name. */
    pgTableName: string;
    filePath: string;
    location: SpecLocation;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    properties: SpecProperty[];
    /** The interface's own tags, as written: `@pgTable`, `@repository`, and friends. */
    tags: Tags;
    /** The interface-level `@pgTrigger`, which runs for the table rather than for one field. */
    trigger?: PgTrigger;
    /** The write operations `@repository` declares; empty when the tag is absent. See docs/repositories.md. */
    repositoryOperations: WriteOperation[];
    /** The write operations `@restRepository` exposes; empty when the tag is absent. See docs/rest-api.md. */
    restRepositoryOperations: WriteOperation[];
    /** The read operations `@queries` declares; empty when the tag is absent. See docs/queries.md. */
    queries: ReadOperation[];
    /** The read operations `@restQueries` exposes; empty when the tag is absent. See docs/rest-api.md. */
    restQueries: ReadOperation[];
}

/** A type alias in the spec. */
export interface SpecTypeAlias {
    name: string;
    filePath: string;
    location: SpecLocation;
    /** The alias's own type as a shape. */
    type: SpecType;
    /** The type parameters as written, e.g. `["T extends string"]`. */
    typeParameters: string[];
    tags: Tags;
}

/** The parsed spec. */
export interface SpecModel {
    /** The entities, keyed by interface name. */
    interfaces: Map<string, SpecInterface>;
    /** Interfaces carrying no `@entity`, which the linter alone reads to report an entity tag on a contract. */
    nonEntityInterfaces: SpecInterface[];
    aliases: Map<string, SpecTypeAlias>;
}

/** Inputs to {@link parseSpec}. */
export interface ParseOptions {
    /** The spec sources to scan, honoured by an in-memory parse; defaults to every file under `spec/src`. */
    sourceGlob?: string;
}

/** InvoiceRow -> invoice_row. */
export function snakeCase(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** True when a create writes the field, rather than the database owning it. See docs/repositories.md. */
export function isInsertable(property: SpecProperty): boolean {
    const tags = property.tags;
    // A defaulted version's first revision comes from its default, so a create never carries it.
    if (tags.version && tags.pgDefault !== undefined) {
        return false;
    }
    // The clock tags, an identity column, and a virtual generated column are the database's entirely.
    if (tags.createdAt || tags.updatedAt || tags.pgAutoIncrement || tags.pgVirtual !== undefined) {
        return false;
    }
    // A nullable computation is filled in later by its mechanism; a required one must be carried by the create.
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

/** The insertable scalar fields a create may omit, because the column's `@pgDefault` fills them in. */
export function defaultedInsertProperties(spec: SpecInterface): SpecProperty[] {
    const omitted = new Set(omittedFromInsert(spec));
    return spec.properties.filter(
        (property) =>
            !omitted.has(property) && !property.tags.inlined && property.tags.pgDefault !== undefined,
    );
}

/** The `@inlined` fields a create nests, each written as the target entity's own insert shape. */
export function inlinedFromInsert(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => property.tags.inlined);
}

/** True when a patch writes the field: what a create writes, plus the version it carries as its precondition. */
export function isUpdatable(property: SpecProperty): boolean {
    // The key addresses the row a patch writes, so a patch carries it whatever a create writes.
    if (property.tags.primaryKey) {
        return true;
    }
    // The version is the optimistic-lock precondition, so a patch always carries it.
    return Boolean(property.tags.version) || (isInsertable(property) && !property.tags.relation && !property.tags.children);
}

/** The fields a patch omits; the wire schema and the generated patch type share this set, so they agree. */
export function omittedFromPatch(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => !isUpdatable(property));
}

/**
 * The updatable fields whose column is nullable, so a write may set one back to `null`.
 * `?` mirrors the column's nullability, so the field's own optionality is the test. A create, an
 * upsert, and a patch all widen with the set: omitting the field and sending `null` are one request
 * for a create and an upsert, and a patch reads `null` as clearing the column. The key and the
 * version stay out — a patch cannot clear the row it addresses, nor the precondition it carries.
 * See `docs/optionality.md` and `docs/repositories.md`.
 */
export function nullablePatchProperties(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter(
        (property) => isUpdatable(property) && property.optional && !property.tags.version && !property.tags.primaryKey,
    );
}

/** An interface's primary key fields, in declaration order, which is the key's column order. */
export function primaryKeyProperties(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => property.tags.primaryKey);
}

/** The `@pgAutoIncrement` fields: key columns the database assigns, which a create never carries. */
export function autoIncrementProperties(spec: SpecInterface): SpecProperty[] {
    return spec.properties.filter((property) => property.tags.pgAutoIncrement);
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

/** The trimmed comment on a JSDoc tag, or undefined when it carries none. */
function tagComment(tag: JSDocTag): string | undefined {
    const text = (tag.getCommentText() ?? "").trim();
    return text === "" ? undefined : text;
}

/** Read a JSDoc tag into the plain shape a consumer sees. */
function specTagOf(tag: JSDocTag): SpecTag {
    return { name: tag.getTagName(), value: tagComment(tag), line: tag.getStartLineNumber() };
}

/** Parse `key=value` pairs out of a tag's comment. */
export function parseParameters(tag: SpecTag): TagParameters {
    const parameters: TagParameters = new Map();
    for (const match of (tag.value ?? "").matchAll(/([A-Za-z]+)=(\S+)/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) {
            parameters.set(key, value);
        }
    }
    return parameters;
}

/** A `@pgTrigger`: the trigger's header, and the one statement it runs for every event. */
export interface PgTrigger {
    /** The entity the trigger attaches to; absent for the field's own table. Empty when `on` names none. */
    table?: string;
    timing: TriggerTiming;
    /** The events the trigger fires on, listed in {@link TRIGGER_EVENTS} order. */
    events: TriggerEvent[];
    /** The level the header names; absent means the placement's default. See {@link triggerLevel}. */
    level?: TriggerLevel;
    statement: string;
}

/** A `@pgTrigger` header, with its tokens as written so the linter can report an unknown one. */
export interface TriggerHeader {
    timing: string;
    /** The tokens between the timing and `on` or `for`, as written, so `or` and unknown events survive. */
    events: string[];
    /** The entity after `on`; `""` when `on` is present with nothing after it. */
    table?: string;
    level?: TriggerLevel;
    /** The token after `for each`, as written, so an unknown level survives to the linter. */
    forEach?: string;
}

/** True when a `@pgTrigger` value opens a header instead of being a bare statement. */
const TRIGGER_HEADER = /^(before|after)\b/;

/** True when a `@pgTrigger` value opens a header rather than being a bare statement. */
export function hasTriggerHeader(value: string): boolean {
    return TRIGGER_HEADER.test(value.trim());
}

/** The header text of a `@pgTrigger` value: up to the colon that opens the statement, never the `:=` of one. */
export function triggerHeaderText(value: string): string {
    const separator = value.search(/:(?=\s|$)/);
    return separator === -1 ? value.trim() : value.slice(0, separator).trim();
}

/** Read a `@pgTrigger` header without judging it; each token is kept as written. */
export function parseTriggerHeader(header: string): TriggerHeader {
    const tokens = header.split(/\s+/).filter((token) => token !== "");
    const onIndex = tokens.indexOf("on");
    const forIndex = tokens.indexOf("for");
    const boundaries = [onIndex, forIndex].filter((index) => index !== -1);
    // Events run from the timing to whichever of `on` and `for` comes first.
    const boundary = boundaries.length === 0 ? tokens.length : Math.min(...boundaries);
    const header2: TriggerHeader = { timing: tokens[0] ?? "", events: tokens.slice(1, boundary) };
    if (onIndex !== -1) {
        header2.table = tokens[onIndex + 1] ?? "";
    }
    const level = tokens[forIndex + 2];
    if (forIndex !== -1) {
        // Keep the token as written: an unknown level is the linter's to report.
        header2.forEach = tokens[forIndex + 1] === "each" ? level ?? "" : tokens[forIndex + 1] ?? "";
        if (tokens[forIndex + 1] === "each" && isTriggerLevel(level)) {
            header2.level = level;
        }
    }
    return header2;
}

/**
 * Split a `@pgTrigger` value into the trigger it declares.
 * Without a header the trigger is the field's own table, `before insert or update`.
 */
export function parseTrigger(value: string): PgTrigger {
    const text = value.trim();
    if (!TRIGGER_HEADER.test(text)) {
        return { timing: "before", events: ["insert", "update"], statement: text };
    }
    const header = triggerHeaderText(text);
    const parsed = parseTriggerHeader(header);
    const trigger: PgTrigger = {
        timing: parsed.timing as TriggerTiming,
        events: TRIGGER_EVENTS.filter((event) => parsed.events.includes(event)),
        statement: header === text ? "" : text.slice(header.length + 1).trim(),
    };
    if (parsed.table !== undefined) {
        trigger.table = parsed.table;
    }
    if (parsed.level !== undefined) {
        trigger.level = parsed.level;
    }
    return trigger;
}

/** The level a trigger runs at: the header's, or the placement's default. See docs/spec-annotations.md. */
export function triggerLevel(trigger: PgTrigger, placement: "field" | "entity"): TriggerLevel {
    return trigger.level ?? (placement === "field" ? "row" : "statement");
}

/** True when a statement assigns a column of the row being written, which only a field-level trigger may do. */
export function assignsColumn(statement: string): boolean {
    return /NEW\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*:=/.test(statement);
}

/** The write operations an operation tag names, de-duplicated and in {@link WRITE_OPERATIONS} order. */
function parseWriteOperations(value: string | undefined): WriteOperation[] {
    const tokens = (value ?? "").split(/\s+/).filter((token) => token !== "");
    return WRITE_OPERATIONS.filter((operation) => tokens.includes(operation));
}

/** The read operations an operation tag names, de-duplicated and in {@link READ_OPERATIONS} order. */
function parseReadOperations(value: string | undefined): ReadOperation[] {
    const tokens = (value ?? "").split(/\s+/).filter((token) => token !== "");
    return READ_OPERATIONS.filter((operation) => tokens.includes(operation));
}

/** Read a `@foreignKey` value: the first token is the entity, each later `key=action` is an option. */
export function parseForeignKey(value: string): ForeignKey {
    const tokens = value.split(/\s+/).filter((token) => token !== "");
    const foreignKey: ForeignKey = { entity: tokens[0] ?? "" };
    for (const token of tokens.slice(1)) {
        const separator = token.indexOf("=");
        if (separator === -1) {
            continue;
        }
        const key = token.slice(0, separator);
        const action = token.slice(separator + 1);
        if (key === "onDelete" && isReferentialAction(action)) {
            foreignKey.onDelete ??= action;
        } else if (key === "onUpdate" && isReferentialAction(action)) {
            foreignKey.onUpdate ??= action;
        }
    }
    return foreignKey;
}

/** Decode the JSDoc tags on a declaration, keeping the tags as written for rules that need them. */
export function readTags(holder: { getJsDocs(): JSDoc[] }): Tags {
    const tags: Tags = {
        written: { all: [], byName: new Map() },
        computed: false,
        createdAt: false,
        updatedAt: false,
        relation: false,
        children: false,
        inlined: false,
        primaryKey: false,
        unique: false,
        pgAutoIncrement: false,
        version: false,
        primitive: false,
        entity: false,
        queryFilter: false,
    };

    for (const doc of holder.getJsDocs()) {
        for (const tag of doc.getTags()) {
            const parsed = specTagOf(tag);
            const name = parsed.name;
            tags.written.all.push(parsed);
            const instances = tags.written.byName.get(name);
            if (instances) {
                instances.push(parsed);
            } else {
                tags.written.byName.set(name, [parsed]);
            }

            const value = parsed.value;
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
                    if (value !== undefined) tags.foreignKey ??= parseForeignKey(value);
                    break;
                case "pgDefault":
                    if (value !== undefined) tags.pgDefault ??= value;
                    break;
                case "pgAutoIncrement":
                    tags.pgAutoIncrement = true;
                    break;
                case "pgTable":
                    if (value !== undefined) tags.pgTable ??= value;
                    break;
                case "entity":
                    tags.entity = true;
                    break;
                case "repository":
                    if (tags.repository === undefined) tags.repository = parseWriteOperations(value);
                    break;
                case "restRepository":
                    if (tags.restRepository === undefined) tags.restRepository = parseWriteOperations(value);
                    break;
                case "queries":
                    if (tags.queries === undefined) tags.queries = parseReadOperations(value);
                    break;
                case "restQueries":
                    if (tags.restQueries === undefined) tags.restQueries = parseReadOperations(value);
                    break;
                case "zod":
                    if (value !== undefined) tags.zod ??= value;
                    break;
                case "pgType":
                    if (value !== undefined) tags.pgType ??= value;
                    break;
                case "queryFilter":
                    tags.queryFilter = true;
                    break;
                case "queryOrderBy": {
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
                case "queryWhere": {
                    // The operators, as written; an empty list is a lint finding rather than an error here.
                    if (tags.queryWhere === undefined) {
                        tags.queryWhere = (value ?? "").split(/\s+/).filter((token) => token !== "");
                    }
                    break;
                }
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
                case "pgVirtual":
                    if (value !== undefined) tags.pgVirtual ??= value;
                    break;
                case "pgTrigger":
                    if (value !== undefined) tags.pgTrigger ??= parseTrigger(value);
                    break;
                default:
                    break;
            }
        }
    }

    return tags;
}

/** Every type alias among the given sources, decoded once so a consumer reads tags rather than walking JSDoc. */
export function collectAliases(project: Project, sourceGlob?: string): Map<string, SpecTypeAlias> {
    const aliases = new Map<string, SpecTypeAlias>();
    const sourceFiles = sourceGlob ? project.getSourceFiles(sourceGlob) : project.getSourceFiles();
    for (const sourceFile of sourceFiles) {
        const filePath = sourceFile.getFilePath();
        for (const declaration of sourceFile.getTypeAliases()) {
            const typeNode = declaration.getTypeNode();
            aliases.set(declaration.getName(), {
                name: declaration.getName(),
                filePath,
                location: locationOf(declaration),
                type: typeNode ? readType(typeNode) : { kind: "missing" },
                typeParameters: declaration.getTypeParameters().map((parameter) => parameter.getText()),
                tags: readTags(declaration),
            });
        }
    }
    return aliases;
}

/** Read a type node into its shape, unwrapping parentheses so a member of a union is inspected as itself. */
export function readType(node: Node): SpecType {
    const parenthesized = node.asKind(SyntaxKind.ParenthesizedType);
    if (parenthesized) {
        return readType(parenthesized.getTypeNode());
    }

    if (node.getKindName().endsWith("Keyword")) {
        return { kind: "keyword", name: node.getText() };
    }

    const array = node.asKind(SyntaxKind.ArrayType);
    if (array) {
        return { kind: "array", element: readType(array.getElementTypeNode()) };
    }

    const reference = node.asKind(SyntaxKind.TypeReference);
    if (reference) {
        return {
            kind: "reference",
            name: reference.getTypeName().getText(),
            arguments: reference.getTypeArguments().map((argument) => argument.getText()),
        };
    }

    const literal = node.asKind(SyntaxKind.LiteralType);
    if (literal) {
        const value = literal.getLiteral();
        if (Node.isStringLiteral(value)) {
            return { kind: "stringLiteral", value: value.getLiteralValue() };
        }
        if (Node.isNumericLiteral(value)) {
            return { kind: "numberLiteral", value: value.getLiteralValue() };
        }
        return { kind: "unknown", text: node.getText() };
    }

    const union = node.asKind(SyntaxKind.UnionType);
    if (union) {
        return { kind: "union", members: union.getTypeNodes().map(readType) };
    }

    const intersection = node.asKind(SyntaxKind.IntersectionType);
    if (intersection) {
        return { kind: "intersection", members: intersection.getTypeNodes().map(readType) };
    }

    const object = node.asKind(SyntaxKind.TypeLiteral);
    if (object) {
        const members: SpecTypeMember[] = [];
        for (const member of object.getMembers()) {
            const property = member.asKind(SyntaxKind.PropertySignature);
            const memberType = property?.getTypeNode();
            if (!property || !memberType) {
                return { kind: "unknown", text: node.getText() };
            }
            members.push({
                name: property.getName(),
                optional: property.hasQuestionToken(),
                type: readType(memberType),
            });
        }
        return { kind: "object", members };
    }

    return { kind: "unknown", text: node.getText() };
}

/** What a type shape denotes: the storage it names, and the JavaScript type its value has at the boundary. */
export interface TypeResolution {
    /** The storage type the shape names, or undefined when it names more than one: a union, an array, an entity. */
    storage: string | undefined;
    /** The JavaScript type the value has, when the node is a scalar this mapping knows. */
    jsType: JsType | undefined;
}

/** A type that names neither a storage type nor a JavaScript type this mapping knows. */
const NOTHING: TypeResolution = { storage: undefined, jsType: undefined };

/** Resolve a type shape through the alias graph; `path` holds the aliases already visited, so a self-referential alias ends. */
export function resolveType(
    type: SpecType,
    aliases: ReadonlyMap<string, SpecTypeAlias>,
    path: Set<string> = new Set(),
): TypeResolution {
    if (type.kind === "keyword") {
        return { storage: DEFAULT_PG_TYPES[type.name], jsType: JS_TYPES[type.name] };
    }

    // A string literal is a closed set of one, which the storage model carries as text plus a CHECK.
    if (type.kind === "stringLiteral") {
        return { storage: undefined, jsType: "string" };
    }

    // An array names a cardinality rather than a storage type, so only its element's JavaScript type carries.
    if (type.kind === "array") {
        return { storage: undefined, jsType: resolveType(type.element, aliases, path).jsType };
    }

    if (type.kind === "reference") {
        const name = type.name;
        // A type the spec names rather than declares: a keyword, `Date`, `Record`.
        if (JS_TYPES[name] || DEFAULT_PG_TYPES[name]) {
            return { storage: DEFAULT_PG_TYPES[name], jsType: JS_TYPES[name] };
        }
        const alias = aliases.get(name);
        if (!alias || path.has(name)) {
            return NOTHING;
        }
        const inherited = resolveType(alias.type, aliases, new Set([...path, name]));
        // A declared storage type wins over the one the alias's own type would name.
        return { ...inherited, storage: alias.tags.pgType ?? inherited.storage };
    }

    // A union names no single storage type; its members' shared JavaScript type is what a value has.
    if (type.kind === "union") {
        const members = type.members.map((member) => resolveType(member, aliases, path).jsType);
        const uniform = members.length > 0 && members.every((member) => member === members[0]);
        return { storage: undefined, jsType: uniform ? members[0] : undefined };
    }

    // An intersection's members are alternatives, so the first one that names either decides.
    if (type.kind === "intersection") {
        for (const member of type.members) {
            const resolved = resolveType(member, aliases, path);
            if (resolved.storage || resolved.jsType) {
                return resolved;
            }
        }
    }

    return NOTHING;
}

/**
 * Fill each alias's `pgType`, so a consumer reads the alias rather than walking its type again.
 * A union, an array, or an entity names more than a storage type, so it stays unresolved. See docs/schema-generation.md.
 */
function fillAliasStorageTypes(aliases: Map<string, SpecTypeAlias>): void {
    for (const alias of aliases.values()) {
        if (alias.tags.pgType) {
            continue;
        }
        const storage = resolveType(alias.type, aliases, new Set([alias.name])).storage;
        if (storage) {
            alias.tags.pgType = storage;
        }
    }
}

/**
 * Parse the spec into entities and aliases.
 * An interface is an entity when it carries `@entity`; one without the tag is a contract, so no
 * directory decides what is generated. Every alias is read, and `@primitive` selects the scalars.
 */
export function parseSpec(project: Project, options: ParseOptions = {}): SpecModel {
    const sourceGlob = options.sourceGlob ?? SPEC_GLOB;
    const interfaces = new Map<string, SpecInterface>();
    const entities: SpecInterface[] = [];
    const nonEntityInterfaces: SpecInterface[] = [];
    const aliases = new Map<string, SpecTypeAlias>();

    for (const [name, alias] of collectAliases(project, sourceGlob)) {
        aliases.set(name, alias);
    }
    fillAliasStorageTypes(aliases);

    for (const sourceFile of project.getSourceFiles(sourceGlob)) {
        const filePath = sourceFile.getFilePath();

        for (const declaration of sourceFile.getInterfaces()) {
            const name = declaration.getName();
            const declarationTags = readTags(declaration);
            const entity: SpecInterface = {
                name,
                pgTableName: declarationTags.pgTable ?? snakeCase(name),
                filePath,
                location: locationOf(declaration),
                importSpecifier: specImportSpecifier(filePath),
                tags: declarationTags,
                properties: declaration.getProperties().map((property) => {
                    const tags = readTags(property);
                    const typeNode = property.getTypeNode();
                    // The primary key is a filter every entity has, so writing the tag on it is
                    // redundant. The linter reports that rather than ignoring it.
                    if (tags.primaryKey) {
                        tags.queryFilter = true;
                    }
                    return {
                        name: property.getName(),
                        optional: property.hasQuestionToken(),
                        typeText: typeNode?.getText() ?? "",
                        type: typeNode ? readType(typeNode) : { kind: "missing" },
                        location: locationOf(property),
                        tags,
                    };
                }),
                repositoryOperations: declarationTags.repository ?? [],
                restRepositoryOperations: declarationTags.restRepository ?? [],
                queries: declarationTags.queries ?? [],
                restQueries: declarationTags.restQueries ?? [],
            };
            if (declarationTags.pgTrigger !== undefined) {
                entity.trigger = declarationTags.pgTrigger;
            }
            if (declarationTags.entity) {
                entities.push(entity);
            } else {
                nonEntityInterfaces.push(entity);
            }
        }
    }

    // Name order, so the generated output depends on what an entity is called rather than on where it sits.
    for (const entity of entities.sort((a, b) => a.name.localeCompare(b.name))) {
        interfaces.set(entity.name, entity);
    }
    nonEntityInterfaces.sort((a, b) => a.name.localeCompare(b.name));

    return { interfaces, nonEntityInterfaces, aliases };
}

/** The tsconfig the generators read, with every spec source added to it. */
export function createSpecProject(): Project {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    project.addSourceFilesAtPaths(SPEC_GLOB);
    return project;
}

/** Parse the spec as the generators see it: the tsconfig's project, then every spec source. */
export function loadSpec(): SpecModel {
    return parseSpec(createSpecProject());
}

/** The in-memory project holds only the files just created, so every source is the spec. */
const IN_MEMORY_GLOB = "**/*.ts";

/** One source of an in-memory spec, at the path its globs are matched against. */
export interface InMemorySpecFile {
    filePath: string;
    sourceFileText: string;
}

/**
 * Parse sources held in memory into the model, for tests and one-off checks such as linting a snippet.
 * A relative path stays relative to the in-memory root, which is how its glob is matched.
 */
export function parseInMemorySpec(files: InMemorySpecFile[], options: ParseOptions = {}): SpecModel {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const file of files) {
        project.createSourceFile(file.filePath, file.sourceFileText);
    }
    return parseSpec(project, {
        sourceGlob: options.sourceGlob ?? IN_MEMORY_GLOB,
    });
}

/** Parse one in-memory source into the model. */
export function parseSpecText(text: string, filePath = "fixture.ts"): SpecModel {
    return parseInMemorySpec([{ filePath, sourceFileText: text }]);
}

/** Test support: run a module of generated TypeScript, so a test asserts its behaviour and not its text. */

/** What a generated module's runtime import resolves to. */
export type ImportResolver = (specifier: string) => unknown;

/** Answers only `modules`, so a generated module that grows a runtime import fails loudly instead of loading a real one. */
export function tsStubImports(modules: Record<string, unknown>): ImportResolver {
    return (specifier) => {
        if (!Object.hasOwn(modules, specifier)) {
            throw new Error(`the module under test imported \`${specifier}\`, which this test does not stub`);
        }
        return modules[specifier];
    };
}

/** Transpiles a generated module to CommonJS and evaluates it with `resolve` standing in for its imports. */
export function tsLoadGeneratedModule<T>(code: string, resolve: ImportResolver): T {
    const js = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    // The generated code writes its exports onto the object it is handed, and reads its imports through `require`.
    new Function("exports", "require", js)(exports, resolve);
    return exports as T;
}
