/** Unit tests for the operation scaffold generator, driven by self-contained fixtures and a temp directory. See docs/testing.md. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "spec/scripts/spec-model.ts";
import { meetsContract, placeholderType, renderOperationFile, run } from "./generate-operations.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** The returned entity, so the scaffold imports the type it casts the placeholder to. */
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
    vi.restoreAllMocks();
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "operations-"));
    dirs.push(dir);
    return dir;
}

/** Run the generator with its console output silenced, so assertions read the exit code. */
function quietly(spec: SpecModel, argv: string[]): number {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return run(spec, argv);
}

describe("renderOperationFile", () => {
    it("declares the operation under its contract annotation", () => {
        const spec = build();

        expect(renderOperationFile(operation(spec), spec)).toContain(
            'export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {',
        );
    });

    it("leaves the context to the implementer", () => {
        const code = renderOperationFile(operation(build()), build());

        expect(code).toContain("InvoiceOperations<unknown>");
        expect(code).not.toContain("SqlExecutor");
    });

    it("imports the contract and the type the placeholder returns", () => {
        const code = renderOperationFile(operation(build()), build());

        expect(code).toContain('import type { InvoiceOperations } from "spec/fixtures/InvoiceOperations.ts";');
        expect(code).toContain('import type { InvoiceSent } from "spec/fixtures/InvoiceSent.ts";');
    });

    it("copies the operation's prose and its declared errors into the doc comment", () => {
        const code = renderOperationFile(operation(build()), build());

        expect(code).toContain(" * Send the invoice to the recipient.");
        expect(code).toContain(
            " * @throws {InvoiceDetailsError} thrown when Invoice doesn't have enough details to be sent",
        );
        expect(code).not.toContain("@operation");
        expect(code).not.toContain("@restOperation");
    });

    it("returns a placeholder the compiler accepts", () => {
        const code = renderOperationFile(operation(build()), build());

        expect(code).toContain("return null as unknown as Promise<InvoiceSent>;");
    });

    it("awaits a promise return and leaves a plain return unawaited", () => {
        expect(placeholderType(operation(build()))).toBe("Promise<InvoiceSent>");

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
        const code = renderOperationFile(count, plain);

        expect(code).toContain('export const count: Ops<unknown>["count"] = (ctx) => {');
        expect(code).toContain("return null as unknown as number;");
    });
});

describe("meetsContract", () => {
    it("accepts the scaffold it wrote", () => {
        const spec = build();

        expect(meetsContract(renderOperationFile(operation(spec), spec), operation(spec))).toBe(true);
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

        expect(run(build(), ["--out", dir])).toBe(0);

        expect(readFileSync(join(dir, "sendInvoice.ts"), "utf8")).toContain("export const sendInvoice:");
    });

    it("leaves a committed module alone on the next run", () => {
        const dir = tempDir();
        const file = join(dir, "sendInvoice.ts");
        expect(run(build(), ["--out", dir])).toBe(0);
        writeFileSync(file, `${readFileSync(file, "utf8")}// implemented by hand\n`);

        expect(run(build(), ["--out", dir])).toBe(0);
        expect(readFileSync(file, "utf8")).toContain("// implemented by hand");
    });

    it("fails when a committed module no longer declares the contract", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir])).toBe(0);
        writeFileSync(join(dir, "sendInvoice.ts"), "export const sendInvoice = async () => null;\n");

        expect(quietly(build(), ["--out", dir])).toBe(1);
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

        expect(quietly(code, ["--out", tempDir()])).toBe(1);
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

        expect(quietly(code, ["--out", tempDir()])).toBe(1);
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

        expect(quietly(code, ["--out", dir])).toBe(1);
        expect(() => readFileSync(join(dir, "sendInvoice.ts"), "utf8")).toThrow();
    });
});
