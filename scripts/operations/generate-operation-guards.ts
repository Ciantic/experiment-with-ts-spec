/** Scaffold one permission guard per REST operation, and check that a hand-written guard enforces its permission. See docs/permissions.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { OPERATIONS_PACKAGE_ROOT } from "../paths.ts";
import { loadSpec, type Diagnostic, type RestPermission, type SpecModel } from "../spec/spec-model.ts";
import { buildRestModel, type RestModel, type RestOperationCall } from "../sdk/rest-model.ts";

/** The channels a run reports on: the console, or a caller's own sink. */
type Output = Pick<Console, "log" | "error">;

export type { Diagnostic };

/** Where the operation guard modules are written when no `--out` is given. */
const DEFAULT_OUT_DIR = join(OPERATIONS_PACKAGE_ROOT, "src/guards");

/** The first line of a scaffold: it names the generator that started the file, and who finishes it. */
export const SCAFFOLD_MARKER =
    "// Generated for implementation by: scripts/operations/generate-operation-guards.ts";

const GUARD_TYPE_IMPORT = "infra";
const ERRORS_IMPORT = "sdk/errors.ts";
const SCHEMAS_IMPORT = "sdk/schemas.ts";

/** One guard the spec needs: its name, the permission it enforces, and an operation that carries the input type. */
export interface GuardPlan {
    name: string;
    permission: RestPermission;
    /** One of the operations that uses the guard; its input names the guard's argument. */
    operation: RestOperationCall;
}

/** Group the calls by guard name, so an explicit guard shared by several calls is scaffolded once. */
export function buildGuardPlans(model: RestModel): { plans: GuardPlan[]; diagnostics: Diagnostic[] } {
    const byName = new Map<string, GuardPlan>();
    const diagnostics: Diagnostic[] = [];
    for (const operation of model.operations) {
        const { guardName, permission } = operation;
        if (guardName === undefined || permission === undefined) {
            continue;
        }
        const existing = byName.get(guardName);
        if (existing === undefined) {
            byName.set(guardName, { name: guardName, permission, operation });
            continue;
        }
        if (existing.permission.scope !== permission.scope || existing.permission.action !== permission.action) {
            diagnostics.push({
                ...operation.location,
                message: `\`${operation.id}\`: guard \`${guardName}\` is shared with a call that requires a different permission`,
            });
            continue;
        }
        // The guard's type must name an input, so prefer the call that has one when the calls disagree.
        if (existing.operation.inputTypeName === undefined && operation.inputTypeName !== undefined) {
            existing.operation = operation;
        }
    }
    const plans = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { plans, diagnostics };
}

/** The guard's declared type: the operation input it receives, or `undefined` when the call takes none. */
function guardType(operation: RestOperationCall): string {
    return operation.inputTypeName === undefined
        ? "RouteGuard<undefined>"
        : `RouteGuard<${operation.inputTypeName}>`;
}

/** The parameters the scaffold's body declares: a call with no input receives nothing. */
function guardParameters(operation: RestOperationCall): string {
    return operation.hasInput ? "ctx, argument" : "ctx";
}

/** Render a fail-closed guard module: the author replaces the body, and the permission names what to check. */
export function renderGuardScaffold(plan: GuardPlan): string {
    const { operation, permission, name } = plan;
    const lines: string[] = [SCAFFOLD_MARKER];
    lines.push(`import type { RouteGuard } from "${GUARD_TYPE_IMPORT}";`);
    lines.push(`import { NotImplemented } from "${ERRORS_IMPORT}";`);
    if (operation.inputTypeName !== undefined) {
        lines.push(`import type { ${operation.inputTypeName} } from "${SCHEMAS_IMPORT}";`);
    }
    lines.push("");
    lines.push("/**");
    lines.push(` * Guard \`${operation.id}\`: the session holds \`${permission.scope}:${permission.action}\`.`);
    lines.push(` * Replace the body with the check the call needs, keeping \`${permission.scope}:${permission.action}\` as the permission.`);
    lines.push(" * @throws {NotImplemented} until the guard is implemented");
    lines.push(" */");
    lines.push(`export const ${name}: ${guardType(operation)} = async (${guardParameters(operation)}) => {`);
    lines.push(
        `    throw new NotImplemented("${name} is scaffolded; implement the ${permission.scope}:${permission.action} check");`,
    );
    lines.push("};");
    lines.push("");
    return lines.join("\n");
}

/** The file a guard plan writes. */
function guardFile(outDir: string, plan: GuardPlan): string {
    return join(outDir, `${plan.name}.ts`);
}

/** The finding for a guard the spec needs and no module supplies. */
function missingGuard(file: string, plan: GuardPlan): Diagnostic {
    const shown = relative(process.cwd(), file);
    return {
        ...plan.operation.location,
        message: `\`${plan.operation.id}\`: ${shown} is missing for the ${plan.permission.scope}:${plan.permission.action} guard; run pnpm generate`,
    };
}

/** Whether a guard body names the permission, either joined or as the two arguments a check passes. */
function checksPermission(source: string, plan: GuardPlan): boolean {
    const { scope, action } = plan.permission;
    if (source.includes(`${scope}:${action}`)) {
        return true;
    }
    const quotes = [`"`, `'`];
    return quotes.some(
        (quote) => source.includes(`${quote}${scope}${quote}`) && source.includes(`${quote}${action}${quote}`),
    );
}

/** The finding for a guard whose body no longer names the permission the spec declares. */
function driftedGuard(file: string, plan: GuardPlan): Diagnostic {
    const shown = relative(process.cwd(), file);
    const permission = `${plan.permission.scope}:${plan.permission.action}`;
    return {
        ...plan.operation.location,
        message: `\`${plan.operation.id}\`: ${shown} does not name \`${permission}\`; update the guard to check the declared permission`,
    };
}

/** The finding for a guard module that no longer exports the name the route imports. */
function missingExport(file: string, plan: GuardPlan): Diagnostic {
    const shown = relative(process.cwd(), file);
    return {
        ...plan.operation.location,
        message: `\`${plan.operation.id}\`: ${shown} does not export \`${plan.name}\`; keep the name the annotation or operation id gives`,
    };
}

/** Whether a guard module exports the planned name, whatever its body. */
function exportsGuard(source: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`export\\s+const\\s+${escaped}\\s*[:=]`, "u").test(source);
}

/** Whether a module is still the untouched scaffold: its only statement throws {@link NotImplemented}. */
export function isGuardScaffold(source: string): boolean {
    const statements = [...source.matchAll(/^\s*(?:return|throw)\s/gmu)].length;
    return statements === 1 && /^\s*throw new NotImplemented\(/mu.test(source);
}

/** The scaffolds the spec no longer references, which a generate run removes. */
function staleScaffolds(outDir: string, keep: Set<string>): string[] {
    if (!existsSync(outDir)) {
        return [];
    }
    const stale: string[] = [];
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts") || keep.has(entry.name)) {
            continue;
        }
        const file = join(outDir, entry.name);
        const source = readFileSync(file, "utf8");
        if (source.split("\n", 1)[0] === SCAFFOLD_MARKER && isGuardScaffold(source)) {
            stale.push(file);
        }
    }
    return stale;
}

/** The finding for a scaffold whose permission annotation is gone. */
function staleScaffold(file: string): Diagnostic {
    return {
        filePath: relative(process.cwd(), file),
        line: 1,
        message: `\`${basename(file)}\` is no longer a guard the spec declares; run pnpm generate to remove its scaffold`,
    };
}

/** Report the findings of a `--check` run and return its exit code. */
function checkRun(plans: readonly GuardPlan[], outDir: string, output: Output): number {
    const findings: Diagnostic[] = [];
    for (const plan of plans) {
        const file = guardFile(outDir, plan);
        if (!existsSync(file)) {
            findings.push(missingGuard(file, plan));
            continue;
        }
        const source = readFileSync(file, "utf8");
        if (!exportsGuard(source, plan.name)) {
            findings.push(missingExport(file, plan));
        }
        if (!checksPermission(source, plan)) {
            findings.push(driftedGuard(file, plan));
        }
    }
    findings.push(...staleScaffolds(outDir, new Set(plans.map((plan) => `${plan.name}.ts`))).map(staleScaffold));
    if (findings.length > 0) {
        for (const finding of findings) {
            output.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
        }
        return 1;
    }
    output.log(`operation guards OK (${plans.length} guard(s) match the spec)`);
    return 0;
}

/** Create the missing guard scaffolds and remove the ones the spec has dropped. */
function generateRun(plans: readonly GuardPlan[], outDir: string, output: Output): number {
    mkdirSync(outDir, { recursive: true });
    let created = 0;
    let verified = 0;
    for (const plan of plans) {
        const file = guardFile(outDir, plan);
        if (existsSync(file)) {
            verified += 1;
            continue;
        }
        writeFileSync(file, renderGuardScaffold(plan));
        created += 1;
    }
    const stale = staleScaffolds(outDir, new Set(plans.map((plan) => `${plan.name}.ts`)));
    for (const file of stale) {
        rmSync(file);
    }
    output.log(`wrote ${created} operation guard(s), verified ${verified}, removed ${stale.length} scaffold(s) to ${outDir}`);
    return 0;
}

/** Scaffold the guards the spec adds, or with `--check`, verify each one still names its permission and write nothing. */
export function run(spec: SpecModel, argv: readonly string[] = process.argv, output: Output = console): number {
    const outIndex = argv.indexOf("--out");
    const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : argv[outIndex + 1];
    if (!outDir) {
        output.error("--out needs a directory");
        return 1;
    }

    const model = buildRestModel(spec);
    const { plans, diagnostics } = buildGuardPlans(model);
    const findings = [...model.diagnostics, ...diagnostics];
    if (findings.length > 0) {
        for (const finding of findings) {
            output.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
        }
        return 1;
    }

    return argv.includes("--check")
        ? checkRun(plans, outDir, output)
        : generateRun(plans, outDir, output);
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
