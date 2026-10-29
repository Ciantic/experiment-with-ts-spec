/** Unit tests for the spec-test scaffolder, driven by self-contained fixtures and a temp directory. See docs/testing.md and docs/spec-tests.md. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "../spec/spec-model.ts";
import {
    isSpecTestScaffold,
    renderSpecTestFile,
    run,
    specTestDrift,
    SPEC_TEST_MARKER,
    SPEC_TEST_SUFFIX,
} from "./generate-spec-tests.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A contract with two describes, each carrying rows, and one operation without any. */
const OPERATIONS = `
export interface WidgetOperations<T> {
    /**
     * Freeze the widget.
     *
     * @operation
     * @testDescribe freezing a widget
     * @testIt refuses a widget that is already frozen
     * @testIt records who froze it
     * @testDescribe a frozen widget
     * @testIt keeps its original owner
     */
    freezeWidget(ctx: T): Promise<void>;

    /**
     * Read the widget.
     *
     * @operation
     */
    readWidget(ctx: T): Promise<void>;
}
`.trim();

/** The same contract with the second row and the second describe taken out. */
const ONE_ROW = `
export interface WidgetOperations<T> {
    /**
     * Freeze the widget.
     *
     * @operation
     * @testDescribe freezing a widget
     * @testIt refuses a widget that is already frozen
     */
    freezeWidget(ctx: T): Promise<void>;
}
`.trim();

/** The contract after both test tags are taken out, so the operation no longer declares a spec test. */
const WITHOUT_TESTS = `
export interface WidgetOperations<T> {
    /**
     * Freeze the widget.
     *
     * @operation
     */
    freezeWidget(ctx: T): Promise<void>;
}
`.trim();

/** Build a model from in-memory sources, so no test reads the real spec. */
function build(source = OPERATIONS): SpecModel {
    return parseInMemorySpec([{ filePath: join(SPEC_SRC_ROOT, "fixtures", "WidgetOperations.ts"), sourceFileText: source }], {
        sourceGlob: SPEC_GLOB,
    });
}

function operation(spec: SpecModel) {
    const found = spec.operations.find((candidate) => candidate.name === "freezeWidget");
    if (!found) {
        throw new Error("fixture is missing the freezeWidget operation");
    }
    return found;
}

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "spec-tests-"));
    dirs.push(dir);
    return dir;
}

describe("parse", () => {
    it("groups the rows under the describe written above them, in source order", () => {
        const { tests, strayTests } = operation(build());

        expect(tests.map((block) => [block.describe, block.tests.map((row) => row.text)])).toEqual([
            ["freezing a widget", ["refuses a widget that is already frozen", "records who froze it"]],
            ["a frozen widget", ["keeps its original owner"]],
        ]);
        expect(strayTests).toEqual([]);
    });

    it("keeps a row written before any describe apart, so the linter can report it", () => {
        const { tests, strayTests } = operation(
            build(`
export interface WidgetOperations<T> {
    /**
     * @operation
     * @testIt keeps its original owner
     * @testDescribe freezing a widget
     * @testIt refuses a frozen widget
     */
    freezeWidget(ctx: T): Promise<void>;
}
`),
        );

        expect(strayTests.map((row) => row.text)).toEqual(["keeps its original owner"]);
        expect(tests.map((block) => block.tests.map((row) => row.text))).toEqual([["refuses a frozen widget"]]);
    });
});

describe("renderSpecTestFile", () => {
    it("writes one describe per block, with its rows in order", () => {
        const code = renderSpecTestFile(operation(build()));

        expect(code).toContain('describe("freezing a widget", () => {');
        expect(code.indexOf('it("refuses a widget that is already frozen"')).toBeLessThan(
            code.indexOf('it("records who froze it"'),
        );
        expect(code).toContain('describe("a frozen widget", () => {');
        expect(code).toContain('it("keeps its original owner"');
    });

    it("makes every test fail until it is implemented", () => {
        const code = renderSpecTestFile(operation(build()));

        expect(code).toContain(
            'throw new NotImplemented("refuses a widget that is already frozen is scaffolded but not implemented");',
        );
        expect(code).toContain('import { NotImplemented } from "sdk/errors.ts";');
    });

    it("writes the prose as a literal, so a name cannot break the module", () => {
        const code = renderSpecTestFile(
            operation(
                build(`
export interface WidgetOperations<T> {
    /**
     * @operation
     * @testDescribe a "quoted" name
     * @testIt it isn't escaped
     */
    freezeWidget(ctx: T): Promise<void>;
}
`),
            ),
        );

        expect(code).toContain('describe("a \\"quoted\\" name", () => {');
        expect(code).toContain('it("it isn\'t escaped", () => {');
    });

    it("marks the file with the generator that wrote it", () => {
        expect(renderSpecTestFile(operation(build())).split("\n", 1)[0]).toBe(SPEC_TEST_MARKER);
    });
});

describe("scaffold detection", () => {
    it("recognizes the file it wrote", () => {
        expect(isSpecTestScaffold(renderSpecTestFile(operation(build())))).toBe(true);
    });

    it("treats a file that asserts as an implementation", () => {
        const implemented = `${SPEC_TEST_MARKER}
import { describe, expect, it } from "vitest";
import { freezeWidget } from "./freezeWidget.ts";

describe("freezing a widget", () => {
    it("refuses a frozen widget", async () => {
        await expect(freezeWidget({}, {})).rejects.toThrow();
    });
});
`;

        expect(isSpecTestScaffold(implemented)).toBe(false);
    });

    it("treats a file with one filled-in body as an implementation", () => {
        const partly = renderSpecTestFile(operation(build())).replace(
            '        throw new NotImplemented("records who froze it is scaffolded but not implemented");',
            "        return undefined;",
        );

        expect(isSpecTestScaffold(partly)).toBe(false);
    });

    it("ignores a file that declares no test", () => {
        expect(isSpecTestScaffold("export const helper = (): void => {};\n")).toBe(false);
    });
});

describe("specTestDrift", () => {
    it("accepts the scaffold it wrote", () => {
        const spec = build();

        expect(specTestDrift(renderSpecTestFile(operation(spec)), operation(spec))).toBeUndefined();
    });

    it("accepts a file whose bodies are filled in, when the tests are the spec's", () => {
        const source = `import { describe, expect, it } from "vitest";

describe("freezing a widget", () => {
    beforeEach(() => {
        setup();
    });
    it('refuses a widget that is already frozen', () => {
        expect(true).toBe(true);
    });
    it("records who froze it", () => {
        expect(true).toBe(true);
    });
});

describe("a frozen widget", () => {
    it("keeps its original owner", () => {
        expect(true).toBe(true);
    });
});
`;

        expect(specTestDrift(source, operation(build()))).toBeUndefined();
    });

    it("reports a test the file is missing", () => {
        const source = renderSpecTestFile(operation(build())).replace(/\s*it\("records who froze it"[\s\S]*?\}\);\n/u, "");

        expect(specTestDrift(source, operation(build()))).toBe('the spec\'s it("records who froze it") is missing');
    });

    it("reports a test the file adds that the spec does not declare", () => {
        const source = renderSpecTestFile(operation(build())).replace(
            'describe("a frozen widget"',
            'it("a test of my own", () => {});\n\ndescribe("a frozen widget"',
        );

        expect(specTestDrift(source, operation(build()))).toBe('it("a test of my own") is not a test the spec declares');
    });

    it("reports a renamed test", () => {
        const source = renderSpecTestFile(operation(build())).replace("records who froze it", "records the freezer");

        expect(specTestDrift(source, operation(build()))).toBe(
            'the spec declares it("records who froze it") here, but the file declares it("records the freezer")',
        );
    });

    it("reports a describe the spec does not declare", () => {
        const source = renderSpecTestFile(operation(build())).replace("a frozen widget", "a sent widget");

        expect(specTestDrift(source, operation(build()))).toBe(
            'the spec declares describe("a frozen widget") here, but the file declares describe("a sent widget")',
        );
    });

    it("reports a test the file moved under another describe", () => {
        const source = renderSpecTestFile(operation(build()))
            .replace('    it("records who froze it", () => {\n        throw new NotImplemented("records who froze it is scaffolded but not implemented");\n    });\n', "")
            .replace(
                'describe("a frozen widget", () => {\n    it("keeps its original owner"',
                'describe("a frozen widget", () => {\n    it("records who froze it", () => {\n        throw new NotImplemented("records who froze it is scaffolded but not implemented");\n    });\n    it("keeps its original owner"',
            );

        expect(specTestDrift(source, operation(build()))).not.toBeUndefined();
    });
});

describe("run", () => {
    it("writes the spec test beside the operation, and nothing for an operation without tags", () => {
        const dir = tempDir();

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(existsSync(join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`))).toBe(true);
        expect(existsSync(join(dir, `readWidget${SPEC_TEST_SUFFIX}`))).toBe(false);
    });

    it("rewrites an unedited scaffold when the spec adds a row", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(readFileSync(file, "utf8")).toContain("records who froze it");
    });

    it("keeps an edited spec test that still declares the tests the spec declares", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(
            file,
            `import { describe, expect, it } from "vitest";\n\ndescribe("freezing a widget", () => {\n    it("refuses a widget that is already frozen", () => {\n        expect(true).toBe(true);\n    });\n});\n`,
        );

        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);

        expect(readFileSync(file, "utf8")).toContain("expect(true).toBe(true);");
    });

    it("fails when an edited spec test drops a test the spec declares", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        const edited = `import { describe, expect, it } from "vitest";

describe("freezing a widget", () => {
    it("a test the spec does not declare", () => {
        expect(true).toBe(true);
    });
});
`;
        writeFileSync(file, edited);

        expect(run(build(), ["--out", dir], SILENT)).toBe(1);
        expect(readFileSync(file, "utf8")).toBe(edited);
    });

    it("rewrites a scaffold that only gained a comment, since its bodies still throw", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(file, `${readFileSync(file, "utf8")}// notes to self\n`);

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(readFileSync(file, "utf8")).not.toContain("// notes to self");
        expect(readFileSync(file, "utf8")).toContain("records who froze it");
    });

    it("removes the scaffold of an operation that no longer declares tests", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(run(build(WITHOUT_TESTS), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`))).toBe(false);
    });

    it("keeps an edited spec test whose tags are gone, and reports it", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(file, "import { it } from \"vitest\";\nit(\"mine\", () => {});\n");

        expect(run(build(WITHOUT_TESTS), ["--out", dir], SILENT)).toBe(1);
        expect(existsSync(file)).toBe(true);
    });

    it("leaves a hand-written test file alone, since only the spec-test suffix is its own", () => {
        const dir = tempDir();
        const handWritten = join(dir, "freezeWidget.test.ts");
        writeFileSync(handWritten, "import { it } from \"vitest\";\nit(\"mine\", () => {});\n");

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(existsSync(handWritten)).toBe(true);
    });
});

describe("--check", () => {
    it("passes when the files declare the tests the spec declares", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(0);
    });

    it("passes for an edited file whose tests are still the spec's", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(
            file,
            `import { describe, expect, it } from "vitest";\n\ndescribe("freezing a widget", () => {\n    it("refuses a widget that is already frozen", () => {\n        expect(true).toBe(true);\n    });\n});\n`,
        );

        expect(run(build(ONE_ROW), ["--check", "--out", dir], SILENT)).toBe(0);
    });

    it("fails when a file adds a test the spec does not declare", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(
            file,
            `${readFileSync(file, "utf8")}
describe("a block of my own", () => {\n    it("my own test", () => {});\n});\n`,
        );

        expect(run(build(ONE_ROW), ["--check", "--out", dir], SILENT)).toBe(1);
    });

    it("fails when a file is missing a test the spec declares", () => {
        const dir = tempDir();
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(file, readFileSync(file, "utf8").replace(/\s*describe\("a frozen widget"[\s\S]*$/u, "\n"));

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);
    });

    it("fails when the spec declares tests and no file exists", () => {
        expect(run(build(), ["--check", "--out", tempDir()], SILENT)).toBe(1);
    });

    it("writes nothing, leaving a drifting scaffold for the author to regenerate", () => {
        const dir = tempDir();
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        const file = join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`);
        const before = readFileSync(file, "utf8");

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);

        expect(readFileSync(file, "utf8")).toBe(before);
        expect(existsSync(join(dir, `readWidget${SPEC_TEST_SUFFIX}`))).toBe(false);
    });

    it("reports a spec test whose operation no longer declares any", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(run(build(WITHOUT_TESTS), ["--check", "--out", dir], SILENT)).toBe(1);
        expect(existsSync(join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`))).toBe(true);
    });

    it("reports a stale scaffold as one to regenerate, rather than as drift in hand-written tests", () => {
        const dir = tempDir();
        expect(run(build(ONE_ROW), ["--out", dir], SILENT)).toBe(0);
        const error = vi.fn();

        expect(run(build(), ["--check", "--out", dir], { log: vi.fn(), error })).toBe(1);
        expect(error.mock.calls.map(([line]) => line).join("\n")).toContain("run pnpm generate to rewrite it");
    });

    it("does not create the output directory, so a check run leaves the tree untouched", () => {
        const dir = join(tempDir(), "missing");

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);
        expect(existsSync(dir)).toBe(false);
    });
});

describe("refusals", () => {
    it("fails when @testIt is written before any @testDescribe", () => {
        const spec = build(`
export interface WidgetOperations<T> {
    /**
     * @operation
     * @testIt keeps its original owner
     */
    freezeWidget(ctx: T): Promise<void>;
}
`);

        expect(run(spec, ["--out", tempDir()], SILENT)).toBe(1);
    });

    it("fails when the tags sit on a method that is not an operation", () => {
        const spec = build(`
export interface WidgetOperations<T> {
    /**
     * @testDescribe freezing a widget
     * @testIt refuses a frozen widget
     */
    freezeWidget(ctx: T): Promise<void>;
}
`);

        expect(run(spec, ["--out", tempDir()], SILENT)).toBe(1);
    });

    it("writes nothing when the spec itself is refused", () => {
        const dir = tempDir();
        const spec = build(`
export interface WidgetOperations<T> {
    /**
     * @operation
     * @testIt keeps its original owner
     */
    freezeWidget(ctx: T): Promise<void>;
}
`);

        expect(run(spec, ["--out", dir], SILENT)).toBe(1);
        expect(existsSync(join(dir, `freezeWidget${SPEC_TEST_SUFFIX}`))).toBe(false);
    });
});
