/** Unit tests for the spec error generator, driven by self-contained fixtures. See docs/testing.md. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "../spec/spec-model.ts";
import { buildErrorModel, errorKind, renderErrorModule, run } from "./generate-errors.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A contract whose operation declares the given `@throws` lines. */
function contract(throws: string): string {
    return `
export interface Ops<T> {
    /**
     * Send.
     *
${throws}
     * @operation
     */
    send(ctx: T): Promise<void>;
}`;
}

/** Build a model from in-memory sources, so no test reads the real spec. */
function build(throws: string, files: Record<string, string> = {}): SpecModel {
    const sources = Object.entries({ "Ops.ts": contract(throws), ...files }).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", name),
        sourceFileText,
    }));
    return parseInMemorySpec(sources, { sourceGlob: SPEC_GLOB });
}

function messages(spec: SpecModel): string[] {
    return buildErrorModel(spec).diagnostics.map((diagnostic) => diagnostic.message);
}

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "errors-"));
    dirs.push(dir);
    return dir;
}

describe("errorKind", () => {
    it("kebab-cases the class name without its suffix", () => {
        expect(errorKind("InvoiceDetailsError")).toBe("invoice-details");
        expect(errorKind("ShortWriteError")).toBe("short-write");
        expect(errorKind("NoMatchingRowError")).toBe("no-matching-row");
        expect(errorKind("OAuthError")).toBe("o-auth");
    });
});

describe("buildErrorModel", () => {
    it("reads a declared error with its reason and a default status", () => {
        const { errors } = buildErrorModel(build("     * @throws {InvoiceDetailsError} it lacks details"));

        expect(errors).toEqual([
            {
                name: "InvoiceDetailsError",
                kind: "invoice-details",
                status: 400,
                reason: "it lacks details",
                location: expect.objectContaining({ line: expect.any(Number) }),
            },
        ]);
    });

    it("takes the status the tag names", () => {
        const { errors } = buildErrorModel(
            build("     * @throws {InvoiceDetailsError} status=422 it lacks details"),
        );

        expect(errors[0]?.status).toBe(422);
        expect(errors[0]?.reason).toBe("it lacks details");
    });

    it("declares one class for a name two operations share", () => {
        const shared = `
export interface Other<T> {
    /**
     * Send.
     *
     * @throws {InvoiceDetailsError} it lacks details
     * @operation
     */
    send(ctx: T): Promise<void>;
}`;
        const { errors, diagnostics } = buildErrorModel(
            build("     * @throws {InvoiceDetailsError} it lacks details", { "Other.ts": shared }),
        );

        expect(errors.map((error) => error.name)).toEqual(["InvoiceDetailsError"]);
        expect(diagnostics).toEqual([]);
    });

    it("reports a name declared at two statuses", () => {
        const shared = `
export interface Other<T> {
    /**
     * Send.
     *
     * @throws {InvoiceDetailsError} status=422 it lacks details
     * @operation
     */
    send(ctx: T): Promise<void>;
}`;
        const findings = messages(
            build("     * @throws {InvoiceDetailsError} status=400 it lacks details", { "Other.ts": shared }),
        );

        expect(findings).toEqual(["@throws `InvoiceDetailsError` is declared with status 400 and 422"]);
    });

    it("reports a name a built-in error already answers for", () => {
        expect(messages(build("     * @throws {ValidationError} it is invalid"))).toEqual([
            "@throws `ValidationError` is a built-in error; name the failure's own class",
        ]);
    });

    it("reports a name that is not a class name", () => {
        expect(messages(build("     * @throws {invoice-details} it is invalid"))).toEqual([
            "@throws `invoice-details` is not a class name the generator can declare",
        ]);
    });

    it("reports a status outside the error range", () => {
        expect(messages(build("     * @throws {InvoiceDetailsError} status=200 it lacks details"))).toEqual([
            "@throws `InvoiceDetailsError` names status 200; an error status is 400 to 599",
        ]);
    });

    it("reports a status that is not a number", () => {
        expect(messages(build("     * @throws {InvoiceDetailsError} status=many it lacks details"))).toEqual([
            "@throws `InvoiceDetailsError` names status `many`; a status is a number, 400 to 599",
        ]);
    });

    it("reports a parameter the tag does not take", () => {
        expect(messages(build("     * @throws {InvoiceDetailsError} kind=boom it lacks details"))).toEqual([
            "@throws `InvoiceDetailsError` does not take `kind=`; it takes `status=`",
        ]);
    });

    it("reports two classes that map to one kind", () => {
        const other = `
export interface Other<T> {
    /**
     * Send.
     *
     * @throws {AbError} it lacks details
     * @operation
     */
    send(ctx: T): Promise<void>;
}`;
        const findings = messages(
            build("     * @throws {ABError} status=422 it lacks details", { "Other.ts": other }),
        );

        expect(findings).toEqual(["@throws `AbError` maps to kind `ab`, which `ABError` already answers for"]);
    });
});

describe("renderErrorModule", () => {
    it("renders a class that names the wire kind and the status", () => {
        const { errors } = buildErrorModel(
            build("     * @throws {InvoiceDetailsError} status=422 when details are missing"),
        );
        const code = renderErrorModule(errors);

        expect(code).toContain("export class InvoiceDetailsError extends AppError {");
        expect(code).toContain('super(message, { kind: "invoice-details", status: 422 }, options);');
        expect(code).toContain("/** When details are missing. */");
    });

    it("keys the registry by the wire kind", () => {
        const { errors } = buildErrorModel(build("     * @throws {InvoiceDetailsError} it lacks details"));

        expect(renderErrorModule(errors)).toContain('"invoice-details": InvoiceDetailsError,');
    });

    it("writes an empty registry when the spec declares no errors", () => {
        const code = renderErrorModule([]);

        expect(code).toContain("export const SPEC_ERROR_CLASSES: Record<string,");
        expect(code).toContain("= {};");
        expect(code).not.toContain("export class");
    });

    it("imports the base from the hand-written module, so neither generated file imports the other", () => {
        const code = renderErrorModule(buildErrorModel(build("     * @throws {InvoiceDetailsError} why")).errors);

        expect(code).toContain('import { AppError, type AppErrorOptions } from "./errorBase.ts";');
        expect(code).not.toContain("./errors.ts");
    });
});

describe("run", () => {
    it("writes the module to the file it is given", () => {
        const file = join(tempDir(), "specErrors.ts");

        expect(run(build("     * @throws {InvoiceDetailsError} it lacks details"), ["--out", file], SILENT)).toBe(0);
        expect(readFileSync(file, "utf8")).toContain("export class InvoiceDetailsError");
    });

    it("writes nothing when a tag cannot become a class", () => {
        const file = join(tempDir(), "specErrors.ts");

        expect(run(build("     * @throws {ValidationError} it is invalid"), ["--out", file], SILENT)).toBe(1);
        expect(() => readFileSync(file, "utf8")).toThrow();
    });
});
