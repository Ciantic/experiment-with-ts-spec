/** Check the annotation tags on `spec/` interfaces. See docs/spec-annotations.md. */
import {
    Node,
    Project,
    type InterfaceDeclaration,
    type JSDocTag,
    type PropertySignature,
    type TypeAliasDeclaration,
} from "ts-morph";

/** Tags a field may carry. Anything else is rejected, including retired tags. */
const ALLOWED_TAGS = new Set([
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
]);

/** Tags an interface may carry. */
const ALLOWED_INTERFACE_TAGS = new Set(["table"]);

/** Tags a type alias may carry. */
const ALLOWED_TYPE_TAGS = new Set(["formula", "graphql"]);

/** Retired tags, reported with their replacement rather than as "unknown". */
const RETIRED_TAGS = new Map([
    ["readonly", "use @generated for system-assigned fields or @computed for derived fields"],
    ["type", "the TypeScript type already carries this; drop it"],
    ["values", "the TypeScript type already carries this; drop it"],
]);

/** Widget hints a field may carry. */
const ALLOWED_WIDGETS = new Set([
    "text",
    "number",
    "date",
    "select",
    "table",
    "textarea",
]);

/** Storage modes a @computed field may carry. */
const ALLOWED_STORAGE = new Set(["generated", "stored", "derived"]);

/** The type-level tag that marks a union as the set of valid `formula=` names. */
const FORMULA_TAG = "formula";
/** Matches the spec interfaces, relative to this package's tsconfig. */
const SPEC_GLOB = "src/**/*.ts";

export interface Finding {
    filePath: string;
    line: number;
    message: string;
}

/** True when a type alias carries `@formula`. */
function isFormulaType(declaration: TypeAliasDeclaration): boolean {
    return declaration
        .getJsDocs()
        .some((doc) => doc.getTags().some((tag) => tag.getTagName() === FORMULA_TAG));
}

/** The members of a type, unwrapping a single-member alias that has no union node. */
function typeMembers(declaration: TypeAliasDeclaration): Node[] {
    const typeNode = declaration.getTypeNode();
    if (!typeNode) {
        return [];
    }
    return Node.isUnionTypeNode(typeNode) ? typeNode.getTypeNodes() : [typeNode];
}

/** The string-literal members of an `@formula` type, in declaration order. */
function formulaNamesIn(declaration: TypeAliasDeclaration): string[] {
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
export function readFormulaNames(project: Project): Set<string> {
    const names = new Set<string>();
    for (const sourceFile of project.getSourceFiles(SPEC_GLOB)) {
        for (const declaration of sourceFile.getTypeAliases()) {
            if (!isFormulaType(declaration)) {
                continue;
            }
            for (const name of formulaNamesIn(declaration)) {
                names.add(name);
            }
        }
    }
    return names;
}

/** Check the tags on a type alias: only known tags, and `@graphql` must name a scalar. */
function lintTypeAlias(declaration: TypeAliasDeclaration, filePath: string, findings: Finding[]): void {
    const name = declaration.getName();
    for (const doc of declaration.getJsDocs()) {
        for (const tag of doc.getTags()) {
            const tagName = tag.getTagName();
            if (!ALLOWED_TYPE_TAGS.has(tagName)) {
                findings.push({
                    filePath,
                    line: tag.getStartLineNumber(),
                    message: `\`${name}\`: @${tagName} is not a recognised type tag`,
                });
                continue;
            }
            if (tagName === "graphql" && !(tag.getCommentText() ?? "").trim()) {
                findings.push({
                    filePath,
                    line: tag.getStartLineNumber(),
                    message: `\`${name}\`: @graphql is missing its scalar name`,
                });
            }
        }
    }
    lintFormulaType(declaration, filePath, findings);
}

/** Check that each `@formula` type is a non-empty union of string literals. */
function lintFormulaType(declaration: TypeAliasDeclaration, filePath: string, findings: Finding[]): void {
    if (!isFormulaType(declaration)) {
        return;
    }
    const names = formulaNamesIn(declaration);
    if (names.length === 0) {
        findings.push({
            filePath,
            line: declaration.getStartLineNumber(),
            message: `\`${declaration.getName()}\`: @formula type must declare at least one string literal`,
        });
    } else if (names.length !== typeMembers(declaration).length) {
        findings.push({
            filePath,
            line: declaration.getStartLineNumber(),
            message: `\`${declaration.getName()}\`: @formula type members must all be string literals`,
        });
    }
}

/** Collect the JSDoc tags on a property, keyed by tag name. */
function collectTags(property: PropertySignature): Map<string, JSDocTag[]> {
    const tags = new Map<string, JSDocTag[]>();
    for (const doc of property.getJsDocs()) {
        for (const tag of doc.getTags()) {
            const name = tag.getTagName();
            const existing = tags.get(name);
            if (existing) {
                existing.push(tag);
            } else {
                tags.set(name, [tag]);
            }
        }
    }
    return tags;
}

/** Parse `key=value` pairs out of a tag comment such as `storage=stored formula=x`. */
function parseParameters(tag: JSDocTag): Map<string, string> {
    const parameters = new Map<string, string>();
    const text = tag.getCommentText() ?? "";
    for (const match of text.matchAll(/([A-Za-z]+)=(\S+)/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) {
            parameters.set(key, value);
        }
    }
    return parameters;
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

    const tags = collectTags(property);

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

/** Lint every interface in the project's spec files. */
export function lintProject(project: Project): { findings: Finding[]; interfaces: number; properties: number } {
    const findings: Finding[] = [];
    const formulaNames = readFormulaNames(project);
    let interfaces = 0;
    let properties = 0;

    for (const sourceFile of project.getSourceFiles(SPEC_GLOB)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        for (const declaration of sourceFile.getTypeAliases()) {
            lintTypeAlias(declaration, filePath, findings);
        }
        for (const declaration of sourceFile.getInterfaces()) {
            interfaces += 1;
            lintInterface(declaration, filePath, findings);
            for (const property of declaration.getProperties()) {
                properties += 1;
                lintProperty(property, filePath, formulaNames, findings);
            }
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
