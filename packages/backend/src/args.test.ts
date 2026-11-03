/** Asserts the entry points' command line reading. See docs/entrypoints.md. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP, parseServerArgs } from "./args.ts";

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

describe("parseServerArgs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads every flag the entries share", () => {
        expect(
            parseServerArgs([
                "--port",
                "4123",
                "--seed",
                "--log-sql",
                "--database-url",
                "postgres://localhost/db",
                "--data-dir",
                "./.pglite",
            ]),
        ).toEqual({
            port: 4123,
            seed: true,
            logSql: true,
            databaseUrl: "postgres://localhost/db",
            dataDir: "./.pglite",
        });
    });

    it("answers an empty set when there is no flag", () => {
        expect(parseServerArgs([])).toEqual({});
    });

    it("keeps a seed default when the command line does not override it", () => {
        expect(parseServerArgs([], { seed: true })).toEqual({ seed: true });
    });

    it("reads the other flags over a seed default", () => {
        expect(parseServerArgs(["--port", "4123"], { seed: true })).toEqual({ port: 4123, seed: true });
    });

    it("treats --mock as the --seed alias", () => {
        expect(parseServerArgs(["--mock"])).toEqual({ seed: true });
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

    it("refuses a flag it does not know", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--unknown"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--unknown"));
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
        for (const flag of ["--port", "--seed", "--mock", "--log-sql", "--database-url", "--data-dir", "--help"]) {
            expect(HELP).toContain(flag);
        }
    });
});
