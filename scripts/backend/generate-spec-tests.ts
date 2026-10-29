/** Scaffold one `{operation}.spec.test.ts` per `@testDescribe`/`@testIt`, and verify a hand-written one declares those tests. See docs/spec-tests.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKEND_PACKAGE_ROOT } from "../paths.ts";
import { loadSpec, type Diagnostic, type SpecModel, type SpecOperation } from "../spec/spec-model.ts";

/** The channels a run reports on: the console, or a caller's own sink. */
type Output = Pick<Console, "log" | "error">;

export type { Diagnostic };

/** Where the spec tests are written when no `--out` is given: beside the operation modules they exercise. */
const DEFAULT_OUT_DIR = join(BACKEND_PACKAGE_ROOT, "src/operations");

/** The suffix a spec test takes, so it sits beside the operation module rather than in its own directory. */
export const SPEC_TEST_SUFFIX = ".spec.test.ts";

/** The first line of a scaffold: it names the generator that started the file, and who finishes it. */
export const SPEC_TEST_MARKER = "// Generated for implementation by: scripts/backend/generate-spec-tests.ts";

/** The shared errors module the scaffold throws from. */
const ERRORS_IMPORT = "sdk/errors.ts";

/** A describe or it name is prose, so it is written as a literal rather than into the source as is. */
function literal(text: string): string {
    return JSON.stringify(text);
}

/** Render the spec test an operation starts from: one describe per block, one refusing it per row. */
export function renderSpecTestFile(operation: SpecOperation): string {
    const lines: string[] = [SPEC_TEST_MARKER];
    lines.push('import { describe, it } from "vitest";');
    lines.push(`import { NotImplemented } from "${ERRORS_IMPORT}";`);
    lines.push("");
    for (const block of operation.tests) {
        lines.push(`describe(${literal(block.describe)}, () => {`);
        for (const row of block.tests) {
            const message = `${row.text} is scaffolded but not implemented`;
            lines.push(`    it(${literal(row.text)}, () => {`);
            lines.push(`        throw new NotImplemented(${literal(message)});`);
            lines.push("    });");
        }
        lines.push("});");
        lines.push("");
    }
    return lines.join("\n");
}

/** Whether a spec test is still the scaffold: every `it` it declares throws, and it asserts nothing. */
export function isSpecTestScaffold(source: string): boolean {
    // An implementation asserts, whatever its bodies look like, so a file that asserts is never overwritten.
    if (/\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/u.test(source)) {
        return false;
    }
    const declared = declaredTests(source).filter((call) => call.kind === "it").length;
    const scaffolded = [...source.matchAll(/throw new NotImplemented\(/gu)].length;
    return declared > 0 && declared === scaffolded;
}

/** One describe or it the spec declares, or a test file writes, in source order. */
export interface SpecTestCall {
    kind: "describe" | "it";
    text: string;
}

/** Read the text of a quoted literal, so a name written with either quote compares as the same name. */
function decodeLiteral(literal: string): string {
    return literal
        .slice(1, -1)
        .replace(/\\(.)/gu, (_match, character: string) => (character === "n" ? "\n" : character === "t" ? "\t" : character));
}

/** The describe and it calls a test file declares, in source order; a name has to be a string literal to be read. */
export function declaredTests(source: string): SpecTestCall[] {
    const pattern = /\b(describe|it)\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/gu;
    const calls: SpecTestCall[] = [];
    for (const match of source.matchAll(pattern)) {
        calls.push({ kind: match[1] === "describe" ? "describe" : "it", text: decodeLiteral(match[2] ?? "") });
    }
    return calls;
}

/** The describe and it calls the spec declares for an operation, flattened in the order they are written. */
function specTests(operation: SpecOperation): SpecTestCall[] {
    return operation.tests.flatMap((block) => [
        { kind: "describe" as const, text: block.describe },
        ...block.tests.map((row) => ({ kind: "it" as const, text: row.text })),
    ]);
}

/** A call as a finding reads it, e.g. `it("keeps the owner")`. */
function callText(call: SpecTestCall): string {
    return `${call.kind}(${JSON.stringify(call.text)})`;
}

/** How often each declared call appears, keyed by the way it reads in a finding. */
function countCalls(calls: SpecTestCall[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const call of calls) {
        const key = callText(call);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

/** The first difference between what a file declares and what the spec declares; undefined when they agree. */
export function specTestDrift(source: string, operation: SpecOperation): string | undefined {
    const expected = specTests(operation);
    const actual = declaredTests(source);
    // A different number of calls is a test that is missing or extra, which reads better than a positional mismatch.
    if (expected.length !== actual.length) {
        const wanted = countCalls(expected);
        const found = countCalls(actual);
        for (const [key, count] of wanted) {
            if ((found.get(key) ?? 0) < count) {
                return `the spec's ${key} is missing`;
            }
        }
        for (const [key, count] of found) {
            if (count > (wanted.get(key) ?? 0)) {
                return `${key} is not a test the spec declares`;
            }
        }
    }
    for (let index = 0; index < expected.length; index += 1) {
        const want = expected[index];
        const got = actual[index];
        if (want !== undefined && got !== undefined && (want.kind !== got.kind || want.text !== got.text)) {
            return `the spec declares ${callText(want)} here, but the file declares ${callText(got)}`;
        }
    }
    return undefined;
}

/** Report the spec-test declarations the generator cannot scaffold. */
function validate(spec: SpecModel): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const operation of spec.operations) {
        if (operation.tests.length === 0 && operation.strayTests.length === 0) {
            continue;
        }
        if (!operation.operation) {
            findings.push({
                filePath: operation.location.filePath,
                line: operation.location.line,
                message: `\`${operation.name}\`: @testDescribe and @testIt belong on an @operation method`,
            });
        }
        for (const row of operation.strayTests) {
            findings.push({
                filePath: row.location.filePath,
                line: row.location.line,
                message: `\`${operation.name}\`: @testIt comes after the @testDescribe that names its block`,
            });
        }
    }
    return findings;
}

/** Print the findings in source order, then the count of operations they leave unscaffolded. */
function report(findings: Diagnostic[], operations: number, output: Output): void {
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
    for (const finding of findings) {
        output.error(`${finding.filePath}:${finding.line}: ${finding.message}`);
    }
    output.error(`\n${findings.length} problem(s) in ${operations} operation(s)`);
}

/** Remove the spec tests the spec no longer declares, and report the implementations it drops. */
function pruneStale(outDir: string, keep: Set<string>, findings: Diagnostic[], remove: boolean): number {
    let removed = 0;
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(SPEC_TEST_SUFFIX) || keep.has(entry.name)) {
            continue;
        }
        const file = join(outDir, entry.name);
        const name = entry.name.slice(0, -SPEC_TEST_SUFFIX.length);
        const shown = relative(process.cwd(), file);
        if (isSpecTestScaffold(readFileSync(file, "utf8"))) {
            if (remove) {
                rmSync(file);
                removed += 1;
            } else {
                findings.push({ filePath: shown, line: 1, message: `\`${name}\` no longer declares @testDescribe and @testIt; run pnpm generate to remove its scaffold` });
            }
            continue;
        }
        // An implemented spec test is the author's, so the generator reports it rather than deleting it.
        findings.push({
            filePath: shown,
            line: 1,
            message: `\`${name}\` no longer declares @testDescribe and @testIt; delete ${shown} or restore the spec`,
        });
    }
    return removed;
}

/** Write a spec test for every operation that declares one, keep the edited ones, and prune the rest. */
export function run(spec: SpecModel, argv: readonly string[] = process.argv, output: Output = console): number {
    // `--check` writes nothing: it is the lint step that reports a file the spec no longer describes.
    const check = argv.includes("--check");
    const outIndex = argv.indexOf("--out");
    const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : argv[outIndex + 1];
    if (!outDir) {
        output.error("--out needs a directory");
        return 1;
    }

    const declared = spec.operations.filter(
        (operation) => operation.tests.length > 0 || operation.strayTests.length > 0,
    );
    const tested = declared.filter((operation) => operation.tests.length > 0);
    const findings = validate(spec);
    if (findings.length > 0) {
        report(findings, declared.length, output);
        return 1;
    }
    if (tested.length > 0 && !check) {
        mkdirSync(outDir, { recursive: true });
    }

    let created = 0;
    let regenerated = 0;
    let verified = 0;
    for (const operation of tested) {
        const file = join(outDir, `${operation.name}${SPEC_TEST_SUFFIX}`);
        const rendered = renderSpecTestFile(operation);
        const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        if (existing === undefined) {
            if (check) {
                const shown = relative(process.cwd(), file);
                findings.push({
                    filePath: shown,
                    line: 1,
                    message: `\`${operation.name}\`: the spec declares its tests but ${shown} is missing; run pnpm generate`,
                });
                continue;
            }
            writeFileSync(file, rendered);
            created += 1;
            continue;
        }
        // An unedited scaffold follows the spec; an edited one is hand-written from here on and is only verified.
        if (existing === rendered) {
            verified += 1;
            continue;
        }
        if (!check && isSpecTestScaffold(existing)) {
            writeFileSync(file, rendered);
            regenerated += 1;
            continue;
        }
        // The spec defines which tests the file declares, so a drift is a finding rather than a silent merge.
        const drift = specTestDrift(existing, operation);
        if (drift !== undefined) {
            findings.push({
                filePath: relative(process.cwd(), file),
                line: 1,
                message: `\`${operation.name}\`: ${drift}; the spec defines the tests, so the file must match it`,
            });
            continue;
        }
        verified += 1;
    }

    const keep = new Set(tested.map((operation) => `${operation.name}${SPEC_TEST_SUFFIX}`));
    const removed = existsSync(outDir) ? pruneStale(outDir, keep, findings, !check) : 0;

    if (findings.length > 0) {
        report(findings, declared.length, output);
        return 1;
    }

    if (check) {
        output.log(`spec tests OK (${verified} file(s) declare the spec's tests)`);
        return 0;
    }
    output.log(`spec tests OK (${created} created, ${regenerated} regenerated, ${verified} verified, ${removed} removed)`);
    return 0;
}

if (import.meta.main) {
    process.exitCode = run(loadSpec());
}
