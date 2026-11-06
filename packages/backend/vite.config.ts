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

/** The entry point each mode bundles, the PGlite assets it needs, and where its output goes. */
const BUNDLES = {
    pg: { entry: "src/main.pg.ts", outDir: "dist.pg", fileName: "main.pg.js", pgliteAssets: false },
    pglite: {
        entry: "src/main.pglite.ts",
        outDir: "dist.pglite",
        fileName: "main.pglite.js",
        pgliteAssets: true,
    },
} as const;

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
    const bundle = mode === "pglite" ? BUNDLES.pglite : BUNDLES.pg;
    return {
        // Bundle every dependency into the entry; Node builtins stay external.
        ssr: { noExternal: true },
        plugins: [inlineSchemaSql(), ...(bundle.pgliteAssets ? [copyPgliteAssets()] : [])],
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
