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
    readTags,
    type ComputedKind,
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
const PG_TYPE_TAG = "pgtype";

export interface Finding {
    filePath: string;
    line: number;
    message: string;
}

/** Check the tags on a type alias: `@primitive`, `@zod`, and `@pgtype`. */
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

    // @primitive is a bare marker; its type must carry the matching @zod schema and @pgtype storage type.
    const primitiveTag = (tags.get(PRIMITIVE_TAG) ?? [])[0];
    const zodTag = (tags.get(ZOD_TAG) ?? [])[0];
    const pgtypeTag = (tags.get(PG_TYPE_TAG) ?? [])[0];
    if (primitiveTag && (primitiveTag.getCommentText() ?? "").trim()) {
        report(`@${PRIMITIVE_TAG} takes no value`, primitiveTag);
    }
    if (zodTag && !(zodTag.getCommentText() ?? "").trim()) {
        report(`@${ZOD_TAG} is missing its schema expression`, zodTag);
    }
    if (pgtypeTag && !(pgtypeTag.getCommentText() ?? "").trim()) {
        report(`@${PG_TYPE_TAG} is missing its storage type`, pgtypeTag);
    }
    if (primitiveTag && !zodTag) {
        report(`@${PRIMITIVE_TAG} requires @${ZOD_TAG}`, primitiveTag);
    }
    if (primitiveTag && !pgtypeTag) {
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
            findings.push({
                filePath,
                line: tag.getStartLineNumber(),
                message: `\`${name}\`: @${tagName} is not a recognised interface tag`,
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
            message: `\`${name}\`: @queryorderby default may appear on at most one field`,
        });
    }
}

function lintProperty(
    property: PropertySignature,
    filePath: string,
    findings: Finding[],
): void {
    const fieldName = property.getName();
    const report = (message: string, tag?: JSDocTag) => {
        const line = (tag ?? property).getStartLineNumber();
        findings.push({ filePath, line, message: `\`${fieldName}\`: ${message}` });
    };

    const tags = readTags(property).byName;

    // Unknown and retired tags.
    for (const [name, instances] of tags) {
        if (ALLOWED_TAGS.has(name)) {
            continue;
        }
        const retired = RETIRED_TAGS.get(name);
        for (const tag of instances) {
            report(
                retired
                    ? `@${name} is retired; ${retired}`
                    : `@${name} is not a recognised tag`,
                tag,
            );
        }
    }

    // Duplicate tags.
    for (const [name, instances] of tags) {
        if (instances.length > 1) {
            for (const tag of instances) {
                report(`@${name} appears more than once`, tag);
            }
        }
    }

    // @fieldName is required and must be non-empty.
    const fieldNameTags = tags.get("fieldName") ?? [];
    const fieldNameTag = fieldNameTags[0];
    if (!fieldNameTag) {
        report("missing @fieldName");
    } else if (!(fieldNameTag.getCommentText() ?? "").trim()) {
        report("@fieldName is empty", fieldNameTag);
    }

    // @widget is required and must be a known widget.
    const widgetTags = tags.get("widget") ?? [];
    const widgetTag = widgetTags[0];
    if (!widgetTag) {
        report("missing @widget");
    } else {
        const widget = (widgetTag.getCommentText() ?? "").trim();
        if (!ALLOWED_WIDGETS.has(widget)) {
            report(
                `@widget \`${widget}\` is not one of: ${[...ALLOWED_WIDGETS].join(", ")}`,
                widgetTag,
            );
        }
    }

    const generatedTags = tags.get("generated") ?? [];
    const computedTags = tags.get("computed") ?? [];

    // @generated and @computed are mutually exclusive.
    if (generatedTags.length > 0 && computedTags.length > 0) {
        report("@generated and @computed are mutually exclusive", generatedTags[0]);
    }

    const generatedTag = generatedTags[0];
    if (generatedTag) {
        const parameters = parseParameters(generatedTag);
        if (parameters.size > 0) {
            report(
                `@generated takes no parameters, found: ${[...parameters.keys()].map((key) => `${key}=`).join(", ")}`,
                generatedTag,
            );
        }
    }

    const computedTag = computedTags[0];
    if (computedTag) {
        const parameters = parseParameters(computedTag);
        if (parameters.size > 0) {
            report(
                `@computed takes no parameters, found: ${[...parameters.keys()].map((key) => `${key}=`).join(", ")}`,
                computedTag,
            );
        }
    }

    // One mechanism tag per computed field says how Postgres materializes it. See docs/spec-annotations.md.
    const mechanismTags = COMPUTED_KINDS.map((name) => ({ name, tag: (tags.get(name) ?? [])[0] })).filter(
        (entry): entry is { name: ComputedKind; tag: JSDocTag } => entry.tag !== undefined,
    );

    for (const { name, tag } of mechanismTags) {
        if (!(tag.getCommentText() ?? "").trim()) {
            report(`@${name} is missing its expression`, tag);
        }
        if (computedTags.length === 0) {
            report(`@${name} requires @computed`, tag);
        }
    }
    const firstMechanism = mechanismTags[0];
    if (firstMechanism) {
        for (const current of mechanismTags.slice(1)) {
            report(`@${firstMechanism.name} and @${current.name} are mutually exclusive`, current.tag);
        }
    }

    // A rollup statement is written once for the child change and mirrored for the child removal,
    // so the generator substitutes NEW -> OLD; spelling OLD here would make that partial.
    const rollupTag = (tags.get("pgrollup") ?? [])[0];
    if (rollupTag && (rollupTag.getCommentText() ?? "").includes("OLD.")) {
        report("@pgrollup is written with NEW.; the delete variant is generated from it", rollupTag);
    }

    // The clock tags are self-contained: the database owns the column, so they exclude every
    // other ownership tag and must sit on a `Date` field. See docs/timestamps.md.
    const createdAtTag = (tags.get("createdAt") ?? [])[0];
    const updatedAtTag = (tags.get("updatedAt") ?? [])[0];
    for (const { name, tag } of [
        { name: "createdAt", tag: createdAtTag },
        { name: "updatedAt", tag: updatedAtTag },
    ]) {
        if (!tag) {
            continue;
        }
        if ((tag.getCommentText() ?? "").trim()) {
            report(`@${name} takes no value`, tag);
        }
        if (generatedTags.length > 0) {
            report(`@${name} and @generated are mutually exclusive`, tag);
        }
        if (computedTags.length > 0) {
            report(`@${name} and @computed are mutually exclusive`, tag);
        }
        if (tags.get("default") !== undefined) {
            report(`@${name} supplies its own default; drop @default`, tag);
        }
        for (const { name: mechanism } of mechanismTags) {
            report(`@${name} and @${mechanism} are mutually exclusive`, tag);
        }
        const typeText = property.getTypeNode()?.getText();
        if (typeText !== "Date") {
            report(`@${name} must be on a \`Date\` field, found \`${typeText ?? "unknown"}\``, tag);
        }
    }
    if (createdAtTag && updatedAtTag) {
        report("@createdAt and @updatedAt are mutually exclusive", updatedAtTag);
    }

    // @default carries a SQL expression the database uses when the column is omitted.
    // A before trigger runs after defaults are applied, so the two agree on insert where they overlap.
    const defaultTag = (tags.get("default") ?? [])[0];
    if (defaultTag && !(defaultTag.getCommentText() ?? "").trim()) {
        report("@default is missing its expression", defaultTag);
    }

    // The branch tags are bare markers on an entity-typed field: @relation (foreign key),
    // @children (child collection), @inlined (flattened snapshot). The entity is the field type.
    const relationTag = (tags.get("relation") ?? [])[0];
    const childrenTag = (tags.get("children") ?? [])[0];
    const inlinedTag = (tags.get("inlined") ?? [])[0];
    const branchTags = [
        relationTag ? { tag: relationTag, name: "relation" } : undefined,
        childrenTag ? { tag: childrenTag, name: "children" } : undefined,
        inlinedTag ? { tag: inlinedTag, name: "inlined" } : undefined,
    ].filter((entry): entry is { tag: JSDocTag; name: string } => entry !== undefined);

    for (const { tag, name } of branchTags) {
        if ((tag.getCommentText() ?? "").trim()) {
            report(`@${name} takes no value; the entity comes from the field type`, tag);
        }
    }
    const firstBranch = branchTags[0];
    if (firstBranch) {
        for (const current of branchTags.slice(1)) {
            report(`@${firstBranch.name} and @${current.name} are mutually exclusive`, current.tag);
        }
    }

    const typeNode = property.getTypeNode();
    const isArray = typeNode !== undefined && Node.isArrayTypeNode(typeNode);
    for (const { tag, name } of branchTags) {
        const wantsArray = name === "children";
        if (wantsArray && !isArray) {
            report("@children must be on an array field, such as `rows?: InvoiceRow[]`", tag);
        }
        if (!wantsArray && isArray) {
            report(`@${name} must be on a single entity field, not an array`, tag);
        }
    }

    // @queryfilter marks a scalar field as a filter of its entity's generated reads.
    const queryFilterTag = (tags.get("queryfilter") ?? [])[0];
    if (queryFilterTag) {
        if ((queryFilterTag.getCommentText() ?? "").trim()) {
            report("@queryfilter takes no value", queryFilterTag);
        }
        if (firstBranch) {
            report(`@queryfilter must be on a scalar field, not a @${firstBranch.name} field`, queryFilterTag);
        }
        // Every entity's `id` is a filter already (spec-model defaults it), so the tag is noise.
        if (fieldName === "id") {
            report("`id` is a filter by default; drop @queryfilter", queryFilterTag);
        }
    }

    // @version marks the optimistic-lock column; the type must be Version and the value is not derived.
    const versionTag = (tags.get("version") ?? [])[0];
    if (versionTag) {
        if (generatedTags.length > 0) {
            report("@version and @generated are mutually exclusive", versionTag);
        }
        if (computedTags.length > 0) {
            report("@version and @computed are mutually exclusive", versionTag);
        }
        if (createdAtTag) {
            report("@version and @createdAt are mutually exclusive", versionTag);
        }
        if (updatedAtTag) {
            report("@version and @updatedAt are mutually exclusive", versionTag);
        }
        const typeText = property.getTypeNode()?.getText();
        if (typeText !== "Version") {
            report(`@version must be on a \`Version\` field, found \`${typeText ?? "unknown"}\``, versionTag);
        }
    }

    // @queryorderby marks a scalar field as an ordering key; `default asc|desc` also names the
    // entity's default ordering. See docs/queries.md.
    const queryOrderTag = (tags.get("queryorderby") ?? [])[0];
    if (queryOrderTag) {
        const text = (queryOrderTag.getCommentText() ?? "").trim();
        if (text !== "") {
            const tokens = text.split(/\s+/);
            const isDefault = tokens.length === 2 && tokens[0] === "default" && isOrderDirection(tokens[1]);
            if (!isDefault) {
                report(
                    `@queryorderby takes no value or \`default asc|desc\`, found \`${text}\``,
                    queryOrderTag,
                );
            }
        }
        if (firstBranch) {
            report(`@queryorderby must be on a scalar field, not a @${firstBranch.name} field`, queryOrderTag);
        }
    }

    // @where whitelists the comparison operators a field may be compared with. See docs/queries.md.
    const whereTag = (tags.get("where") ?? [])[0];
    if (whereTag) {
        const tokens = (whereTag.getCommentText() ?? "").trim().split(/\s+/).filter((token) => token !== "");
        if (tokens.length === 0) {
            report(`@where requires at least one operator, one of: ${COMPARE_OPERATORS.join(", ")}`, whereTag);
        }
        for (const token of tokens) {
            if (!isCompareOperator(token)) {
                report(
                    `@where \`${token}\` is not one of: ${COMPARE_OPERATORS.join(", ")}`,
                    whereTag,
                );
            }
        }
        if (firstBranch) {
            report(`@where must be on a scalar field, not a @${firstBranch.name} field`, whereTag);
        }
    }
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
