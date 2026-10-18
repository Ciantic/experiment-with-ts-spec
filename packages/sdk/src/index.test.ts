/** Guards the package entry: importing the client must not load a schema. See docs/validation.md. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = join(import.meta.dirname, "index.ts");

/** The relative specifiers a module imports. */
function relativeImports(file: string): string[] {
    const content = readFileSync(file, "utf8");
    return [...content.matchAll(/from "([^"]+)"/g)]
        .map((match) => match[1] ?? "")
        .filter((specifier) => specifier.startsWith("."));
}

/** Every module the entry reaches through relative imports. */
function moduleGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const file = resolve(pending.pop() ?? "");
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        for (const specifier of relativeImports(file)) {
            pending.push(resolve(dirname(file), specifier));
        }
    }
    return seen;
}

describe("package entry", () => {
    it("reaches the transport and the error contract, not a schema module", () => {
        const files = moduleGraph(ENTRY);
        const reached = [...files].map((file) => file.slice(import.meta.dirname.length + 1)).sort();

        expect(reached).toEqual(["client.ts", "errors.ts", "http.ts", "index.ts"]);
        for (const file of files) {
            expect(readFileSync(file, "utf8")).not.toContain('from "zod"');
        }
    });
});
