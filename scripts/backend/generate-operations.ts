/** Scaffold one backend module per `@operation`, and verify each hand-written one still declares its contract. See docs/operations.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKEND_PACKAGE_ROOT } from "../paths.ts";
import {
    loadSpec,
    type Diagnostic,
    type SpecModel,
    type SpecOperation,
} from "../spec/spec-model.ts";

export type { Diagnostic };

/** Where the operation modules are written when no `--out` is given. */
const DEFAULT_OUT_DIR = join(BACKEND_PACKAGE_ROOT, "src/operations");

/** The context a fresh scaffold takes: the implementer chooses it, so the placeholder names nothing. */
const PLACEHOLDER_CONTEXT = "unknown";

/** The first line of a scaffold: it names the generator that started the file, and who finishes it. */
export const SCAFFOLD_MARKER = "// Generated for implementation by: scripts/backend/generate-operations.ts";

/** The shared errors module the scaffold throws from. */
const ERRORS_IMPORT = "sdk/errors.ts";

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

/** Render the module a new operation starts from: the contract annotation, the doc, and a refusing body. */
export function renderOperationFile(operation: SpecOperation): string {
    const lines: string[] = [SCAFFOLD_MARKER];
    lines.push(`import type { ${operation.interfaceName} } from "${operation.importSpecifier}";`);
    lines.push(`import { NotImplemented } from "${ERRORS_IMPORT}";`);
    lines.push("");

    lines.push("/**");
    for (const line of operation.description) {
        lines.push(` * ${line}`);
    }
    if (operation.description.length > 0) {
        lines.push(" *");
    }
    for (const thrown of operation.throws) {
        lines.push(` * @throws {${thrown.name}} ${thrown.reason}`);
    }
    // The scaffold's own throw is documented too, since the body is what raises it.
    lines.push(" * @throws {NotImplemented} when the operation is still the scaffold; remove this tag with the throw");
    lines.push(" */");

    const parameters = operation.parameters.map((parameter) => parameter.name).join(", ");
    const asyncKeyword = isPromise(operation) ? "async " : "";
    lines.push(`export const ${operation.name}: ${contractType(operation)}["${operation.name}"] = ${asyncKeyword}(${parameters}) => {`);
    lines.push(`    throw new NotImplemented("${operation.name} is scaffolded but not implemented");`);
    lines.push("};");
    lines.push("");
    return lines.join("\n");
}

/** Whether a module is still the untouched scaffold: its only statement throws {@link NotImplemented}. */
export function isScaffold(source: string): boolean {
    // The marker names where the file came from; the body decides, since an author may implement without removing it.
    const statements = [...source.matchAll(/^\s*(?:return|throw)\s/gmu)].length;
    return statements === 1 && /^\s*throw new NotImplemented\(/mu.test(source);
}

/** Whether a module exports an operation under a contract annotation, whatever its body. */
export function declaresContract(source: string): boolean {
    return /export\s+const\s+\w+\s*:\s*\w+(?:\s*<[^=;]*?>)?\s*\[\s*["']\w+["']\s*\]\s*=/u.test(source);
}

/** Remove the scaffolds of operations the spec no longer declares, and report the implementations it drops. */
function pruneStale(outDir: string, keep: Set<string>, findings: Diagnostic[]): number {
    let removed = 0;
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts") || keep.has(entry.name)) {
            continue;
        }
        const file = join(outDir, entry.name);
        const source = readFileSync(file, "utf8");
        if (isScaffold(source)) {
            rmSync(file);
            removed += 1;
            continue;
        }
        // An implementation is the author's, so the generator reports it rather than deleting it.
        if (declaresContract(source)) {
            findings.push({
                filePath: relative(process.cwd(), file),
                line: 1,
                message: `\`${entry.name.slice(0, -".ts".length)}\` is no longer an @operation; delete ${relative(process.cwd(), file)} or restore the spec`,
            });
        }
    }
    return removed;
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
            // A method carrying only spec-test tags is the linter's finding, and it is no operation to scaffold.
            if (operation.rest) {
                findings.push({
                    filePath: operation.location.filePath,
                    line: operation.location.line,
                    message: `\`${operation.name}\`: @restOperation requires @operation`,
                });
            }
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
            writeFileSync(file, renderOperationFile(operation));
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

    const removed = pruneStale(outDir, new Set(operations.map((operation) => `${operation.name}.ts`)), findings);

    if (findings.length > 0) {
        report(findings, operations.length);
        return 1;
    }

    console.log(`operations OK (${created} created, ${verified} verified, ${removed} removed)`);
    return 0;
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
