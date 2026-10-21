/** Scaffold one backend module per `@operation`, and verify each hand-written one still declares its contract. See docs/operations.md. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    loadSpec,
    specImportSpecifier,
    type Diagnostic,
    type SpecModel,
    type SpecOperation,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

/** This package's root, so paths do not depend on the current working directory. */
const BACKEND_PACKAGE_ROOT = dirname(import.meta.dirname);

/** Where the operation modules are written when no `--out` is given. */
const DEFAULT_OUT_DIR = join(BACKEND_PACKAGE_ROOT, "src/operations");

/** The context a fresh scaffold takes: the implementer chooses it, so the placeholder names nothing. */
const PLACEHOLDER_CONTEXT = "unknown";

/** InvoiceOperations -> InvoiceOperations<unknown>. */
function contractType(operation: SpecOperation): string {
    return operation.interfaceTypeParameters.length === 0
        ? operation.interfaceName
        : `${operation.interfaceName}<${PLACEHOLDER_CONTEXT}>`;
}

/** Whether the contract returns a promise, so the scaffold can be async and unwrap the awaited type. */
function isPromise(operation: SpecOperation): boolean {
    return (
        operation.returnType.kind === "reference" &&
        operation.returnType.name === "Promise" &&
        operation.returnType.arguments.length === 1
    );
}

/** The type the placeholder claims to return: the contract's return type as written. */
export function placeholderType(operation: SpecOperation): string {
    return operation.returnTypeText === "" ? "undefined" : operation.returnTypeText;
}

/** The spec declarations the return type names, so the scaffold imports them from their own modules. */
function returnTypeImports(operation: SpecOperation, spec: SpecModel): Map<string, string[]> {
    const text = placeholderType(operation);
    const declared = new Map<string, string>();
    for (const [name, entity] of spec.interfaces) {
        declared.set(name, entity.importSpecifier);
    }
    for (const [name, alias] of spec.aliases) {
        declared.set(name, specImportSpecifier(alias.filePath));
    }

    const imports = new Map<string, string[]>();
    for (const name of [...declared.keys()].sort((a, b) => a.localeCompare(b))) {
        if (name === operation.interfaceName || !new RegExp(`\\b${name}\\b`).test(text)) {
            continue;
        }
        const specifier = declared.get(name);
        if (specifier === undefined) {
            continue;
        }
        imports.set(specifier, [...(imports.get(specifier) ?? []), name]);
    }
    return imports;
}

/** Render the module a new operation starts from: the contract annotation, the doc, and a null placeholder. */
export function renderOperationFile(operation: SpecOperation, spec: SpecModel): string {
    const lines: string[] = [];
    lines.push(`import type { ${operation.interfaceName} } from "${operation.importSpecifier}";`);
    for (const [specifier, names] of [...returnTypeImports(operation, spec)].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`import type { ${names.join(", ")} } from "${specifier}";`);
    }
    lines.push("");

    if (operation.description.length > 0 || operation.throws.length > 0) {
        lines.push("/**");
        for (const line of operation.description) {
            lines.push(` * ${line}`);
        }
        if (operation.description.length > 0 && operation.throws.length > 0) {
            lines.push(" *");
        }
        for (const thrown of operation.throws) {
            lines.push(` * @throws {${thrown.name}} ${thrown.reason}`);
        }
        lines.push(" */");
    }

    const parameters = operation.parameters.map((parameter) => parameter.name).join(", ");
    const asyncKeyword = isPromise(operation) ? "async " : "";
    lines.push(`export const ${operation.name}: ${contractType(operation)}["${operation.name}"] = ${asyncKeyword}(${parameters}) => {`);
    lines.push(`    return null as unknown as ${placeholderType(operation)};`);
    lines.push("};");
    lines.push("");
    return lines.join("\n");
}

/** Whether a hand-written module still declares the operation with its contract annotation. */
export function meetsContract(source: string, operation: SpecOperation): boolean {
    const name = operation.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const contract = operation.interfaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The annotation is the contract: `export const sendInvoice: InvoiceOperations<…>["sendInvoice"] = …`.
    const pattern = new RegExp(
        `export\\s+const\\s+${name}\\s*:\\s*${contract}\\s*(?:<[^=;]*?>)?\\s*\\[\\s*["']${name}["']\\s*\\]\\s*=`,
    );
    return pattern.test(source);
}

/** Report the operation declarations the spec cannot scaffold. */
function validate(spec: SpecModel): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const byName = new Map<string, SpecOperation>();

    for (const operation of spec.operations) {
        if (!operation.operation) {
            findings.push({
                filePath: operation.location.filePath,
                line: operation.location.line,
                message: `\`${operation.name}\`: @restOperation requires @operation`,
            });
            continue;
        }
        if (operation.interfaceTypeParameters.length > 1) {
            findings.push({
                filePath: operation.location.filePath,
                line: operation.location.line,
                message: `\`${operation.name}\`: an operation contract takes at most one type parameter, the context`,
            });
        }
        const existing = byName.get(operation.name);
        if (existing) {
            findings.push({
                filePath: operation.location.filePath,
                line: operation.location.line,
                message: `\`${operation.name}\`: ${existing.interfaceName} already declares it; operation names are file names`,
            });
        }
        byName.set(operation.name, operation);
    }
    return findings;
}

/** Print the findings in source order, then the count of operations they leave ungenerated. */
function report(findings: Diagnostic[], operations: number): void {
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
    for (const finding of findings) {
        console.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
    }
    console.error(`\n${findings.length} problem(s) in ${operations} operation(s)`);
}

/** Write a scaffold for every operation the spec adds, and check the modules already committed still meet their contract. */
export function run(spec: SpecModel, argv: readonly string[] = process.argv): number {
    const outIndex = argv.indexOf("--out");
    const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : argv[outIndex + 1];
    if (!outDir) {
        console.error("--out needs a directory");
        return 1;
    }

    const findings = validate(spec);
    const operations = spec.operations.filter((operation) => operation.operation);
    if (findings.length > 0) {
        report(findings, operations.length);
        return 1;
    }
    mkdirSync(outDir, { recursive: true });

    let created = 0;
    let verified = 0;
    for (const operation of operations) {
        const file = join(outDir, `${operation.name}.ts`);
        if (!existsSync(file)) {
            writeFileSync(file, renderOperationFile(operation, spec));
            created += 1;
            continue;
        }
        // A committed module is hand-written from here on, so regeneration only checks the contract annotation.
        if (!meetsContract(readFileSync(file, "utf8"), operation)) {
            findings.push({
                filePath: operation.location.filePath,
                line: operation.location.line,
                message: `\`${operation.name}\`: ${file} does not declare \`export const ${operation.name}: ${contractType(operation)}["${operation.name}"]\``,
            });
            continue;
        }
        verified += 1;
    }

    if (findings.length > 0) {
        report(findings, operations.length);
        return 1;
    }

    console.log(`operations OK (${created} created, ${verified} verified)`);
    return 0;
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
