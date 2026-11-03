/** Asserts the entry points' command line reading. See docs/entrypoints.md. */
import { describe, expect, it } from "vitest";
import { parseServerArgs } from "./args.ts";

describe("parseServerArgs", () => {
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
            ok: true,
            options: {
                port: 4123,
                seed: true,
                logSql: true,
                databaseUrl: "postgres://localhost/db",
                dataDir: "./.pglite",
            },
        });
    });

    it("answers an empty set when there is no flag", () => {
        expect(parseServerArgs([])).toEqual({ ok: true, options: {} });
    });

    it("treats --mock as the --seed alias", () => {
        expect(parseServerArgs(["--mock"])).toEqual({ ok: true, options: { seed: true } });
    });

    it("reads a port joined to its flag", () => {
        expect(parseServerArgs(["--port=0"])).toEqual({ ok: true, options: { port: 0 } });
    });

    it("refuses a port that is not a whole number", () => {
        expect(parseServerArgs(["--port", "abc"])).toEqual({ ok: false, message: "--port needs an integer" });
    });

    it("refuses a flag that needs a value and has none", () => {
        expect(parseServerArgs(["--port"])).toMatchObject({
            ok: false,
            message: expect.stringContaining("--port"),
        });
    });

    it("refuses a flag it does not know", () => {
        expect(parseServerArgs(["--unknown"])).toMatchObject({
            ok: false,
            message: expect.stringContaining("--unknown"),
        });
    });
});
