/** Check the annotation tags on `spec/` interfaces. See docs/spec-annotations.md. */
import { Node, Project, SyntaxKind, type JSDocTag, type PropertySignature } from "ts-morph";

/** Tags a field may carry. Anything else is rejected, including retired tags. */
const ALLOWED_TAGS = new Set(["fieldName", "widget", "generated", "computed"]);

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

/** The formula registries in `spec/domain/formulas.ts`. */
const FORMULA_REGISTRIES = ["rowFormulas", "invoiceFormulas"];

const SPEC_GLOB = "spec/**/*.ts";
const FORMULAS_FILE = "spec/domain/formulas.ts";

interface Finding {
    filePath: string;
    line: number;
    message: string;
}

/** Read formula names from formulas.ts statically, so the module need not load. */
function readFormulaNames(project: Project): Set<string> {
    const names = new Set<string>();
    const sourceFile = project.getSourceFile(FORMULAS_FILE);
    if (!sourceFile) {
        return names;
    }

    for (const declaration of sourceFile.getVariableDeclarations()) {
        if (!FORMULA_REGISTRIES.includes(declaration.getName())) {
            continue;
        }
        const initializer = declaration.getInitializer();
        if (!initializer) {
            continue;
        }
        // The registries are `as const`, so the literal is an AsExpression.
        const objectLiteral = Node.isAsExpression(initializer)
            ? initializer.getExpressionIfKind(SyntaxKind.ObjectLiteralExpression)
            : initializer.asKind(SyntaxKind.ObjectLiteralExpression);
        if (!objectLiteral) {
            continue;
        }
        for (const property of objectLiteral.getProperties()) {
            if (Node.isPropertyAssignment(property)) {
                names.add(property.getName().replace(/^["']|["']$/g, ""));
            }
        }
    }

    return names;
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
            report(
                `formula=\`${formula}\` is not defined in ${FORMULAS_FILE} (${FORMULA_REGISTRIES.join(", ")})`,
                computedTag,
            );
        }

        for (const key of parameters.keys()) {
            if (key !== "storage" && key !== "formula") {
                report(`@computed has unknown parameter \`${key}=\``, computedTag);
            }
        }
    }
}

function main(): void {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    const findings: Finding[] = [];
    const formulaNames = readFormulaNames(project);

    if (formulaNames.size === 0) {
        console.error(`warning: no formula names found in ${FORMULAS_FILE}`);
    }

    let interfaces = 0;
    let properties = 0;

    for (const sourceFile of project.getSourceFiles(SPEC_GLOB)) {
        const filePath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
        if (filePath === FORMULAS_FILE) {
            continue;
        }

        for (const declaration of sourceFile.getInterfaces()) {
            interfaces += 1;
            for (const property of declaration.getProperties()) {
                properties += 1;
                lintProperty(property, filePath, formulaNames, findings);
            }
        }
    }

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

main();
