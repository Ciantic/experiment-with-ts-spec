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
    DEFAULT_SPEC_GLOB,
    FIELD_TAGS,
    INTERFACE_TAGS,
    RETIRED_TAGS,
    SPEC_GLOB,
    STORAGE_MODES,
    TYPE_TAGS,
    WIDGETS,
    formulaNamesIn,
    parseParameters,
    readFormulaNames,
    readQueries,
    readTags,
    typeMembers,
} from "./spec-model.ts";

// Re-exported so the model's formula discovery and the linter have one entry point.
export { readFormulaNames };

/** Tags a field may carry. Anything else is rejected, including retired tags. */
const ALLOWED_TAGS = new Set<string>(FIELD_TAGS);

/** Tags an interface may carry. */
const ALLOWED_INTERFACE_TAGS = new Set<string>(INTERFACE_TAGS);

/** Tags a type alias may carry. Anything else is rejected. */
const ALLOWED_TYPE_TAGS = new Set<string>(TYPE_TAGS);

/** Widget hints a field may carry. */
const ALLOWED_WIDGETS = new Set<string>(WIDGETS);

/** Storage modes a @computed field may carry. */
const ALLOWED_STORAGE = new Set<string>(STORAGE_MODES);

/** The type-level tag that marks a union as the set of valid `formula=` names. */
const FORMULA_TAG = "formula";

/** The marker tag that identifies a primitive type alias. See docs/primitives.md. */
const PRIMITIVE_TAG = "primitive";

/** The tag that carries a type's Zod schema expression, e.g. `z.uuid().brand<"InvoiceId">`. */
const ZOD_TAG = "zod";

/** The tag that carries a type's storage-layer type, e.g. `uuid`. */
const PG_TYPE_TAG = "pgtype";

/** The tag that marks an alias as the arguments of a read. See docs/queries.md. */
const QUERY_TAG = "query";

export interface Finding {
    filePath: string;
    line: number;
    message: string;
}

/** Check the tags on a type alias: `@formula`, `@primitive`, and `@zod`. */
function lintTypeAlias(declaration: TypeAliasDeclaration, filePath: string, findings: Finding[]): void {
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

    if (tags.has(FORMULA_TAG)) {
        const names = formulaNamesIn(declaration);
        if (names.length === 0) {
            findings.push({
                filePath,
                line: declaration.getStartLineNumber(),
                message: `\`${name}\`: @formula type must declare at least one string literal`,
            });
        } else if (names.length !== typeMembers(declaration).length) {
            findings.push({
                filePath,
                line: declaration.getStartLineNumber(),
                message: `\`${name}\`: @formula type members must all be string literals`,
            });
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

    // @query names a target entity and an optional cardinality; it rides on an object type literal.
    const queryTag = (tags.get(QUERY_TAG) ?? [])[0];
    if (queryTag) {
        const value = (queryTag.getCommentText() ?? "").trim();
        const parts = value === "" ? [] : value.split(/\s+/);
        const entity = parts[0];
        const cardinality = parts[1];
        if (!entity) {
            report(`@${QUERY_TAG} is missing its <Entity>`, queryTag);
        } else {
            const typeNode = declaration.getTypeNode();
            if (typeNode && !Node.isTypeLiteral(typeNode)) {
                report(`@${QUERY_TAG} must be on an object type literal of its arguments`, queryTag);
            }
        }
        if (parts.length > 2) {
            report(`@${QUERY_TAG} takes an <Entity> and an optional \`one\` or \`many\``, queryTag);
        } else if (cardinality !== undefined && cardinality !== "one" && cardinality !== "many") {
            report(`@${QUERY_TAG} cardinality \`${cardinality}\` must be \`one\` or \`many\``, queryTag);
        }
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
}

function lintProperty(
    property: PropertySignature,
    filePath: string,
    formulaNames: Set<string>,
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
        const storage = parameters.get("storage");
        const formula = parameters.get("formula");

        if (!storage) {
            report("@computed is missing storage=", computedTag);
        } else if (!ALLOWED_STORAGE.has(storage)) {
            report(
                `storage=\`${storage}\` is not one of: ${[...ALLOWED_STORAGE].join(", ")}`,
                computedTag,
            );
        }

        if (!formula) {
            report("@computed is missing formula=", computedTag);
        } else if (!formulaNames.has(formula)) {
            report(`formula=\`${formula}\` is not declared by any @formula type in spec/`, computedTag);
        }

        for (const key of parameters.keys()) {
            if (key !== "storage" && key !== "formula") {
                report(`@computed has unknown parameter \`${key}=\``, computedTag);
            }
        }
    }

    // @default carries a SQL expression the database uses when the column is omitted.
    // It may accompany @computed: a before trigger runs after defaults are applied,
    // so the two agree on insert where they overlap (see docs/timestamps.md).
    const defaultTag = (tags.get("default") ?? [])[0];
    if (defaultTag && !(defaultTag.getCommentText() ?? "").trim()) {
        report("@default is missing its expression", defaultTag);
    }

    // @inlined names the entity to flatten and conflicts with the relation tags.
    const inlinedTag = (tags.get("inlined") ?? [])[0];
    if (inlinedTag) {
        if (!(inlinedTag.getCommentText() ?? "").trim()) {
            report("@inlined is missing its <Entity>", inlinedTag);
        }
        if ((tags.get("relation") ?? []).length > 0) {
            report("@inlined and @relation are mutually exclusive", inlinedTag);
        }
        if ((tags.get("children") ?? []).length > 0) {
            report("@inlined and @children are mutually exclusive", inlinedTag);
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
        const typeText = property.getTypeNode()?.getText();
        if (typeText !== "Version") {
            report(`@version must be on a \`Version\` field, found \`${typeText ?? "unknown"}\``, versionTag);
        }
    }
}

/** Lint an in-memory source string, for tests and one-off checks. */
export function lintSourceText(
    text: string,
    formulaNames: Set<string>,
    filePath = "fixture.ts",
): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(`/${filePath}`, text);
    const findings: Finding[] = [];
    for (const declaration of sourceFile.getInterfaces()) {
        lintInterface(declaration, filePath, findings);
        for (const property of declaration.getProperties()) {
            lintProperty(property, filePath, formulaNames, findings);
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
    const formulaNames = readFormulaNames(project, aliasGlob);
    let interfaces = 0;
    let properties = 0;

    // Type aliases are scanned everywhere: primitives and formulas may sit outside domain/.
    for (const sourceFile of project.getSourceFiles(aliasGlob)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        for (const declaration of sourceFile.getTypeAliases()) {
            lintTypeAlias(declaration, filePath, findings);
        }
    }

    // Interfaces are entities, and entities live only in domain/; operations/ and queries/ are contracts.
    const entityNames = new Set<string>();
    for (const sourceFile of project.getSourceFiles(entityGlob)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        for (const declaration of sourceFile.getInterfaces()) {
            interfaces += 1;
            entityNames.add(declaration.getName());
            lintInterface(declaration, filePath, findings);
            for (const property of declaration.getProperties()) {
                properties += 1;
                lintProperty(property, filePath, formulaNames, findings);
            }
        }
    }

    // A `@query` must name an entity that exists.
    for (const query of readQueries(project, aliasGlob)) {
        if (!entityNames.has(query.entity)) {
            findings.push({
                filePath: query.filePath.replace(`${process.cwd()}/`, ""),
                line: query.declaration.getStartLineNumber(),
                message: `\`${query.name}\`: @query ${query.entity} is not an interface in domain/`,
            });
        }
    }

    return { findings, interfaces, properties };
}

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    const formulaNames = readFormulaNames(project);

    if (formulaNames.size === 0) {
        console.error("warning: no formula names found; annotate a type under spec/ with @formula");
    }

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
