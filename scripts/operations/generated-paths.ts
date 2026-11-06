/** Where the operations package groups its generated files: one directory per service directory the spec declares. */
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/** The suffix a spec test takes, so it sits beside the operation module rather than in its own directory. */
export const SPEC_TEST_SUFFIX = ".spec.test.ts";

/** The routes module each group carries, beside its operations and guards. */
export const ROUTES_FILE = "routes.ts";

/** The subdirectory a group keeps its permission guards in. */
export const GUARDS_DIRECTORY = "guards";

/** A generated file's path inside a group, relative to the output root, e.g. `invoicing-service/guards/canSend.ts`. */
export function groupedName(topLevelDirectory: string | undefined, ...segments: string[]): string {
    return [...(topLevelDirectory === undefined ? [] : [topLevelDirectory]), ...segments].join("/");
}

/** The absolute path a generated file takes under `outDir`, in its group's directory. */
export function groupedPath(outDir: string, topLevelDirectory: string | undefined, ...segments: string[]): string {
    return join(outDir, ...(topLevelDirectory === undefined ? [] : [topLevelDirectory]), ...segments);
}

/** The path a guard's module takes under `outDir`: its group's `guards/` subdirectory, beside the operations. */
export function guardPath(outDir: string, topLevelDirectory: string | undefined, name: string): string {
    return groupedPath(outDir, topLevelDirectory, GUARDS_DIRECTORY, `${name}.ts`);
}

/** Every file below `root` with the given suffix, relative to it and separated by `/`; named directories are skipped. */
export function filesBelow(
    root: string,
    suffix: string,
    skipDirectories: ReadonlySet<string> = new Set(),
): string[] {
    if (!existsSync(root)) {
        return [];
    }
    const files: string[] = [];
    const walk = (directory: string, prefix: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const shown = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!skipDirectories.has(entry.name)) {
                    walk(path, shown);
                }
                continue;
            }
            if (entry.isFile() && entry.name.endsWith(suffix)) {
                files.push(shown);
            }
        }
    };
    walk(root, "");
    return files;
}

/** Remove the directories below `root` that pruning left empty; `root` itself stays. */
export function removeEmptyDirectories(root: string): void {
    if (!existsSync(root)) {
        return;
    }
    const prune = (directory: string): boolean => {
        let empty = true;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                empty = false;
                continue;
            }
            if (prune(join(directory, entry.name))) {
                rmdirSync(join(directory, entry.name));
            } else {
                empty = false;
            }
        }
        return empty;
    };
    prune(root);
}
