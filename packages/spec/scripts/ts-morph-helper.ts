/** Test support: run a module of generated TypeScript, so a test asserts its behaviour and not its text. */
import { ts } from "ts-morph";

/** What a generated module's runtime import resolves to. */
export type ImportResolver = (specifier: string) => unknown;

/** Answers only `modules`, so a generated module that grows a runtime import fails loudly instead of loading a real one. */
export function stubImports(modules: Record<string, unknown>): ImportResolver {
    return (specifier) => {
        if (!Object.hasOwn(modules, specifier)) {
            throw new Error(`the module under test imported \`${specifier}\`, which this test does not stub`);
        }
        return modules[specifier];
    };
}

/** Transpiles a generated module to CommonJS and evaluates it with `resolve` standing in for its imports. */
export function loadGeneratedModule<T>(code: string, resolve: ImportResolver): T {
    const js = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    // The generated code writes its exports onto the object it is handed, and reads its imports through `require`.
    new Function("exports", "require", js)(exports, resolve);
    return exports as T;
}
