/** Check the annotation tags on `spec/` interfaces. See docs/spec-annotations.md. */
import {
    COMPARE_OPERATORS,
    COMPUTED_KINDS,
    FIELD_TAGS,
    INTERFACE_TAGS,
    READ_OPERATIONS,
    RETIRED_TAGS,
    TYPE_TAGS,
    WIDGETS,
    WRITE_OPERATIONS,
    isCompareOperator,
    isOrderDirection,
    loadSpec,
    parseParameters,
    parseSpecText,
    resolveType,
    assignsColumn,
    hasTriggerHeader,
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

/** The marker tag that identifies a primitive type alias. See docs/primitives.md. */
const PRIMITIVE_TAG = "primitive";

/** The tag that carries a type's Zod schema expression, e.g. `z.uuid().brand<"InvoiceId">`. */
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

/** Check the tags on the interface itself, and the per-entity uniqueness rules. */
function lintEntity(
    spec: SpecInterface,
    findings: Diagnostic[],
): void {
    const name = spec.name;
    const filePath = spec.location.filePath;
    for (const tag of spec.tags.written.all) {
        if (ALLOWED_INTERFACE_TAGS.has(tag.name)) {
            continue;
        }
        const retired = RETIRED_TAGS.get(tag.name);
        findings.push({
            filePath,
            line: tag.line,
            message: retired
                ? `\`${name}\`: @${tag.name} is retired; ${retired}`
                : `\`${name}\`: @${tag.name} is not a recognised interface tag`,
        });
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
    { name: "restRepository", vocabulary: WRITE_OPERATIONS, required: true },
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
    pgDefault: SpecTag | undefined;
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
function resolveFieldTags(property: SpecProperty): FieldTags {
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
        pgDefault: first("pgDefault"),
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

/** `@pgDefault` carries the expression the database applies when the column is omitted. */
function lintDefaultTag(tags: FieldTags, report: Report): void {
    if (tags.pgDefault && !(tags.pgDefault.value ?? "")) {
        report("@pgDefault is missing its expression", tags.pgDefault);
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
        ["pgDefault", tags.pgDefault],
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
        if (!(tags.foreignKey.value ?? "")) {
            report(
                "@foreignKey is missing the interface it references, such as `@foreignKey Customer`",
                tags.foreignKey,
            );
        }
        reportIfBranch(tags, tags.foreignKey, report);
        if (tags.isArray) {
            report("@foreignKey must be on a single field, not an array", tags.foreignKey);
        }
    }
    if (tags.primaryKey && tags.foreignKey) {
        report("@primaryKey and @foreignKey are mutually exclusive", tags.foreignKey);
    }
}

/** `@queryFilter` makes a scalar column a filter of the entity's generated reads. */
function lintQueryFilter(tags: FieldTags, report: Report): void {
    const tag = tags.queryFilter;
    if (!tag) {
        return;
    }
    if ((tag.value ?? "")) {
        report("@queryFilter takes no value", tag);
    }
    reportIfBranch(tags, tag, report);
    // The primary key is a filter already (spec-model defaults it), so the tag is noise.
    if (tags.primaryKey) {
        report("the primary key is a filter by default; drop @queryFilter", tag);
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
    reportIfBranch(tags, tag, report);
}

/** Check one field: its tag vocabulary, then each tag family's rules. */
function lintProperty(
    property: SpecProperty,
    findings: Diagnostic[],
): void {
    const fieldName = property.name;
    const filePath = property.location.filePath;
    const report: Report = (message, tag) => {
        findings.push({ filePath, line: tag?.line ?? property.location.line, message: `\`${fieldName}\`: ${message}` });
    };

    const tags = resolveFieldTags(property);

    // The call order is the order the findings are emitted in.
    lintKnownTags(tags, report);
    lintDuplicateTags(tags, report);
    lintFieldName(tags, report);
    lintWidget(tags, report);
    lintOwnership(tags, report);
    lintComputedMechanism(tags, report);
    lintTrigger(tags, report);
    lintClocks(tags, report);
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
function lintFields(spec: SpecInterface, findings: Diagnostic[]): void {
    for (const property of spec.properties) {
        lintProperty(property, findings);
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

/**
 * Lint a model's aliases and entities. A snippet has no surface, since the `@repository` rules
 * are about an entity the spec declares rather than about a rule that stands alone.
 */
function lintModel(spec: SpecModel, surface: boolean): { findings: Diagnostic[]; properties: number } {
    const findings: Diagnostic[] = [];
    let properties = 0;

    // Type aliases are scanned everywhere: primitives and formulas may sit outside domain/.
    for (const alias of spec.aliases.values()) {
        lintTypeAlias(alias, findings, spec.aliases);
    }

    // Interfaces are entities, and entities live only in domain/; operations/ is a contract.
    for (const entity of spec.interfaces.values()) {
        lintEntity(entity, findings);
        if (surface) {
            lintSurface(entity, findings);
        }
        lintFields(entity, findings);
        properties += entity.properties.length;
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

/** Lint one in-memory source string, for tests and one-off checks. */
export function lintSourceText(text: string, filePath = "fixture.ts"): Diagnostic[] {
    return lintModel(parseSpecText(text, filePath), false).findings;
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
