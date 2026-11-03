/** Scaffold one backend module per `@operation`, and verify each hand-written one still declares its contract. See docs/operations.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { BACKEND_PACKAGE_ROOT } from "../paths.ts";
import {
    loadSpec,
    type Diagnostic,
    type SpecModel,
    type SpecOperation,
} from "../spec/spec-model.ts";

/** The channels a run reports on: the console, or a caller's own sink. */
type Output = Pick<Console, "log" | "error">;

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

/** How the module on disk answers one operation the spec declares. */
type ModuleStatus = {
    operation: SpecOperation;
    file: string;
    state: "missing" | "drifted" | "ok";
};

/** Read every module once, so a check run and a generate run decide on the same facts. */
function inspect(operations: readonly SpecOperation[], outDir: string): ModuleStatus[] {
    return operations.map((operation) => {
        const file = join(outDir, `${operation.name}.ts`);
        if (!existsSync(file)) {
            return { operation, file, state: "missing" as const };
        }
        const state = meetsContract(readFileSync(file, "utf8"), operation) ? ("ok" as const) : ("drifted" as const);
        return { operation, file, state };
    });
}

/** The module names the spec still declares, so pruning leaves them alone. */
function keepModules(operations: readonly SpecOperation[]): Set<string> {
    return new Set(operations.map((operation) => `${operation.name}.ts`));
}

/** The finding for an operation the spec declares and no module answers. */
function missingModule(file: string, operation: SpecOperation): Diagnostic {
    const shown = relative(process.cwd(), file);
    return {
        filePath: shown,
        line: 1,
        message: `\`${operation.name}\`: the spec declares @operation but ${shown} is missing; run pnpm generate`,
    };
}

/** The finding for a module that no longer declares the contract the spec gives it. */
function driftedContract(file: string, operation: SpecOperation): Diagnostic {
    return {
        filePath: operation.location.filePath,
        line: operation.location.line,
        message: `\`${operation.name}\`: ${file} does not declare \`export const ${operation.name}: ${contractType(operation)}["${operation.name}"]\``,
    };
}

/** The finding for a scaffold whose operation the spec no longer declares. */
function staleScaffold(file: string): Diagnostic {
    return {
        filePath: relative(process.cwd(), file),
        line: 1,
        message: `\`${basename(file, ".ts")}\` no longer declares @operation; run pnpm generate to remove its scaffold`,
    };
}

/** Split the modules the spec no longer declares into scaffolds a generate run deletes and implementations it reports. */
function staleModules(outDir: string, keep: Set<string>): { scaffolds: string[]; findings: Diagnostic[] } {
    const scaffolds: string[] = [];
    const findings: Diagnostic[] = [];
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts") || keep.has(entry.name)) {
            continue;
        }
        const file = join(outDir, entry.name);
        const source = readFileSync(file, "utf8");
        if (isScaffold(source)) {
            scaffolds.push(file);
            continue;
        }
        // An implementation is the author's, so the generator reports it rather than deleting it.
        if (declaresContract(source)) {
            const shown = relative(process.cwd(), file);
            findings.push({
                filePath: shown,
                line: 1,
                message: `\`${basename(file, ".ts")}\` is no longer an @operation; delete ${shown} or restore the spec`,
            });
        }
    }
    return { scaffolds, findings };
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
function report(findings: Diagnostic[], operations: number, output: Output): void {
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
    for (const finding of findings) {
        output.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
    }
    output.error(`\n${findings.length} problem(s) in ${operations} operation(s)`);
}

/** Report the modules the spec no longer describes, writing and deleting nothing. */
function checkRun(operations: readonly SpecOperation[], outDir: string, output: Output): number {
    const findings: Diagnostic[] = [];
    let verified = 0;
    for (const status of inspect(operations, outDir)) {
        if (status.state === "ok") {
            verified += 1;
            continue;
        }
        findings.push(
            status.state === "missing"
                ? missingModule(status.file, status.operation)
                : driftedContract(status.file, status.operation),
        );
    }
    if (existsSync(outDir)) {
        const stale = staleModules(outDir, keepModules(operations));
        findings.push(...stale.findings, ...stale.scaffolds.map(staleScaffold));
    }
    if (findings.length > 0) {
        report(findings, operations.length, output);
        return 1;
    }
    output.log(`operations OK (${verified} file(s) declare the spec's operations)`);
    return 0;
}

/** Scaffold the modules the spec adds, verify the committed ones, and delete the scaffolds it no longer declares. */
function generateRun(operations: readonly SpecOperation[], outDir: string, output: Output): number {
    mkdirSync(outDir, { recursive: true });
    const findings: Diagnostic[] = [];
    let created = 0;
    let verified = 0;
    for (const status of inspect(operations, outDir)) {
        if (status.state === "missing") {
            writeFileSync(status.file, renderOperationFile(status.operation));
            created += 1;
            continue;
        }
        if (status.state === "drifted") {
            findings.push(driftedContract(status.file, status.operation));
            continue;
        }
        verified += 1;
    }
    const stale = staleModules(outDir, keepModules(operations));
    findings.push(...stale.findings);
    for (const file of stale.scaffolds) {
        rmSync(file);
    }
    if (findings.length > 0) {
        report(findings, operations.length, output);
        return 1;
    }
    output.log(`operations OK (${created} created, ${verified} verified, ${stale.scaffolds.length} removed)`);
    return 0;
}

/** Scaffold the operations the spec adds, or with `--check`, report the modules that no longer match it and write nothing. */
export function run(spec: SpecModel, argv: readonly string[] = process.argv, output: Output = console): number {
    const outIndex = argv.indexOf("--out");
    const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : argv[outIndex + 1];
    if (!outDir) {
        output.error("--out needs a directory");
        return 1;
    }

    const findings = validate(spec);
    const operations = spec.operations.filter((operation) => operation.operation);
    if (findings.length > 0) {
        report(findings, operations.length, output);
        return 1;
    }
    // The mode picks the whole procedure: a check run reports what a generate run would repair.
    return argv.includes("--check")
        ? checkRun(operations, outDir, output)
        : generateRun(operations, outDir, output);
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
