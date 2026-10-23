/** Unit tests for the operation scaffold generator, driven by self-contained fixtures and a temp directory. See docs/testing.md. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "spec/scripts/spec-model.ts";
import {
    declaresContract,
    isScaffold,
    meetsContract,
    renderOperationFile,
    run,
    SCAFFOLD_MARKER,
} from "./generate-operations.ts";

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
        expect(run(build(), ["--out", dir])).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(true);

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir])).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(false);
    });

    it("removes a scaffold that was written without the marker", () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, "sendInvoice.ts"),
            `export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {\n    throw new NotImplemented("not implemented");\n};\n`,
        );

        expect(run(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir])).toBe(0);
        expect(existsSync(join(dir, "sendInvoice.ts"))).toBe(false);
    });

    it("keeps an implementation and reports it, rather than deleting hand-written code", () => {
        const dir = tempDir();
        const file = join(dir, "sendInvoice.ts");
        writeFileSync(
            file,
            `export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {\n    return await deliver(ctx.db, opts);\n};\n`,
        );

        expect(quietly(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir])).toBe(1);
        expect(existsSync(file)).toBe(true);
    });

    it("leaves a helper module alone, since it declares no contract", () => {
        const dir = tempDir();
        const helper = join(dir, "clock.ts");
        writeFileSync(helper, "export const now = () => new Date();\n");

        expect(run(build(), ["--out", dir])).toBe(0);
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

        expect(quietly(build({ "Ops.ts": WITHOUT_SEND }), ["--out", dir])).toBe(1);
        expect(existsSync(file)).toBe(true);
    });

    it("keeps a declared operation's module however its body looks", () => {
        const dir = tempDir();
        expect(run(build(), ["--out", dir])).toBe(0);
        const file = join(dir, "sendInvoice.ts");
        writeFileSync(file, readFileSync(file, "utf8").replace("throw new NotImplemented", "// throw new NotImplemented"));

        expect(run(build(), ["--out", dir])).toBe(0);
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
