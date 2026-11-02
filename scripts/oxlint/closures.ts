/** Oxlint rule for closure factories: an exported factory whose returned functions close over its locals. See docs/closures.md. */

import { definePlugin, type Context, type ESTree, type Scope } from "@oxlint/plugins";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** Methods that keep a function passed to them; every other method call is assumed to run it and let it go. */
const RETAINING_METHODS = new Set([
    "on",
    "once",
    "addListener",
    "prependListener",
    "addEventListener",
    "subscribe",
    "register",
    "use",
    "set",
    "add",
    "push",
    "unshift",
]);

/** Whether `node` is a function literal. */
function isFunction(node: ESTree.Node): node is ESTree.Function {
    return FUNCTION_TYPES.has(node.type);
}

/** The child nodes of an ESTree node, ignoring comments, spans, and parent links. */
function childEntries(node: ESTree.Node): [string, ESTree.Node][] {
    const out: [string, ESTree.Node][] = [];
    for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
        if (key === "parent" || key === "loc" || key === "range") {
            continue;
        }
        for (const candidate of Array.isArray(value) ? value : [value]) {
            if (candidate && typeof candidate === "object" && typeof (candidate as ESTree.Node).type === "string") {
                out.push([key, candidate as ESTree.Node]);
            }
        }
    }
    return out;
}

/** The arguments a function returns, without descending into a nested function. */
function returnedArguments(node: ESTree.Node, out: ESTree.Node[] = []): ESTree.Node[] {
    for (const child of childEntries(node).map(([, entry]) => entry)) {
        if (isFunction(child)) {
            continue;
        }
        if (child.type === "ReturnStatement" && child.argument) {
            out.push(child.argument);
            continue;
        }
        returnedArguments(child, out);
    }
    return out;
}

/** Whether `node` is a call or a construction. */
function isCall(node: ESTree.Node): boolean {
    return node.type === "CallExpression" || node.type === "NewExpression";
}

/** Whether a call keeps its callback rather than running it and discarding it. */
function retainsCallback(node: ESTree.Node): boolean {
    if (node.type === "NewExpression") {
        return true;
    }
    if (node.type !== "CallExpression") {
        return false;
    }
    const callee = node.callee;
    if (callee.type === "Identifier") {
        return true;
    }
    if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") {
        return true;
    }
    return RETAINING_METHODS.has(callee.property.name);
}

/** The function literals in a returned value, mapped to whether that value can retain each one. */
function escapingFunctions(node: ESTree.Node, escaping: boolean, out: Map<ESTree.Node, boolean>): void {
    if (isFunction(node)) {
        out.set(node, escaping);
        return;
    }
    const retained = retainsCallback(node);
    for (const [key, child] of childEntries(node)) {
        // A callee is invoked rather than returned, so only its arguments can be retained.
        escapingFunctions(child, key === "callee" ? false : escaping && (!isCall(node) || retained), out);
    }
}

/** A function's body as the values it returns; a declaration without a body returns nothing. */
function returnedValues(node: ESTree.Function): ESTree.Node[] {
    const body = node.body;
    if (body === null) {
        return [];
    }
    return body.type === "BlockStatement" ? returnedArguments(body) : [body];
}

/** The factory's own bindings: parameters and imports are inputs, not state. */
function localNames(scope: Scope): Set<string> {
    return new Set(
        scope.variables
            .filter((variable) => {
                const definition = variable.defs[0];
                return definition !== undefined && definition.type !== "Parameter" && definition.type !== "ImportBinding";
            })
            .map((variable) => variable.name),
    );
}

/** The factory locals that `fn` closes over, in source order. */
function capturedNames(context: Context, scope: Scope, locals: Set<string>, fn: ESTree.Node): string[] {
    return context.sourceCode
        .getScope(fn)
        .through.flatMap((reference) => {
            const variable = reference.resolved;
            return variable !== null && variable.scope === scope && locals.has(variable.name) ? [variable.name] : [];
        });
}

/** Report an exported factory whose returned closures hold locals. */
function check(context: Context, node: ESTree.Function): void {
    const scope = context.sourceCode.getScope(node);
    const locals = localNames(scope);
    const captured = new Set<string>();
    for (const value of returnedValues(node)) {
        const functions = new Map<ESTree.Node, boolean>();
        escapingFunctions(value, true, functions);
        for (const [fn, escaping] of functions) {
            if (!escaping) {
                continue;
            }
            for (const name of capturedNames(context, scope, locals, fn)) {
                captured.add(name);
            }
        }
    }
    if (captured.size === 0) {
        return;
    }
    context.report({
        node,
        message:
            `the returned function closes over ${[...captured].map((name) => `\`${name}\``).join(", ")}; ` +
            "if the factory owns mutable state, hold it in a field instead",
    });
}

/** A function declaration or an initialized declarator, when it is a function. */
function checkDeclaration(context: Context, declaration: ESTree.Declaration | null | undefined): void {
    if (!declaration) {
        return;
    }
    if (declaration.type === "FunctionDeclaration") {
        check(context, declaration);
        return;
    }
    if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
            if (declarator.init && isFunction(declarator.init)) {
                check(context, declarator.init);
            }
        }
    }
}

/** The rules this plugin exports. */
export default definePlugin({
    meta: { name: "closures" },
    rules: {
        "factory-closure": {
            meta: {
                type: "suggestion",
                docs: { description: "Warn about an exported factory that returns functions closing over its locals." },
            },
            create(context) {
                return {
                    ExportNamedDeclaration(node) {
                        checkDeclaration(context, node.declaration);
                    },
                    ExportDefaultDeclaration(node) {
                        if (isFunction(node.declaration as ESTree.Node)) {
                            check(context, node.declaration as ESTree.Function);
                        }
                    },
                };
            },
        },
    },
});
