/**
 * Let plain `node` resolve the `.js` specifiers this repo writes to their `.ts`
 * sources. Node strips types but does not rewrite specifiers, and the generated
 * files import each other with `.js` (so vitest and `tsc` resolve them). Load
 * this before the server entry; see docs/graphql.md.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
    resolve(specifier, context, nextResolve) {
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        if (isRelative && specifier.endsWith(".js") && context.parentURL) {
            const candidate = new URL(`${specifier.slice(0, -".js".length)}.ts`, context.parentURL);
            if (existsSync(fileURLToPath(candidate))) {
                return { url: candidate.href, shortCircuit: true };
            }
        }
        return nextResolve(specifier, context);
    },
});
