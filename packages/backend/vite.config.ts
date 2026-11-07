import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** The directories the bundle reads runtime files from, resolved inside the workspace's `node_modules`. */
const PACKAGE_DIRECTORIES = {
    infra: dirname(fileURLToPath(import.meta.resolve("infra"))),
    pglite: dirname(fileURLToPath(import.meta.resolve("@electric-sql/pglite"))),
} as const;

/** The generated DDL, which `applySchema` would read from inside the `infra` package. */
const SCHEMA_SQL = join(PACKAGE_DIRECTORIES.infra, "postgres/schema.sql");

/** The wasm binaries and the data bundle PGlite reads from its own directory. */
const PGLITE_ASSET_NAMES = ["pglite.wasm", "initdb.wasm", "pglite.data"] as const;

/** The entry point each mode bundles, the PGlite assets it needs, whether Zod must not compile, and where its output goes. */
const BUNDLES = {
    pg: { entry: "src/main.pg.ts", outDir: "dist.pg", fileName: "main.pg.js", pgliteAssets: false, jitless: false },
    pglite: {
        entry: "src/main.pglite.ts",
        outDir: "dist.pglite",
        fileName: "main.pglite.js",
        pgliteAssets: true,
        jitless: false,
    },
    porffor: {
        entry: "src/main.pg.ts",
        outDir: "dist.porffor",
        fileName: "main.porffor.js",
        pgliteAssets: false,
        jitless: true,
    },
} as const;

/** The virtual module that turns Zod's compiler off, loaded ahead of the entry's own imports. */
const ZOD_JITLESS_ID = "virtual:zod-jitless";

/** Porffor has no `Function`, and Zod reads the setting when it builds a schema, so it must run before `infra`. */
function zodJitless(entry: string): Plugin {
    return {
        name: "backend:zod-jitless",
        enforce: "pre",
        resolveId(id) {
            return id === ZOD_JITLESS_ID ? `\0${ZOD_JITLESS_ID}` : null;
        },
        load(id) {
            return id === `\0${ZOD_JITLESS_ID}` ? 'import { z } from "zod";\nz.config({ jitless: true });\n' : null;
        },
        transform(code, id) {
            // The import is first, so this module evaluates before the schemas `infra` builds at its own top level.
            return id === entry ? { code: `import "${ZOD_JITLESS_ID}";\n${code}`, map: null } : null;
        },
    };
}

/** `applySchema` reads `schema.sql` through `import.meta.url`; a bundle carries the DDL text instead. */
function inlineSchemaSql(): Plugin {
    return {
        name: "backend:inline-schema-sql",
        enforce: "pre",
        transform(code, id) {
            if (id !== join(PACKAGE_DIRECTORIES.infra, "postgres/schema.ts")) {
                return null;
            }
            const sql = JSON.stringify(readFileSync(SCHEMA_SQL, "utf8"));
            return { code: code.replace(/readFileSync\(SCHEMA_URL, "utf8"\)/, () => sql), map: null };
        },
    };
}

/** PGlite loads a wasm module and maps a data bundle, so those files stay beside the entry under the names PGlite asks for. */
function copyPgliteAssets(): Plugin {
    return {
        name: "backend:copy-pglite-assets",
        generateBundle() {
            for (const fileName of PGLITE_ASSET_NAMES) {
                this.emitFile({
                    type: "asset",
                    fileName,
                    source: readFileSync(join(PACKAGE_DIRECTORIES.pglite, fileName)),
                });
            }
        },
    };
}

export default defineConfig(({ mode }) => {
    const bundle = BUNDLES[mode === "pglite" || mode === "porffor" ? mode : "pg"];
    const entryPath = join(dirname(fileURLToPath(import.meta.url)), bundle.entry);
    return {
        // Bundle every dependency into the entry; Node builtins stay external.
        ssr: { noExternal: true },
        plugins: [
            inlineSchemaSql(),
            ...(bundle.jitless ? [zodJitless(entryPath)] : []),
            ...(bundle.pgliteAssets ? [copyPgliteAssets()] : []),
        ],
        build: {
            ssr: bundle.entry,
            outDir: bundle.outDir,
            emptyOutDir: true,
            target: "node24",
            minify: false,
            reportCompressedSize: false,
            rollupOptions: {
                output: {
                    entryFileNames: bundle.fileName,
                    codeSplitting: false,
                },
            },
        },
    };
});
