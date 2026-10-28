/** Check the annotation tags on `spec/` interfaces. See docs/spec-annotations.md. */
import {
    COMPARE_OPERATORS,
    COMPUTED_KINDS,
    FIELD_TAGS,
    FOREIGN_KEY_OPTIONS,
    INTERFACE_TAGS,
    READ_OPERATIONS,
    REFERENTIAL_ACTIONS,
    RETIRED_TAGS,
    TYPE_TAGS,
    WIDGETS,
    WRITE_OPERATIONS,
    isCompareOperator,
    isForeignKeyOption,
    isNullOperator,
    isOrderDirection,
    isReferentialAction,
    loadSpec,
    parseForeignKey,
    parseQueryFilter,
    parseInMemorySpec,
    parseParameters,
    resolveType,
    assignsColumn,
    hasTriggerHeader,
    inheritedDefault,
    parseTrigger,
    parseTriggerHeader,
    triggerHeaderText,
    TRIGGER_EVENTS,
    triggerLevel,
    type ComputedKind,
    type Diagnostic,
    type SpecInterface,
    type SpecModel,
    type SpecProperty,
    type SpecTag,
    type SpecTypeAlias,
    type WrittenTags,
    type TriggerHeader,
} from "./spec-model.ts";
import { selectJsType } from "./pg-types.ts";

export type { Diagnostic };

/** Tags a field may carry. Anything else is rejected, including retired tags. */
const ALLOWED_TAGS = new Set<string>(FIELD_TAGS);

/** Tags an interface may carry. */
const ALLOWED_INTERFACE_TAGS = new Set<string>(INTERFACE_TAGS);

/** Tags a type alias may carry. Anything else is rejected. */
const ALLOWED_TYPE_TAGS = new Set<string>(TYPE_TAGS);

/** Widget hints a field may carry. */
const ALLOWED_WIDGETS = new Set<string>(WIDGETS);

/** The marker tag that identifies an interface as an entity. See docs/spec-annotations.md. */
const ENTITY_TAG = "entity";

/** The marker tag that identifies the tenancy root. See docs/tenancy.md. */
const TENANT_TAG = "tenant";

/** The tag that names the column scoping an interface, such as `@tenantOwned tenantId`. See docs/tenancy.md. */
const TENANT_OWNED_TAG = "tenantOwned";

/** The marker tag that identifies a primitive type alias. See docs/primitives.md. */
const PRIMITIVE_TAG = "primitive";

/** The tag that carries a type's Zod schema expression, e.g. `z.uuidv7().brand<"InvoiceId">`. */
const ZOD_TAG = "zod";

/** The tag that carries a type's storage-layer type, e.g. `uuid`. */
const PG_TYPE_TAG = "pgType";

/** Check the tags on a type alias: `@primitive`, `@zod`, and `@pgType`, resolving its type through `aliases`. */
function lintTypeAlias(
    alias: SpecTypeAlias,
    findings: Diagnostic[],
    aliases: ReadonlyMap<string, SpecTypeAlias>,
): void {
    const name = alias.name;
    const filePath = alias.location.filePath;
    const tags = alias.tags.written.byName;
    const report = (message: string, tag: SpecTag) => {
        findings.push({ filePath, line: tag.line, message: `\`${name}\`: ${message}` });
    };

    for (const [tagName, instances] of tags) {
        if (!ALLOWED_TYPE_TAGS.has(tagName)) {
            for (const tag of instances) {
                report(`@${tagName} is not a recognised type tag`, tag);
            }
        }
        if (instances.length > 1) {
            for (const tag of instances) {
                report(`@${tagName} appears more than once`, tag);
            }
        }
    }

    // @primitive is a bare marker; its type must carry the matching @zod schema and @pgType storage type.
    const primitiveTag = (tags.get(PRIMITIVE_TAG) ?? [])[0];
    const zodTag = (tags.get(ZOD_TAG) ?? [])[0];
    const pgTypeTag = (tags.get(PG_TYPE_TAG) ?? [])[0];
    if (primitiveTag && (primitiveTag.value ?? "")) {
        report(`@${PRIMITIVE_TAG} takes no value`, primitiveTag);
    }
    if (zodTag && !(zodTag.value ?? "")) {
        report(`@${ZOD_TAG} is missing its schema expression`, zodTag);
    }
    if (pgTypeTag && !(pgTypeTag.value ?? "")) {
        report(`@${PG_TYPE_TAG} is missing its storage type`, pgTypeTag);
    }
    if (primitiveTag && !zodTag) {
        report(`@${PRIMITIVE_TAG} requires @${ZOD_TAG}`, primitiveTag);
    }
    if (primitiveTag && !pgTypeTag) {
        report(`@${PRIMITIVE_TAG} requires @${PG_TYPE_TAG}`, primitiveTag);
    }

    // The tag names storage; the alias's own type decides whether that is truthful, since nothing else ties the two.
    const declared = pgTypeTag?.value;
    if (pgTypeTag && declared) {
        const select = selectJsType(declared);
        const actual = resolveType(alias.type, aliases, new Set([name])).jsType;
        if (!select) {
            report(`@${PG_TYPE_TAG} \`${declared}\` is not a Postgres type the mapping knows`, pgTypeTag);
        } else if (actual && actual !== select) {
            report(
                `@${PG_TYPE_TAG} \`${declared}\` selects as a \`${select}\`, but the alias is a \`${actual}\``,
                pgTypeTag,
            );
        }
    }
}

/** True when a property carries `@version`. */
function hasVersionTag(property: SpecProperty): boolean {
    return property.tags.written.byName.has("version");
}

/** Report tags written on an interface's own doc that no interface may carry, whether retired or unknown. */
function lintInterfaceTags(spec: SpecInterface, findings: Diagnostic[]): void {
    for (const tag of spec.tags.written.all) {
        if (ALLOWED_INTERFACE_TAGS.has(tag.name)) {
            continue;
        }
        const retired = RETIRED_TAGS.get(tag.name);
        findings.push({
            filePath: spec.location.filePath,
            line: tag.line,
            message: retired
                ? `\`${spec.name}\`: @${tag.name} is retired; ${retired}`
                : `\`${spec.name}\`: @${tag.name} is not a recognised interface tag`,
        });
    }
}

/** Check an interface without `@entity`: an entity tag on it is a forgotten marker, reported rather than ignored. */
function lintContract(spec: SpecInterface, findings: Diagnostic[]): void {
    lintInterfaceTags(spec, findings);
    const entityTag = spec.tags.written.all.find(
        (tag) => tag.name !== ENTITY_TAG && ALLOWED_INTERFACE_TAGS.has(tag.name),
    );
    if (entityTag) {
        findings.push({
            filePath: spec.location.filePath,
            line: entityTag.line,
            message: `\`${spec.name}\`: @${entityTag.name} is an entity tag, so the interface needs @${ENTITY_TAG}`,
        });
    }
}

/** Check each `@operation` method: its markers, its contract's type parameters, and its `@throws` entries. See docs/operations.md. */
function lintOperations(spec: SpecModel, findings: Diagnostic[]): void {
    for (const operation of spec.operations) {
        const report = (message: string, line = operation.location.line) => {
            findings.push({ filePath: operation.location.filePath, line, message: `\`${operation.name}\`: ${message}` });
        };
        if (!operation.operation) {
            report("@restOperation requires @operation");
        }
        if (spec.interfaces.has(operation.interfaceName)) {
            report("@operation belongs on a contract interface, not on an @entity");
        }
        if (operation.interfaceTypeParameters.length > 1) {
            report("an operation contract takes at most one type parameter, the context");
        }
        if (operation.parameters.length === 0) {
            report("an operation takes the context as its first parameter");
        }
        if (operation.rest) {
            if (operation.restMethod === undefined) {
                report("@restOperation names the verb and the path, as `@restOperation POST /invoice/send`");
            }
            if (operation.restPath === undefined) {
                report("@restOperation names a path beginning with `/`");
            }
            // The wire carries at most one argument, so a REST operation is the context and optionally one input.
            if (operation.parameters.length > 2) {
                report("a @restOperation takes the context and at most one input parameter");
            }
        }
        for (const thrown of operation.throws) {
            if (thrown.name === "") {
                report("@throws names the error class, as `@throws {InvoiceDetailsError} why`", thrown.location.line);
            } else if (thrown.reason === "") {
                report(`@throws {${thrown.name}} needs a reason`, thrown.location.line);
            }
        }
    }
}

/** `@tenant` marks the root; `@tenantOwned <field>` names the column scoping an interface. See docs/tenancy.md. */
function lintTenancyTags(spec: SpecInterface, report: Report): void {
    for (const tag of spec.tags.written.byName.get(TENANT_TAG) ?? []) {
        if (tag.value !== undefined) {
            report(`@${TENANT_TAG} takes no value`, tag);
        }
    }

    // The column is named rather than left to a convention, so a bare marker says nothing.
    const ownedTags = spec.tags.written.byName.get(TENANT_OWNED_TAG) ?? [];
    for (const tag of ownedTags) {
        if (!(tag.value ?? "").trim()) {
            report(`@${TENANT_OWNED_TAG} names the column that scopes the interface, such as \`@${TENANT_OWNED_TAG} tenantId\``, tag);
        }
    }

    // The root is what everything else is scoped by, so it cannot be scoped itself.
    if (spec.tags.tenant && ownedTags[0]) {
        report(`@${TENANT_TAG} and @${TENANT_OWNED_TAG} are mutually exclusive: the root is not owned`, ownedTags[0]);
    }
}

/** Check the tags on the interface itself, and the per-entity uniqueness rules. */
function lintEntity(
    spec: SpecInterface,
    findings: Diagnostic[],
): void {
    const name = spec.name;
    const filePath = spec.location.filePath;
    lintInterfaceTags(spec, findings);

    // @entity is a bare marker, so a value is a mistake; the tag still marks the interface either way.
    for (const tag of spec.tags.written.byName.get(ENTITY_TAG) ?? []) {
        if (tag.value !== undefined) {
            findings.push({ filePath, line: tag.line, message: `\`${name}\`: @${ENTITY_TAG} takes no value` });
        }
    }

    // An entity has at most one optimistic-lock column.
    const versioned = spec.properties.filter(hasVersionTag);
    for (const property of versioned.slice(1)) {
        findings.push({
            filePath,
            line: property.location.line,
            message: `\`${name}\`: @version may appear on at most one field`,
        });
    }

    // The interface-level tag is checked against the declaration, not against a field.
    const interfaceReport: Report = (message, tag) => {
        findings.push({
            filePath,
            line: tag?.line ?? spec.location.line,
            message: `\`${name}\`: ${message}`,
        });
    };
    lintEntityTrigger(spec.tags.written, interfaceReport);
    lintTenancyTags(spec, interfaceReport);

    // An entity records one creation moment and one last-write moment.
    for (const clock of ["createdAt", "updatedAt"] as const) {
        const clocked = spec.properties.filter((property) => property.tags[clock]);
        for (const property of clocked.slice(1)) {
            findings.push({
                filePath,
                line: property.location.line,
                message: `\`${name}\`: @${clock} may appear on at most one field`,
            });
        }
    }

    // At most one ordering field may declare the entity default; otherwise it is ambiguous.
    const defaultOrdered = spec.properties.filter(
        (property) => property.tags.queryOrderBy?.default !== undefined,
    );
    for (const property of defaultOrdered.slice(1)) {
        findings.push({
            filePath,
            line: property.location.line,
            message: `\`${name}\`: @queryOrderBy default may appear on at most one field`,
        });
    }

    // A scoped reference names a required field here; the target's half is checked when the tables are built. See docs/tenancy.md.
    for (const property of spec.properties) {
        const scope = property.tags.foreignKey?.scope;
        if (scope === undefined) {
            continue;
        }
        const scoped = spec.properties.find((candidate) => candidate.name === scope);
        const tag = (property.tags.written.byName.get("foreignKey") ?? [])[0];
        const line = tag?.line ?? property.location.line;
        if (scoped === undefined) {
            findings.push({
                filePath,
                line,
                message: `\`${property.name}\`: @foreignKey scope=\`${scope}\` is not a field of this interface`,
            });
        } else if (scoped.optional && scoped.name !== property.name) {
            findings.push({
                filePath,
                line,
                message: `\`${property.name}\`: @foreignKey scope=\`${scope}\` must be a required field, because a nullable scope skips the check`,
            });
        }
    }
}

/** Report a finding on the field under lint, at the tag's line or the field's. */
type Report = (message: string, tag?: SpecTag) => void;

/** An operation list tag: the name, the operations it may name, and whether every entity must carry it. */
interface OperationTag {
    name: string;
    vocabulary: readonly string[];
    required: boolean;
}

/** The four surface tags, in the order their findings are reported. */
const SURFACE_TAGS: OperationTag[] = [
    { name: "repository", vocabulary: WRITE_OPERATIONS, required: true },
    { name: "restRepository", vocabulary: WRITE_OPERATIONS, required: false },
    { name: "queries", vocabulary: READ_OPERATIONS, required: false },
    { name: "restQueries", vocabulary: READ_OPERATIONS, required: false },
];

/** The exposed tag of each pair, paired with the tag that declares what it may expose. */
const EXPOSED_BY: [string, string][] = [
    ["restRepository", "repository"],
    ["restQueries", "queries"],
];

/** An entity declares its surface: the operations it generates, and the subset it exposes. */
function lintSurfaceTags(spec: SpecInterface, report: Report): void {
    const byName = spec.tags.written.byName;
    const declared = new Map<string, Set<string>>();
    for (const { name, vocabulary, required } of SURFACE_TAGS) {
        const tags = byName.get(name) ?? [];
        for (const duplicate of tags.slice(1)) {
            report(`@${name} appears more than once`, duplicate);
        }
        const tag = tags[0];
        if (!tag) {
            if (required) {
                report(`missing @${name}, naming at least one of: ${vocabulary.join(", ")}`);
            }
            continue;
        }
        const tokens = (tag.value ?? "").split(/\s+/).filter((token) => token !== "");
        if (tokens.length === 0) {
            report(`@${name} requires at least one of: ${vocabulary.join(", ")}`, tag);
        }
        const named = new Set<string>();
        for (const token of tokens) {
            if (!vocabulary.includes(token)) {
                report(`@${name} \`${token}\` is not one of: ${vocabulary.join(", ")}`, tag);
            } else if (named.has(token)) {
                report(`@${name} names \`${token}\` twice`, tag);
            } else {
                named.add(token);
            }
        }
        declared.set(name, named);
    }

    // The wire cannot serve an operation the entity does not generate, so the exposed set is a subset.
    for (const [exposed, declaredBy] of EXPOSED_BY) {
        const exposedSet = declared.get(exposed);
        const declaredSet = declared.get(declaredBy) ?? new Set<string>();
        if (!exposedSet) {
            continue;
        }
        const tag = (byName.get(exposed) ?? [])[0];
        for (const operation of exposedSet) {
            if (!declaredSet.has(operation)) {
                report(`@${exposed} \`${operation}\` is not in @${declaredBy}`, tag);
            }
        }
    }
}

/** A branch marker on an entity-typed field: `@relation`, `@children`, or `@inlined`. */
interface BranchTag {
    name: string;
    tag: SpecTag;
}

/** The tags and type shape one field's rules share, resolved once so no rule walks the map itself. */
interface FieldTags {
    /** Every occurrence, keyed by name, for the vocabulary rules. */
    byName: Map<string, SpecTag[]>;
    fieldName: SpecTag | undefined;
    widget: SpecTag | undefined;
    computed: SpecTag | undefined;
    /** The `@computed` mechanism tags present, in `COMPUTED_KINDS` order. */
    mechanism: { name: ComputedKind; tag: SpecTag }[];
    trigger: SpecTag | undefined;
    createdAt: SpecTag | undefined;
    updatedAt: SpecTag | undefined;
    deletedAt: SpecTag | undefined;
    pgDefault: SpecTag | undefined;
    /** The default the field's type supplies through an alias, before any field tag. */
    inheritedDefault: string | undefined;
    /** The default the column gets: the field's tag, else the inherited one; undefined when the field clears it. */
    effectiveDefault: string | undefined;
    pgAutoIncrement: SpecTag | undefined;
    branches: BranchTag[];
    primaryKey: SpecTag | undefined;
    foreignKey: SpecTag | undefined;
    queryFilter: SpecTag | undefined;
    version: SpecTag | undefined;
    queryOrderBy: SpecTag | undefined;
    queryWhere: SpecTag | undefined;
    /** The field type as written, e.g. `Date` or `InvoiceRow[]`. */
    typeText: string | undefined;
    isArray: boolean;
    /** True when the field is written `?`. See docs/optionality.md. */
    optional: boolean;
}

/** Resolve the tags a field's rules share: the first occurrence of each, plus the type shape. */
function resolveFieldTags(
    property: SpecProperty,
    aliases: ReadonlyMap<string, SpecTypeAlias>,
): FieldTags {
    const byName = property.tags.written.byName;
    const first = (name: string) => (byName.get(name) ?? [])[0];
    const branch = (name: string): BranchTag[] => {
        const tag = first(name);
        return tag ? [{ name, tag }] : [];
    };
    return {
        byName,
        fieldName: first("fieldName"),
        widget: first("widget"),
        computed: first("computed"),
        mechanism: COMPUTED_KINDS.map((name) => ({ name, tag: first(name) })).filter(
            (entry): entry is { name: ComputedKind; tag: SpecTag } => entry.tag !== undefined,
        ),
        trigger: first("pgTrigger"),
        createdAt: first("createdAt"),
        updatedAt: first("updatedAt"),
        deletedAt: first("deletedAt"),
        pgDefault: first("pgDefault"),
        inheritedDefault: first("foreignKey") === undefined ? inheritedDefault(property.type, aliases) : undefined,
        effectiveDefault: property.tags.pgDefault,
        pgAutoIncrement: first("pgAutoIncrement"),
        branches: [...branch("relation"), ...branch("children"), ...branch("inlined")],
        primaryKey: first("primaryKey"),
        foreignKey: first("foreignKey"),
        queryFilter: first("queryFilter"),
        version: first("version"),
        queryOrderBy: first("queryOrderBy"),
        queryWhere: first("queryWhere"),
        typeText: property.type.kind === "missing" ? undefined : property.typeText,
        isArray: property.type.kind === "array",
        optional: property.optional,
    };
}

/** Every tag is recognised, and a retired one names its replacement. */
function lintKnownTags(tags: FieldTags, report: Report): void {
    for (const [name, instances] of tags.byName) {
        if (ALLOWED_TAGS.has(name)) {
            continue;
        }
        const retired = RETIRED_TAGS.get(name);
        for (const tag of instances) {
            report(retired ? `@${name} is retired; ${retired}` : `@${name} is not a recognised tag`, tag);
        }
    }
}

/** No tag appears twice. */
function lintDuplicateTags(tags: FieldTags, report: Report): void {
    for (const [name, instances] of tags.byName) {
        if (instances.length > 1) {
            for (const tag of instances) {
                report(`@${name} appears more than once`, tag);
            }
        }
    }
}

/** `@fieldName` is required and non-empty. */
function lintFieldName(tags: FieldTags, report: Report): void {
    if (!tags.fieldName) {
        report("missing @fieldName");
    } else if (!(tags.fieldName.value ?? "")) {
        report("@fieldName is empty", tags.fieldName);
    }
}

/** `@widget` is required and names a known control. */
function lintWidget(tags: FieldTags, report: Report): void {
    if (!tags.widget) {
        report("missing @widget");
        return;
    }
    const widget = tags.widget.value ?? "";
    if (!ALLOWED_WIDGETS.has(widget)) {
        report(`@widget \`${widget}\` is not one of: ${[...ALLOWED_WIDGETS].join(", ")}`, tags.widget);
    }
}

/** `@computed` takes no parameters; the expression sits in the mechanism tag beside it. */
function lintOwnership(tags: FieldTags, report: Report): void {
    const tag = tags.computed;
    if (!tag) {
        return;
    }
    const parameters = parseParameters(tag);
    if (parameters.size > 0) {
        report(
            `@computed takes no parameters, found: ${[...parameters.keys()].map((key) => `${key}=`).join(", ")}`,
            tag,
        );
    }
}

/** A `@computed` field names one mechanism, with an expression. See docs/spec-annotations.md. */
function lintComputedMechanism(tags: FieldTags, report: Report): void {
    for (const { name, tag } of tags.mechanism) {
        if (!(tag.value ?? "")) {
            report(`@${name} is missing its expression`, tag);
        }
        if (!tags.computed) {
            report(`@${name} requires @computed`, tag);
        }
    }
    const first = tags.mechanism[0];
    if (first) {
        for (const current of tags.mechanism.slice(1)) {
            report(`@${first.name} and @${current.name} are mutually exclusive`, current.tag);
        }
    }
}

/** The header rules both placements share: the events, and the level when the header names one. */
function lintTriggerHeader(tag: SpecTag, parsed: TriggerHeader, report: Report): void {
    for (const token of parsed.events) {
        if (token !== "or" && !(TRIGGER_EVENTS as readonly string[]).includes(token)) {
            report(`@pgTrigger event \`${token}\` is not one of: ${TRIGGER_EVENTS.join(", ")}`, tag);
        }
    }
    if (!parsed.events.some((token) => (TRIGGER_EVENTS as readonly string[]).includes(token))) {
        report(`@pgTrigger header needs at least one event: ${TRIGGER_EVENTS.join(", ")}`, tag);
    }
    if (parsed.forEach !== undefined && parsed.level === undefined) {
        report("@pgTrigger level reads `for each row` or `for each statement`", tag);
    }
}

/** `@pgTrigger` is a statement, optionally behind a header naming the trigger. See docs/spec-annotations.md. */
function lintTrigger(tags: FieldTags, report: Report): void {
    const tag = tags.trigger;
    if (!tag) {
        return;
    }
    const text = tag.value ?? "";
    // A bare statement is the field's own table, before insert or update; its text is checked above.
    if (!hasTriggerHeader(text)) {
        if (/^instead\s+of\b/.test(text)) {
            report("@pgTrigger cannot be `instead of`, which is a trigger on a view, and the spec has no views", tag);
        } else if (/^on\b/.test(text)) {
            report("@pgTrigger header starts with its timing: `before insert or update on <Entity>: …`", tag);
        }
        return;
    }
    if (triggerHeaderText(text) === text) {
        report("@pgTrigger header needs `: <statement>`, such as `after insert on InvoiceRow: …`", tag);
        return;
    }
    if (!text.slice(triggerHeaderText(text).length + 1).trim()) {
        report("@pgTrigger is missing its statement", tag);
    }
    const parsed = parseTriggerHeader(triggerHeaderText(text));
    if (parsed.table === "") {
        report("@pgTrigger `on` is missing the entity it attaches to", tag);
    }
    lintTriggerHeader(tag, parsed, report);
    // A statement-level trigger cannot assign a column, so a field's trigger is always row-level.
    if (triggerLevel(parseTrigger(text), "field") === "statement") {
        report("@pgTrigger on a field runs `for each row`; a statement-level trigger belongs on the interface", tag);
    }
}

/** An interface-level `@pgTrigger` runs for the table, so it can neither assign a column nor name one. */
function lintEntityTrigger(tags: WrittenTags, report: Report): void {
    const tag = tags.byName.get("pgTrigger")?.[0];
    if (!tag) {
        return;
    }
    const text = tag.value ?? "";
    const trigger = parseTrigger(text);
    // A bare statement is a legitimate interface-level trigger; only `on` is out of place there.
    if (hasTriggerHeader(text)) {
        lintTriggerHeader(tag, parseTriggerHeader(triggerHeaderText(text)), report);
    }
    if (trigger.table !== undefined) {
        report("@pgTrigger on an interface is already attached to its own table; `on` is for a field", tag);
    }
    if (!trigger.statement) {
        report("@pgTrigger is missing its statement", tag);
    }
    if (assignsColumn(trigger.statement)) {
        report("@pgTrigger on an interface cannot assign a column; move it to the field with @computed", tag);
    }
}

/** The clock tags are self-contained and exclusive of each other. See docs/timestamps.md. */
function lintClocks(tags: FieldTags, report: Report): void {
    const clocks: [string, SpecTag | undefined][] = [
        ["createdAt", tags.createdAt],
        ["updatedAt", tags.updatedAt],
    ];
    for (const [name, tag] of clocks) {
        if (!tag) {
            continue;
        }
        if ((tag.value ?? "")) {
            report(`@${name} takes no value`, tag);
        }
        if (tags.computed) {
            report(`@${name} and @computed are mutually exclusive`, tag);
        }
        if (tags.pgDefault) {
            report(`@${name} supplies its own default; drop @pgDefault`, tag);
        }
        for (const { name: mechanism } of tags.mechanism) {
            report(`@${name} and @${mechanism} are mutually exclusive`, tag);
        }
        if (tags.typeText !== "Date") {
            report(`@${name} must be on a \`Date\` field, found \`${tags.typeText ?? "unknown"}\``, tag);
        }
    }
    if (tags.createdAt && tags.updatedAt) {
        report("@createdAt and @updatedAt are mutually exclusive", tags.updatedAt);
    }
}

/** `@deletedAt` marks a row's deletion moment; it changes no generation, so the whole rule is its shape. See docs/soft-delete.md. */
function lintDeletedAt(tags: FieldTags, report: Report): void {
    const tag = tags.deletedAt;
    if (!tag) {
        return;
    }
    if ((tag.value ?? "")) {
        report("@deletedAt takes no value", tag);
    }
    reportIfBranch(tags, tag, report);
    // A branch is not a column, so the rest of the shape does not apply to it.
    if (tags.branches.length > 0) {
        return;
    }
    if (tags.typeText !== "Date") {
        report(`@deletedAt must be on a \`Date\` field, found \`${tags.typeText ?? "unknown"}\``, tag);
    }
    // A live row has no deletion moment, so the column is nullable and the field optional.
    if (!tags.optional) {
        report("@deletedAt is null while the row is live, so the field must be optional; add the `?`", tag);
    }
    // The hiding of deleted rows is the filter's default, not this marker's, so the field has to carry it.
    if (parseQueryFilter(tags.queryFilter?.value).default?.kind !== "isNull") {
        report("@deletedAt needs @queryFilter default=isNull on the same field, so a read hides deleted rows", tag);
    }
}

/** `@pgDefault` carries the expression the database applies when the column is omitted. */
function lintDefaultTag(tags: FieldTags, report: Report): void {
    const tag = tags.pgDefault;
    if (!tag) {
        return;
    }
    // An empty tag clears the default the field's type supplies; with nothing to clear it says nothing.
    if (!(tag.value ?? "").trim() && tags.inheritedDefault === undefined) {
        report("@pgDefault is missing its expression", tag);
    }
}

/** `@pgAutoIncrement` makes the column an identity column, which the database fills and a create reads back. */
function lintAutoIncrement(tags: FieldTags, report: Report): void {
    const tag = tags.pgAutoIncrement;
    if (!tag) {
        return;
    }
    if ((tag.value ?? "")) {
        report("@pgAutoIncrement takes no value", tag);
    }
    reportIfBranch(tags, tag, report);
    if (tags.isArray) {
        report("@pgAutoIncrement must be on a single field, not an array", tag);
    }
    // The value a create reads back is the key it left to the database, so the tag belongs on the key alone.
    if (!tags.primaryKey) {
        report("@pgAutoIncrement must be on a @primaryKey field", tag);
    }
    // Every one of these also owns the column's insert value, and two owners cannot agree.
    for (const [name, owner] of [
        ["computed", tags.computed],
        ["pgDefault", tags.pgDefault ?? (tags.effectiveDefault !== undefined ? tag : undefined)],
        ["version", tags.version],
        ["createdAt", tags.createdAt],
        ["updatedAt", tags.updatedAt],
    ] as const) {
        if (owner) {
            report(`@pgAutoIncrement and @${name} are mutually exclusive`, tag);
        }
    }
}

/** A scalar-only tag may not sit on a branch field. */
function reportIfBranch(tags: FieldTags, tag: SpecTag, report: Report): void {
    const branch = tags.branches[0];
    if (branch) {
        report(`@${tag.name} must be on a scalar field, not a @${branch.name} field`, tag);
    }
}

/** The branch markers are bare, mutually exclusive, and match the field's cardinality. */
function lintBranches(tags: FieldTags, report: Report): void {
    for (const { name, tag } of tags.branches) {
        if ((tag.value ?? "")) {
            report(`@${name} takes no value; the entity comes from the field type`, tag);
        }
    }
    const first = tags.branches[0];
    if (first) {
        for (const current of tags.branches.slice(1)) {
            report(`@${first.name} and @${current.name} are mutually exclusive`, current.tag);
        }
    }
    for (const { name, tag } of tags.branches) {
        if (name === "children") {
            if (!tags.isArray) {
                report("@children must be on an array field, such as `rows?: InvoiceRow[]`", tag);
            }
        } else if (tags.isArray) {
            report(`@${name} must be on a single entity field, not an array`, tag);
        }
    }
}

/** `@primaryKey` and `@foreignKey` say what a column is; both sit on a single scalar field. */
function lintKeyTags(tags: FieldTags, report: Report): void {
    if (tags.primaryKey) {
        if ((tags.primaryKey.value ?? "")) {
            report("@primaryKey takes no value", tags.primaryKey);
        }
        reportIfBranch(tags, tags.primaryKey, report);
        if (tags.isArray) {
            report("@primaryKey must be on a single field, not an array", tags.primaryKey);
        }
    }
    if (tags.foreignKey) {
        lintForeignKey(tags.foreignKey, report);
        reportIfBranch(tags, tags.foreignKey, report);
        if (tags.isArray) {
            report("@foreignKey must be on a single field, not an array", tags.foreignKey);
        }
    }
    if (tags.primaryKey && tags.foreignKey) {
        report("@primaryKey and @foreignKey are mutually exclusive", tags.foreignKey);
    }
}

/** `@foreignKey <Entity> [key=value]…`: the interface it references, then its referential actions and scope. */
function lintForeignKey(tag: SpecTag, report: Report): void {
    const tokens = (tag.value ?? "").split(/\s+/).filter((token) => token !== "");
    const entity = tokens[0];
    if (entity === undefined) {
        report(
            "@foreignKey is missing the interface it references, such as `@foreignKey Customer`",
            tag,
        );
        return;
    }
    if (entity.includes("=")) {
        report(`@foreignKey needs the interface it references before its options, found \`${entity}\``, tag);
        return;
    }
    const seen = new Set<string>();
    const actions = new Map<string, string>();
    for (const token of tokens.slice(1)) {
        const separator = token.indexOf("=");
        if (separator === -1) {
            report(
                `@foreignKey option \`${token}\` must be written \`key=value\`, such as \`onDelete=cascade\``,
                tag,
            );
            continue;
        }
        const key = token.slice(0, separator);
        const action = token.slice(separator + 1);
        if (!isForeignKeyOption(key)) {
            report(`@foreignKey option \`${key}\` is not one of: ${FOREIGN_KEY_OPTIONS.join(", ")}`, tag);
            continue;
        }
        if (seen.has(key)) {
            report(`@foreignKey ${key} appears more than once`, tag);
        }
        seen.add(key);
        // `scope` names a field rather than a referential action, so it is checked by its own rule.
        if (key === "scope") {
            if (action === "") {
                report("@foreignKey scope must name a field, such as `scope=tenantId`", tag);
            }
            continue;
        }
        if (!isReferentialAction(action)) {
            report(`@foreignKey ${key} \`${action}\` is not one of: ${REFERENTIAL_ACTIONS.join(", ")}`, tag);
            continue;
        }
        actions.set(key, action);
    }

    // A scoped reference matches the scope column too, so `set null` would null a required column. See docs/tenancy.md.
    const scope = parseForeignKey(tag.value ?? "").scope;
    if (scope !== undefined && actions.get("onDelete") === "setNull") {
        report("@foreignKey scope cannot combine with onDelete=setNull, which would null the scope column", tag);
    }
}

/** `@queryFilter` makes a scalar column a filter; `required` forces it and `default=<value>` fills it in. */
function lintQueryFilter(tags: FieldTags, report: Report): void {
    const tag = tags.queryFilter;
    if (!tag) {
        return;
    }
    reportIfBranch(tags, tag, report);
    const parsed = parseQueryFilter(tag.value);
    for (const token of parsed.unknown) {
        report(`@queryFilter takes no value, \`required\`, or \`default=<value>\`, found \`${token}\``, tag);
    }
    if (parsed.nullSpelling) {
        report("@queryFilter spells a null default `default=isNull`, not `default=null`", tag);
    }
    if (parsed.emptyDefault) {
        report("@queryFilter default= needs a value: `isNull`, `isNotNull`, a boolean, a number, or a string", tag);
    }
    // A null test reads a nullable column; on a not-null one it would match every row or none.
    if ((parsed.default?.kind === "isNull" || parsed.default?.kind === "isNotNull") && !tags.optional) {
        report(`@queryFilter default=${parsed.default.kind} needs an optional field, whose column is nullable`, tag);
    }
    // A required filter is always named, so its default would never apply.
    if (parsed.required && parsed.default !== undefined) {
        report("@queryFilter cannot be both `required` and defaulted", tag);
    }
    // The primary key is an optional filter already (spec-model defaults it), so only `required` adds anything.
    if (tags.primaryKey && !parsed.required) {
        report("the primary key is a filter by default; drop @queryFilter, or write `required`", tag);
    }
}

/** `@version` marks the optimistic-lock column. See docs/versioning.md. */
function lintVersion(tags: FieldTags, report: Report): void {
    const tag = tags.version;
    if (!tag) {
        return;
    }
    if (tags.computed) {
        report("@version and @computed are mutually exclusive", tag);
    }
    if (tags.createdAt) {
        report("@version and @createdAt are mutually exclusive", tag);
    }
    if (tags.updatedAt) {
        report("@version and @updatedAt are mutually exclusive", tag);
    }
    if (tags.typeText !== "Version") {
        report(`@version must be on a \`Version\` field, found \`${tags.typeText ?? "unknown"}\``, tag);
    }
}

/** A tag that makes its column `not null` may not sit on an optional field, or the field lies about the read. See docs/optionality.md. */
function lintForcedNotNull(tags: FieldTags, report: Report): void {
    if (!tags.optional) {
        return;
    }
    // One finding per field, in this order: a `@version` field carries its own `@pgDefault`, and the fix is the same for both.
    const forced: [string, SpecTag | undefined][] = [
        ["primaryKey", tags.primaryKey],
        ["createdAt", tags.createdAt],
        ["updatedAt", tags.updatedAt],
        ["version", tags.version],
        ["pgDefault", tags.pgDefault],
        ["pgAutoIncrement", tags.pgAutoIncrement],
    ];
    for (const [name, tag] of forced) {
        if (tag) {
            report(`@${name} makes its column \`not null\`, so the field is required; drop the \`?\``, tag);
            return;
        }
    }
    // A default the field's type supplies makes the column `not null` just as a written tag does.
    if (tags.effectiveDefault !== undefined) {
        report("its type's @pgDefault makes its column `not null`, so the field is required; drop the `?`");
    }
}

/** `@queryOrderBy` whitelists an ordering key; `default asc|desc` also names the default. */
function lintQueryOrderBy(tags: FieldTags, report: Report): void {
    const tag = tags.queryOrderBy;
    if (!tag) {
        return;
    }
    const text = tag.value ?? "";
    if (text !== "") {
        const tokens = text.split(/\s+/);
        const isDefault = tokens.length === 2 && tokens[0] === "default" && isOrderDirection(tokens[1]);
        if (!isDefault) {
            report(`@queryOrderBy takes no value or \`default asc|desc\`, found \`${text}\``, tag);
        }
    }
    reportIfBranch(tags, tag, report);
}

/** `@queryWhere` whitelists the comparison operators a field may be narrowed with. See docs/queries.md. */
function lintWhere(tags: FieldTags, report: Report): void {
    const tag = tags.queryWhere;
    if (!tag) {
        return;
    }
    const tokens = (tag.value ?? "").split(/\s+/).filter((token) => token !== "");
    if (tokens.length === 0) {
        report(`@queryWhere requires at least one operator, one of: ${COMPARE_OPERATORS.join(", ")}`, tag);
    }
    for (const token of tokens) {
        if (!isCompareOperator(token)) {
            report(`@queryWhere \`${token}\` is not one of: ${COMPARE_OPERATORS.join(", ")}`, tag);
        }
    }
    // A not-null column never matches `is null` and always matches `is not null`, so neither is a query.
    const nullTest = tokens.find((token) => isNullOperator(token));
    if (nullTest !== undefined && !tags.optional) {
        report(`@queryWhere \`${nullTest}\` needs an optional field, whose column is nullable`, tag);
    }
    reportIfBranch(tags, tag, report);
}

/** Check one field: its tag vocabulary, then each tag family's rules. */
function lintProperty(
    property: SpecProperty,
    aliases: ReadonlyMap<string, SpecTypeAlias>,
    findings: Diagnostic[],
): void {
    const fieldName = property.name;
    const filePath = property.location.filePath;
    const report: Report = (message, tag) => {
        findings.push({ filePath, line: tag?.line ?? property.location.line, message: `\`${fieldName}\`: ${message}` });
    };

    const tags = resolveFieldTags(property, aliases);

    // The call order is the order the findings are emitted in.
    lintKnownTags(tags, report);
    lintDuplicateTags(tags, report);
    lintFieldName(tags, report);
    lintWidget(tags, report);
    lintOwnership(tags, report);
    lintComputedMechanism(tags, report);
    lintTrigger(tags, report);
    lintClocks(tags, report);
    lintDeletedAt(tags, report);
    lintDefaultTag(tags, report);
    lintAutoIncrement(tags, report);
    lintBranches(tags, report);
    lintKeyTags(tags, report);
    lintQueryFilter(tags, report);
    lintVersion(tags, report);
    lintForcedNotNull(tags, report);
    lintQueryOrderBy(tags, report);
    lintWhere(tags, report);
}

/** Lint each field of an entity. */
function lintFields(
    spec: SpecInterface,
    aliases: ReadonlyMap<string, SpecTypeAlias>,
    findings: Diagnostic[],
): void {
    for (const property of spec.properties) {
        lintProperty(property, aliases, findings);
    }
}

/** Lint an entity's surface tags: the operations it generates, and the subset it exposes. */
function lintSurface(spec: SpecInterface, findings: Diagnostic[]): void {
    lintSurfaceTags(spec, (message, tag) => {
        findings.push({
            filePath: spec.location.filePath,
            line: tag?.line ?? spec.location.line,
            message: `\`${spec.name}\`: ${message}`,
        });
    });
}

/** Check the tenancy graph: one root, its owned interfaces, and references that agree with the target's scope. See docs/tenancy.md. */
function lintTenancy(spec: SpecModel, findings: Diagnostic[]): void {
    const reportEntity = (entity: SpecInterface, message: string, tag?: SpecTag) => {
        findings.push({
            filePath: entity.location.filePath,
            line: tag?.line ?? entity.location.line,
            message: `\`${entity.name}\`: ${message}`,
        });
    };
    const reportField = (property: SpecProperty, message: string, tag?: SpecTag) => {
        findings.push({
            filePath: property.location.filePath,
            line: tag?.line ?? property.location.line,
            message: `\`${property.name}\`: ${message}`,
        });
    };
    const ownedTagOf = (entity: SpecInterface) => (entity.tags.written.byName.get(TENANT_OWNED_TAG) ?? [])[0];
    const linkTagOf = (property: SpecProperty) => (property.tags.written.byName.get("foreignKey") ?? [])[0];
    const scopeWrittenOn = (property: SpecProperty) => parseForeignKey(linkTagOf(property)?.value ?? "").scope;

    // The root is the one interface every scope column agrees with, so a second one is ambiguous.
    const roots = [...spec.interfaces.values()].filter((entity) => entity.tags.tenant);
    const root = roots[0];
    for (const duplicate of roots.slice(1)) {
        const tag = (duplicate.tags.written.byName.get(TENANT_TAG) ?? [])[0];
        reportEntity(duplicate, `@${TENANT_TAG} is already declared on \`${root?.name}\`; the root is unique`, tag);
    }

    // An owned interface declares one required scalar column, links to the root, and requires the filter.
    for (const entity of spec.interfaces.values()) {
        const column = entity.tags.tenantOwned;
        if (column === undefined) {
            continue;
        }
        const tag = ownedTagOf(entity);
        const scoped = entity.properties.find((property) => property.name === column);
        if (scoped === undefined) {
            reportEntity(entity, `@${TENANT_OWNED_TAG} names \`${column}\`, which is not a field of this interface`, tag);
            continue;
        }
        if (scoped.tags.relation || scoped.tags.children || scoped.tags.inlined) {
            reportEntity(entity, `@${TENANT_OWNED_TAG} names \`${column}\`, which must be a scalar field`, tag);
            continue;
        }
        if (scoped.optional) {
            reportEntity(
                entity,
                `@${TENANT_OWNED_TAG} names \`${column}\`, which must be a required field, because a nullable scope skips the check`,
                tag,
            );
        } else if (root !== undefined && scoped.tags.foreignKey?.entity !== root.name) {
            reportEntity(entity, `@${TENANT_OWNED_TAG} names \`${column}\`, which must carry \`@foreignKey ${root.name}\``, tag);
        }
    }

    // An owned interface without a root has nothing to scope against, which is worth saying once.
    if (root === undefined) {
        const first = [...spec.interfaces.values()].find((entity) => entity.tags.tenantOwned !== undefined);
        if (first) {
            reportEntity(
                first,
                `@${TENANT_OWNED_TAG} links to the @${TENANT_TAG} interface, which the spec does not declare`,
                ownedTagOf(first),
            );
        }
    }

    // A reference to an owned target says the scope, and the referencing interface is owned by it.
    for (const entity of spec.interfaces.values()) {
        for (const property of entity.properties) {
            const foreignKey = property.tags.foreignKey;
            if (foreignKey === undefined) {
                continue;
            }
            const target = spec.interfaces.get(foreignKey.entity);
            const column = target?.tags.tenantOwned;
            const scope = scopeWrittenOn(property);
            if (target === undefined) {
                continue;
            }
            if (column !== undefined) {
                if (scope === undefined) {
                    reportField(
                        property,
                        `@foreignKey ${target.name} must carry \`scope=${column}\`, because \`${target.name}\` is @${TENANT_OWNED_TAG}`,
                        linkTagOf(property),
                    );
                } else if (scope !== column) {
                    reportField(
                        property,
                        `@foreignKey ${target.name} must carry \`scope=${column}\`, to agree with the scope \`${target.name}\` declares`,
                        linkTagOf(property),
                    );
                }
                if (entity.tags.tenantOwned !== column) {
                    reportField(
                        property,
                        `@foreignKey ${target.name} is scoped on \`${column}\`, so \`${entity.name}\` must declare @${TENANT_OWNED_TAG} \`${column}\``,
                        linkTagOf(property),
                    );
                }
            } else if (scope !== undefined) {
                reportField(
                    property,
                    `@foreignKey ${target.name} takes no scope, because \`${target.name}\` is not @${TENANT_OWNED_TAG}`,
                    linkTagOf(property),
                );
            }
        }
    }

    // A link to the root is the tenant link, so the interface it sits on is tenant-owned.
    if (root !== undefined) {
        for (const entity of spec.interfaces.values()) {
            if (entity.tags.tenant) {
                continue;
            }
            for (const property of entity.properties) {
                const tenantLink = property.tags.foreignKey?.entity === root.name;
                if (!tenantLink || entity.tags.tenantOwned === property.name) {
                    continue;
                }
                if (entity.tags.tenantOwned === undefined) {
                    // A bare @tenantOwned is reported on the interface itself, so this rule need not repeat it.
                    if (entity.tags.written.byName.has(TENANT_OWNED_TAG)) {
                        continue;
                    }
                    reportField(
                        property,
                        `@foreignKey ${root.name} is the tenant link, so \`${entity.name}\` must declare @${TENANT_OWNED_TAG} \`${property.name}\``,
                        linkTagOf(property),
                    );
                } else {
                    reportField(
                        property,
                        `@foreignKey ${root.name} is a second link to the root; a @${TENANT_OWNED_TAG} interface links to it once`,
                        linkTagOf(property),
                    );
                }
            }
        }
    }
}

/** Lint a model's aliases and entities; a snippet has no surface or second interface, so surface rules find nothing. */
function lintModel(spec: SpecModel, whole: boolean): { findings: Diagnostic[]; properties: number } {
    const findings: Diagnostic[] = [];
    let properties = 0;

    // Type aliases are scanned everywhere: a primitive or a formula alias may sit in any file.
    for (const alias of spec.aliases.values()) {
        lintTypeAlias(alias, findings, spec.aliases);
    }

    // An interface is an entity when it carries @entity; one without the tag is a contract.
    for (const entity of spec.interfaces.values()) {
        lintEntity(entity, findings);
        if (whole) {
            lintSurface(entity, findings);
        }
        lintFields(entity, spec.aliases, findings);
        properties += entity.properties.length;
    }

    for (const contract of spec.nonEntityInterfaces) {
        lintContract(contract, findings);
    }

    lintOperations(spec, findings);

    // The tenancy graph is spread over several interfaces, so only a whole model can be judged by it.
    if (whole) {
        lintTenancy(spec, findings);
    }

    return { findings, properties };
}

/** Lint every entity and type alias in the parsed spec. */
export function lintSpec(
    spec: SpecModel,
): { findings: Diagnostic[]; interfaces: number; properties: number } {
    const { findings, properties } = lintModel(spec, true);
    return { findings, interfaces: spec.interfaces.size, properties };
}

/** Lint one in-memory source string, for tests and one-off checks. The rules that read another declaration are skipped. */
export function lintSourceText(text: string, filePath = "fixture.ts"): Diagnostic[] {
    return lintModel(parseInMemorySpec([{ filePath, sourceFileText: text }]), false).findings;
}

/** Lint a parsed spec, report the findings, and return the exit code. */
export function run(spec: SpecModel): number {
    const { findings, interfaces, properties } = lintSpec(spec);
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

    for (const finding of findings) {
        console.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
    }

    const summary = `${interfaces} interfaces, ${properties} fields`;
    if (findings.length === 0) {
        console.log(`spec annotations OK (${summary})`);
        return 0;
    }

    console.error(`\n${findings.length} problem(s) in ${summary}`);
    return 1;
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
