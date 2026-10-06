/** Check the annotation tags on `spec/` interfaces. See docs/spec-annotations.md. */
import {
    Project,
    Node,
    type InterfaceDeclaration,
    type JSDocTag,
    type PropertySignature,
    type TypeAliasDeclaration,
} from "ts-morph";
import {
    COMPARE_OPERATORS,
    COMPUTED_KINDS,
    DEFAULT_SPEC_GLOB,
    FIELD_TAGS,
    INTERFACE_TAGS,
    RETIRED_TAGS,
    SPEC_GLOB,
    TYPE_TAGS,
    WIDGETS,
    isCompareOperator,
    isOrderDirection,
    parseParameters,
    assignsColumn,
    hasTriggerHeader,
    parseTrigger,
    parseTriggerHeader,
    readTags,
    triggerHeaderText,
    TRIGGER_EVENTS,
    triggerLevel,
    type ComputedKind,
    type TriggerHeader,
} from "./spec-model.ts";

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

export interface Finding {
    filePath: string;
    line: number;
    message: string;
}

/** Check the tags on a type alias: `@primitive`, `@zod`, and `@pgType`. */
function lintTypeAlias(
    declaration: TypeAliasDeclaration,
    filePath: string,
    findings: Finding[],
): void {
    const name = declaration.getName();
    const tags = readTags(declaration).byName;
    const report = (message: string, tag: JSDocTag) => {
        findings.push({ filePath, line: tag.getStartLineNumber(), message: `\`${name}\`: ${message}` });
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
    if (primitiveTag && (primitiveTag.getCommentText() ?? "").trim()) {
        report(`@${PRIMITIVE_TAG} takes no value`, primitiveTag);
    }
    if (zodTag && !(zodTag.getCommentText() ?? "").trim()) {
        report(`@${ZOD_TAG} is missing its schema expression`, zodTag);
    }
    if (pgTypeTag && !(pgTypeTag.getCommentText() ?? "").trim()) {
        report(`@${PG_TYPE_TAG} is missing its storage type`, pgTypeTag);
    }
    if (primitiveTag && !zodTag) {
        report(`@${PRIMITIVE_TAG} requires @${ZOD_TAG}`, primitiveTag);
    }
    if (primitiveTag && !pgTypeTag) {
        report(`@${PRIMITIVE_TAG} requires @${PG_TYPE_TAG}`, primitiveTag);
    }
}

/** True when a property carries `@version`. */
function hasVersionTag(property: PropertySignature): boolean {
    return property
        .getJsDocs()
        .some((doc) => doc.getTags().some((tag) => tag.getTagName() === "version"));
}

/** Check the tags on the interface declaration itself. */
export function lintInterface(
    declaration: InterfaceDeclaration,
    filePath: string,
    findings: Finding[],
): void {
    const name = declaration.getName();
    for (const doc of declaration.getJsDocs()) {
        for (const tag of doc.getTags()) {
            const tagName = tag.getTagName();
            if (ALLOWED_INTERFACE_TAGS.has(tagName)) {
                continue;
            }
            const retired = RETIRED_TAGS.get(tagName);
            findings.push({
                filePath,
                line: tag.getStartLineNumber(),
                message: retired
                    ? `\`${name}\`: @${tagName} is retired; ${retired}`
                    : `\`${name}\`: @${tagName} is not a recognised interface tag`,
            });
        }
    }

    // An entity has at most one optimistic-lock column.
    const versioned = declaration.getProperties().filter(hasVersionTag);
    for (const property of versioned.slice(1)) {
        findings.push({
            filePath,
            line: property.getStartLineNumber(),
            message: `\`${name}\`: @version may appear on at most one field`,
        });
    }

    // The interface-level tag is checked against the declaration, not against a field.
    const interfaceReport: Report = (message, tag) => {
        findings.push({ filePath, line: (tag ?? declaration).getStartLineNumber(), message: `\`${name}\`: ${message}` });
    };
    lintEntityTrigger(declaration, interfaceReport);

    // An entity records one creation moment and one last-write moment.
    for (const clock of ["createdAt", "updatedAt"] as const) {
        const clocked = declaration
            .getProperties()
            .filter((property) => readTags(property)[clock]);
        for (const property of clocked.slice(1)) {
            findings.push({
                filePath,
                line: property.getStartLineNumber(),
                message: `\`${name}\`: @${clock} may appear on at most one field`,
            });
        }
    }

    // At most one ordering field may declare the entity default; otherwise it is ambiguous.
    const defaultOrdered = declaration
        .getProperties()
        .filter((property) => readTags(property).queryOrderBy?.default !== undefined);
    for (const property of defaultOrdered.slice(1)) {
        findings.push({
            filePath,
            line: property.getStartLineNumber(),
            message: `\`${name}\`: @queryOrderBy default may appear on at most one field`,
        });
    }
}

/** Report a finding on the field under lint, at the tag's line or the field's. */
type Report = (message: string, tag?: JSDocTag) => void;

/** A branch marker on an entity-typed field: `@relation`, `@children`, or `@inlined`. */
interface BranchTag {
    name: string;
    tag: JSDocTag;
}

/** The tags and type shape one field's rules share, resolved once so no rule walks the map itself. */
interface FieldTags {
    /** Every occurrence, keyed by name, for the vocabulary rules. */
    byName: Map<string, JSDocTag[]>;
    fieldName: JSDocTag | undefined;
    widget: JSDocTag | undefined;
    computed: JSDocTag | undefined;
    /** The `@computed` mechanism tags present, in `COMPUTED_KINDS` order. */
    mechanism: { name: ComputedKind; tag: JSDocTag }[];
    trigger: JSDocTag | undefined;
    createdAt: JSDocTag | undefined;
    updatedAt: JSDocTag | undefined;
    pgDefault: JSDocTag | undefined;
    branches: BranchTag[];
    primaryKey: JSDocTag | undefined;
    foreignKey: JSDocTag | undefined;
    queryFilter: JSDocTag | undefined;
    version: JSDocTag | undefined;
    queryOrderBy: JSDocTag | undefined;
    queryWhere: JSDocTag | undefined;
    /** The field type as written, e.g. `Date` or `InvoiceRow[]`. */
    typeText: string | undefined;
    isArray: boolean;
    /** True when the field is written `?`. See docs/optionality.md. */
    optional: boolean;
}

/** Resolve the tags a field's rules share: the first occurrence of each, plus the type shape. */
function resolveFieldTags(property: PropertySignature): FieldTags {
    const byName = readTags(property).byName;
    const first = (name: string) => (byName.get(name) ?? [])[0];
    const branch = (name: string): BranchTag[] => {
        const tag = first(name);
        return tag ? [{ name, tag }] : [];
    };
    const typeNode = property.getTypeNode();
    return {
        byName,
        fieldName: first("fieldName"),
        widget: first("widget"),
        computed: first("computed"),
        mechanism: COMPUTED_KINDS.map((name) => ({ name, tag: first(name) })).filter(
            (entry): entry is { name: ComputedKind; tag: JSDocTag } => entry.tag !== undefined,
        ),
        trigger: first("pgTrigger"),
        createdAt: first("createdAt"),
        updatedAt: first("updatedAt"),
        pgDefault: first("pgDefault"),
        branches: [...branch("relation"), ...branch("children"), ...branch("inlined")],
        primaryKey: first("primaryKey"),
        foreignKey: first("foreignKey"),
        queryFilter: first("queryFilter"),
        version: first("version"),
        queryOrderBy: first("queryOrderBy"),
        queryWhere: first("queryWhere"),
        typeText: typeNode?.getText(),
        isArray: typeNode !== undefined && Node.isArrayTypeNode(typeNode),
        optional: property.hasQuestionToken(),
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
    } else if (!(tags.fieldName.getCommentText() ?? "").trim()) {
        report("@fieldName is empty", tags.fieldName);
    }
}

/** `@widget` is required and names a known control. */
function lintWidget(tags: FieldTags, report: Report): void {
    if (!tags.widget) {
        report("missing @widget");
        return;
    }
    const widget = (tags.widget.getCommentText() ?? "").trim();
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
        if (!(tag.getCommentText() ?? "").trim()) {
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
function lintTriggerHeader(tag: JSDocTag, parsed: TriggerHeader, report: Report): void {
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
    const text = (tag.getCommentText() ?? "").trim();
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
function lintEntityTrigger(declaration: InterfaceDeclaration, report: Report): void {
    const tag = declaration
        .getJsDocs()
        .flatMap((doc) => doc.getTags())
        .find((candidate) => candidate.getTagName() === "pgTrigger");
    if (!tag) {
        return;
    }
    const trigger = parseTrigger((tag.getCommentText() ?? "").trim());
    const text = (tag.getCommentText() ?? "").trim();
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
    const clocks: [string, JSDocTag | undefined][] = [
        ["createdAt", tags.createdAt],
        ["updatedAt", tags.updatedAt],
    ];
    for (const [name, tag] of clocks) {
        if (!tag) {
            continue;
        }
        if ((tag.getCommentText() ?? "").trim()) {
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
    if (tags.pgDefault && !(tags.pgDefault.getCommentText() ?? "").trim()) {
        report("@pgDefault is missing its expression", tags.pgDefault);
    }
}

/** A scalar-only tag may not sit on a branch field. */
function reportIfBranch(tags: FieldTags, tag: JSDocTag, report: Report): void {
    const branch = tags.branches[0];
    if (branch) {
        report(`@${tag.getTagName()} must be on a scalar field, not a @${branch.name} field`, tag);
    }
}

/** The branch markers are bare, mutually exclusive, and match the field's cardinality. */
function lintBranches(tags: FieldTags, report: Report): void {
    for (const { name, tag } of tags.branches) {
        if ((tag.getCommentText() ?? "").trim()) {
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
        if ((tags.primaryKey.getCommentText() ?? "").trim()) {
            report("@primaryKey takes no value", tags.primaryKey);
        }
        reportIfBranch(tags, tags.primaryKey, report);
        if (tags.isArray) {
            report("@primaryKey must be on a single field, not an array", tags.primaryKey);
        }
    }
    if (tags.foreignKey) {
        if (!(tags.foreignKey.getCommentText() ?? "").trim()) {
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
    if ((tag.getCommentText() ?? "").trim()) {
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
    const forced: [string, JSDocTag | undefined][] = [
        ["primaryKey", tags.primaryKey],
        ["createdAt", tags.createdAt],
        ["updatedAt", tags.updatedAt],
        ["version", tags.version],
        ["pgDefault", tags.pgDefault],
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
    const text = (tag.getCommentText() ?? "").trim();
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
    const tokens = (tag.getCommentText() ?? "").trim().split(/\s+/).filter((token) => token !== "");
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
    property: PropertySignature,
    filePath: string,
    findings: Finding[],
): void {
    const fieldName = property.getName();
    const report: Report = (message, tag) => {
        const line = (tag ?? property).getStartLineNumber();
        findings.push({ filePath, line, message: `\`${fieldName}\`: ${message}` });
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
    lintBranches(tags, report);
    lintKeyTags(tags, report);
    lintQueryFilter(tags, report);
    lintVersion(tags, report);
    lintForcedNotNull(tags, report);
    lintQueryOrderBy(tags, report);
    lintWhere(tags, report);
}

/** Lint an in-memory source string, for tests and one-off checks. */
export function lintSourceText(
    text: string,
    filePath = "fixture.ts",
): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(`/${filePath}`, text);
    const findings: Finding[] = [];
    for (const declaration of sourceFile.getInterfaces()) {
        lintInterface(declaration, filePath, findings);
        for (const property of declaration.getProperties()) {
            lintProperty(property, filePath, findings);
        }
    }
    for (const declaration of sourceFile.getTypeAliases()) {
        lintTypeAlias(declaration, filePath, findings);
    }
    return findings;
}

/** Inputs to {@link lintProject}. */
export interface LintOptions {
    /** Where entities (interfaces) are read from; defaults to the domain entities. */
    entityGlob?: string;
    /** Where type aliases are scanned; defaults to every spec file. */
    aliasGlob?: string;
}

/** Lint every entity in the project's spec files: interfaces under `domain/`, type aliases everywhere. */
export function lintProject(
    project: Project,
    options: LintOptions = {},
): { findings: Finding[]; interfaces: number; properties: number } {
    const entityGlob = options.entityGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const findings: Finding[] = [];
    let interfaces = 0;
    let properties = 0;

    // Type aliases are scanned everywhere: primitives and formulas may sit outside domain/.
    for (const sourceFile of project.getSourceFiles(aliasGlob)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        for (const declaration of sourceFile.getTypeAliases()) {
            lintTypeAlias(declaration, filePath, findings);
        }
    }

    // Interfaces are entities, and entities live only in domain/; operations/ is a contract.
    for (const sourceFile of project.getSourceFiles(entityGlob)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        for (const declaration of sourceFile.getInterfaces()) {
            interfaces += 1;
            lintInterface(declaration, filePath, findings);
            for (const property of declaration.getProperties()) {
                properties += 1;
                lintProperty(property, filePath, findings);
            }
        }
    }

    return { findings, interfaces, properties };
}

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });

    const { findings, interfaces, properties } = lintProject(project);
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

    for (const finding of findings) {
        console.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
    }

    const summary = `${interfaces} interfaces, ${properties} fields`;
    if (findings.length === 0) {
        console.log(`spec annotations OK (${summary})`);
        return;
    }

    console.error(`\n${findings.length} problem(s) in ${summary}`);
    process.exitCode = 1;
}

if (import.meta.main) {
    main();
}
