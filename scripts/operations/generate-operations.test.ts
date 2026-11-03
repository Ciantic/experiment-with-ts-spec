/** Unit tests for the operation scaffold generator, driven by self-contained fixtures and a temp directory. See docs/testing.md. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "../spec/spec-model.ts";
import {
    declaresContract,
    isScaffold,
    meetsContract,
    renderOperationFile,
    run,
    SCAFFOLD_MARKER,
} from "./generate-operations.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A returned entity the fixture contract can reference. */
const SENT = `
/**
 * @entity
 */
export interface InvoiceSent {
    /** @primaryKey */
    id: string;
}
`.trim();

/** A contract with one operation, a context parameter, a documented error, and a promise return. */
const OPERATIONS = `
import type { InvoiceSent } from "./InvoiceSent.ts";

export interface InvoiceOperations<T> {
    /**
     * Send the invoice to the recipient.
     *
     * @throws {InvoiceDetailsError} thrown when Invoice doesn't have enough details to be sent
     *
     * @operation
     * @restOperation
     */
    sendInvoice(ctx: T, opts: { invoice: string }): Promise<InvoiceSent>;
}
`.trim();

/** The contract after the operation is deleted from it. */
const WITHOUT_SEND = `
export interface InvoiceOperations<T> {
    /** Nothing to do. */
    idle(ctx: T): void;
}
`.trim();

/** Build a model from in-memory sources, so no test reads the real spec. */
function build(files: Record<string, string> = { "InvoiceSent.ts": SENT, "InvoiceOperations.ts": OPERATIONS }): SpecModel {
    const sources = Object.entries(files).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", name),
        sourceFileText,
    }));
    return parseInMemorySpec(sources, { sourceGlob: SPEC_GLOB });
}

function operation(spec: SpecModel) {
    const found = spec.operations.find((candidate) => candidate.name === "sendInvoice");
    if (!found) {
        throw new Error("fixture is missing the sendInvoice operation");
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
    const dir = mkdtempSync(join(tmpdir(), "operations-"));
    dirs.push(dir);
    return dir;
}

describe("renderOperationFile", () => {
    it("declares the operation under its contract annotation", () => {
        const spec = build();

        expect(renderOperationFile(operation(spec))).toContain(
            'export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {',
        );
    });

    it("leaves the context to the implementer", () => {
        const code = renderOperationFile(operation(build()));

        expect(code).toContain("InvoiceOperations<unknown>");
        expect(code).not.toContain("SqlExecutor");
    });

    it("imports the contract and the error its body throws", () => {
        const code = renderOperationFile(operation(build()));

        expect(code).toContain('import type { InvoiceOperations } from "spec/fixtures/InvoiceOperations.ts";');
        expect(code).toContain('import { NotImplemented } from "sdk/errors.ts";');
    });

    it("copies the operation's prose and its declared errors into the doc comment", () => {
        const code = renderOperationFile(operation(build()));

        expect(code).toContain(" * Send the invoice to the recipient.");
        expect(code).toContain(
            " * @throws {InvoiceDetailsError} thrown when Invoice doesn't have enough details to be sent",
        );
        expect(code).not.toContain("@operation");
        expect(code).not.toContain("@restOperation");
    });

    it("documents the throw it writes, since the scaffold is what raises it", () => {
        const code = renderOperationFile(operation(build()));

        expect(code).toContain(
            " * @throws {NotImplemented} when the operation is still the scaffold; remove this tag with the throw",
        );
    });

    it("throws NotImplemented, so a forgotten implementation is a 501 rather than a null answer", () => {
        const code = renderOperationFile(operation(build()));

        expect(code).toContain('throw new NotImplemented("sendInvoice is scaffolded but not implemented");');
    });

    it("keeps the method async when the contract returns a promise, and plain otherwise", () => {
        const plain = build({
            "Ops.ts": `
export interface Ops<T> {
    /** @operation */
    count(ctx: T): number;
}`,
        });
        const count = plain.operations[0];
        if (!count) {
            throw new Error("fixture is missing the count operation");
        }
        const code = renderOperationFile(count);

        expect(code).toContain('export const count: Ops<unknown>["count"] = (ctx) => {');
        expect(code).toContain('throw new NotImplemented("count is scaffolded but not implemented");');
    });
});

describe("scaffold provenance", () => {
    it("marks a fresh scaffold, so the generator can tell it from an implementation", () => {
        expect(renderOperationFile(operation(build())).split("\n", 1)[0]).toBe(SCAFFOLD_MARKER);
    });

    it("recognizes a scaffold whether or not its marker was kept", () => {
        expect(
            isScaffold(`${SCAFFOLD_MARKER}
export const sendInvoice: Ops["sendInvoice"] = async (ctx) => {
    throw new NotImplemented("not implemented");
};
`),
        ).toBe(true);
        expect(
            isScaffold(`
export const sendInvoice: Ops["sendInvoice"] = async (ctx) => {
    throw new NotImplemented("not implemented");
};
`),
        ).toBe(true);
    });

    it("does not call an implemented module a scaffold, even when it kept the marker", () => {
        const implemented = `${SCAFFOLD_MARKER}
export const sendInvoice: Ops["sendInvoice"] = async (ctx) => {
    return await deliver(ctx.db);
};
`;

        expect(isScaffold(implemented)).toBe(false);
        expect(declaresContract(implemented)).toBe(true);
    });

    it("treats a module with a body of its own as an implementation", () => {
        const implemented = `
export const sendInvoice: Ops["sendInvoice"] = async (ctx) => {
    const invoice = await load(ctx);
    return invoice;
};
`;

        expect(isScaffold(implemented)).toBe(false);
        expect(declaresContract(implemented)).toBe(true);
    });

    it("ignores a module that declares no contract at all, such as a helper", () => {
        expect(declaresContract("export function clock(): Date { return new Date(); }")).toBe(false);
    });
});

describe("pruning", () => {
    it("removes the scaffold of an operation the spec no longer declares", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(true);

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(false);
    });

    it("removes a scaffold that was written without the marker", () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, "sendInvoice.ts"),
            `export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {\n    throw new NotImplemented("not implemented");\n};\n`,
        );

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(false);
    });

    it("keeps an implementation and reports it, rather than deleting hand-written code", () => {
        const dir = tempDir();
        const file = join(dir, "sendInvoice.ts");
        writeFileSync(
            file,
            `export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {\n    return await deliver(ctx.db, opts);\n};\n`,
        );

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir], SILENT)).toBe(1);
        expect(existsSync(file)).toBe(true);
    });

    it("leaves a helper module alone, since it declares no contract", () => {
        const dir = tempDir();
        const helper = join(dir, "clock.ts");
        writeFileSync(helper, "export const now = () => new Date();\n");

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(helper)).toBe(true);
    });

    it("keeps an implementation that still carries the scaffold marker", () => {
        const dir = tempDir();
        const file = join(dir, "sendInvoice.ts");
        writeFileSync(
            file,
            `${SCAFFOLD_MARKER}
export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {
    return await deliver(ctx.db, opts);
};
`,
        );

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir], SILENT)).toBe(1);
        expect(existsSync(file)).toBe(true);
    });

    it("keeps a declared operation's module however its body looks", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        const file = join(dir, "sendInvoice.ts");
        writeFileSync(file, readFileSync(file, "utf8").replace("throw new NotImplemented", "// throw new NotImplemented"));

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(file)).toBe(true);
    });
});

describe("meetsContract", () => {
    it("accepts the scaffold it wrote", () => {
        const spec = build();

        expect(meetsContract(renderOperationFile(operation(spec)), operation(spec))).toBe(true);
    });

    it("accepts a hand-written module that keeps the annotation", () => {
        const source = `
import type { InvoiceOperations } from "spec/fixtures/InvoiceOperations.ts";
export const sendInvoice: InvoiceOperations<{ db: SqlExecutor }>["sendInvoice"] = async (ctx, opts) => {
    return null as never;
};
`;

        expect(meetsContract(source, operation(build()))).toBe(true);
    });

    it("rejects a module that drops the contract annotation", () => {
        const source = "export const sendInvoice = async () => null;";

        expect(meetsContract(source, operation(build()))).toBe(false);
    });

    it("rejects a module that declares another operation", () => {
        const source = 'export const sendInvoices: InvoiceOperations<Ctx>["sendInvoices"] = async () => null;';

        expect(meetsContract(source, operation(build()))).toBe(false);
    });
});

describe("run", () => {
    it("writes one module per operation", () => {
        const dir = tempDir();

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(readFileSync(join(dir, "sendInvoice.ts"), "utf8")).toContain("export const sendInvoice:");
    });

    it("leaves a committed module alone on the next run", () => {
        const dir = tempDir();
        const file = join(dir, "sendInvoice.ts");
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(file, `${readFileSync(file, "utf8")}// implemented by hand\n`);

        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        expect(readFileSync(file, "utf8")).toContain("// implemented by hand");
    });

    it("fails when a committed module no longer declares the contract", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(join(dir, "sendInvoice.ts"), "export const sendInvoice = async () => null;\n");

        expect(run(build(), ["--out", dir], SILENT)).toBe(1);
    });


    it("fails when @restOperation appears without @operation", () => {
        const code = build({
            "InvoiceSent.ts": SENT,
            "Ops.ts": `
export interface Ops<T> {
    /** @restOperation */
    sendInvoice(ctx: T): Promise<void>;
}`,
        });

        expect(run(code, ["--out", tempDir()], SILENT)).toBe(1);
    });

    it("fails when the contract takes more than one type parameter", () => {
        const code = build({
            "InvoiceSent.ts": SENT,
            "Ops.ts": `
export interface Ops<T, U> {
    /** @operation */
    sendInvoice(ctx: T, extra: U): Promise<void>;
}`,
        });

        expect(run(code, ["--out", tempDir()], SILENT)).toBe(1);
    });

    it("writes nothing when the spec itself is refused", () => {
        const dir = tempDir();
        const code = build({
            "InvoiceSent.ts": SENT,
            "Ops.ts": `
export interface Ops<T> {
    /** @operation */
    sendInvoice(ctx: T): Promise<void>;
}

export interface Other<T> {
    /** @operation */
    sendInvoice(ctx: T): Promise<void>;
}`,
        });

        expect(run(code, ["--out", dir], SILENT)).toBe(1);
        expect(() => readFileSync(join(dir, "sendInvoice.ts"), "utf8")).toThrow();
    });
});

describe("--check", () => {
    it("passes when the committed modules declare the spec's operations", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(0);
    });

    it("fails when the spec declares an operation and no module exists", () => {
        const dir = tempDir();

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(false);
    });

    it("fails when a committed module no longer declares the contract", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        writeFileSync(join(dir, "sendInvoice.ts"), "export const sendInvoice = async () => null;\n");

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);
    });

    it("reports a stale scaffold rather than removing it", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--check", "--out", dir], SILENT)).toBe(1);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(true);
    });

    it("does not create the output directory, so a check run leaves the tree untouched", () => {
        const dir = join(tempDir(), "missing");

        expect(run(build(), ["--check", "--out", dir], SILENT)).toBe(1);
        expect(existsSync(dir)).toBe(false);
    });
});

describe("output", () => {
    it("reports the summary through the log channel", () => {
        const log = vi.fn();

        expect(run(build(), ["--out", tempDir()], { log, error: vi.fn() })).toBe(0);
        expect(log).toHaveBeenCalledWith("operations OK (1 created, 0 verified, 0 removed)");
    });

    it("reports the check summary through the log channel", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir], SILENT)).toBe(0);
        const log = vi.fn();

        expect(run(build(), ["--check", "--out", dir], { log, error: vi.fn() })).toBe(0);
        expect(log).toHaveBeenCalledWith("operations OK (1 file(s) declare the spec's operations)");
    });

    it("reports a refusal through the error channel, so a silent sink sees neither", () => {
        const error = vi.fn();

        expect(run(build(), ["--out"], { log: vi.fn(), error })).toBe(1);
        expect(error).toHaveBeenCalledWith("--out needs a directory");

        expect(run(build(), ["--out"], SILENT)).toBe(1);
    });
});
