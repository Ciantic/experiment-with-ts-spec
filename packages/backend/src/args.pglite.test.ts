/** Asserts the `pglite` entry's command line reading. See docs/entrypoints.md. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP, parseServerArgs } from "./args.pglite.ts";

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

describe("parseServerArgs (pglite)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads every flag the pglite entry takes", () => {
        expect(
            parseServerArgs([
                "--port",
                "4123",
                "--no-schema",
                "--no-mock",
                "--without-auth",
                "--log-sql",
                "--data-dir",
                "./.pglite",
            ]),
        ).toEqual({
            port: 4123,
            schema: false,
            seed: false,
            withoutAuth: true,
            logSql: true,
            dataDir: "./.pglite",
        });
    });

    it("answers the defaults when there is no flag", () => {
        expect(parseServerArgs([])).toEqual({ port: 3000, schema: true, seed: true });
    });

    it("reads the other flags over the defaults", () => {
        expect(parseServerArgs(["--port", "4123"])).toEqual({ port: 4123, schema: true, seed: true });
    });

    it("turns the schema and the seed off independently", () => {
        expect(parseServerArgs(["--no-schema"])).toEqual({ port: 3000, schema: false, seed: true });
        expect(parseServerArgs(["--no-mock"])).toEqual({ port: 3000, schema: true, seed: false });
    });

    it("refuses --seed and --mock, which are gone in favour of --no-mock", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--seed"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--seed"));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("reads a port joined to its flag", () => {
        expect(parseServerArgs(["--port=0"])).toEqual({ port: 0, schema: true, seed: true });
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

    it("refuses a flag it does not know, such as the Postgres-only one", () => {
        const exit = mockExit();
        const error = mockWrite("error");
        expect(() => parseServerArgs(["--database-url", "postgres://localhost/db"])).toThrow(ProcessExit);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--database-url"));
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
        for (const flag of [
            "--port",
            "--no-schema",
            "--no-mock",
            "--without-auth",
            "--log-sql",
            "--data-dir",
            "--help",
        ]) {
            expect(HELP).toContain(flag);
        }
    });
});
