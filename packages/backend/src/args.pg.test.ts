/** Asserts the `pg` entry's command line reading. See docs/entrypoints.md. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP, parseServerArgs } from "./args.pg.ts";

/** A stand-in for the exit, thrown so a test observes it rather than ending the run. */
class ProcessExit extends Error {
    readonly code: number | string | null | undefined;

    constructor(code: number | string | null | undefined) {
        super(`exit ${code}`);
        this.code = code;
    }
}

/** Replace `process.exit`, which never returns, with a throw the test can catch. */
function mockExit() {
    return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
        throw new ProcessExit(code);
    });
}

/** Silence a stream and answer the spy, so a test asserts on what was written. */
function mockWrite(stream: "log" | "error") {
    return vi.spyOn(console, stream).mockImplementation(() => {});
}

describe("parseServerArgs (pg)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads every flag the pg entry takes", () => {
        expect(
            parseServerArgs([
                "--port",
                "4123",
                "--schema",
                "--seed",
                "--without-auth",
                "--database-url",
                "postgres://localhost/db",
            ]),
        ).toEqual({
            port: 4123,
            schema: true,
            seed: true,
            withoutAuth: true,
            databaseUrl: "postgres://localhost/db",
        });
    });

    it("answers the default port when there is no flag", () => {
        expect(parseServerArgs([])).toEqual({ port: 3000 });
    });

    it("reads the schema, seed, and without-auth flags", () => {
        expect(parseServerArgs(["--schema", "--seed", "--without-auth"])).toEqual({
            port: 3000,
            schema: true,
            seed: true,
            withoutAuth: true,
        });
    });

    it("applies the schema and the seed independently", () => {
        expect(parseServerArgs(["--schema"])).toEqual({ port: 3000, schema: true });
        expect(parseServerArgs(["--seed"])).toEqual({ port: 3000, seed: true });
    });

    it("refuses --mock, which is gone in favour of --seed", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--mock"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--mock"));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("reads a port joined to its flag", () => {
        expect(parseServerArgs(["--port=0"])).toEqual({ port: 0 });
    });

    it("refuses a port that is not a whole number", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--port", "abc"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith("--port needs an integer");
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("refuses a flag that needs a value and has none", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--port"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--port"));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("refuses a flag it does not know, such as a PGlite-only one", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--data-dir", "./.pglite"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--data-dir"));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("prints the help and exits cleanly when asked", () => {
        const exit = mockExit();
        const log = mockWrite("log");
        expect(() => parseServerArgs(["--help"])).toThrow(ProcessExit);
        expect(log).toHaveBeenCalledWith(HELP);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("treats -h as the --help alias", () => {
        const exit = mockExit();
        mockWrite("log");
        expect(() => parseServerArgs(["-h"])).toThrow(ProcessExit);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("lists every flag in the help text", () => {
        for (const flag of ["--port", "--schema", "--seed", "--without-auth", "--database-url", "--help"]) {
            expect(HELP).toContain(flag);
        }
    });
});
