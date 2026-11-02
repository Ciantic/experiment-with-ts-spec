/** Tests for the Oxlint closure-factory rule, driven by fixtures in memory. See docs/closures.md. */
import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./closures.ts";

RuleTester.describe = describe;
RuleTester.it = it;

/** A rule tester over modern modules, parsing `.ts` fixtures. */
const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

tester.run("factory-closure", plugin.rules["factory-closure"]!, {
    valid: [
        {
            code: `export function scale(items: number[], factor: number) { const doubled = factor * 2; return items.map((item) => item * doubled); }`,
            filename: "combinator.ts",
        },
        {
            code: `export function unwrap() { const value = 1; return value; }`,
            filename: "plain.ts",
        },
        {
            code: `const helper = () => { const cache = new Map(); return { size: () => cache.size }; };`,
            filename: "not-exported.ts",
        },
        {
            code: `export function forward(handler: () => void) { return { run: () => handler() }; }`,
            filename: "parameter.ts",
        },
        {
            code: `import { join } from "node:path"; export function locate() { return { path: () => join("a") }; }`,
            filename: "import.ts",
        },
        {
            code: `export function total(items: number[]) { const start = 0; return items.reduce((sum, item) => sum + item, start); }`,
            filename: "reduce.ts",
        },
        {
            code: `export const routes = [1, 2, 3];`,
            filename: "not-a-function.ts",
        },
        {
            code: `export function findIn(db: { transaction<T>(run: () => Promise<T>): Promise<T> }) { const id = 1; return db.transaction(async () => id); }`,
            filename: "consuming-method.ts",
        },
    ],
    invalid: [
        {
            code: `import { createServer } from "node:http"; export function createApi() { const router = {}; return createServer(() => router); }`,
            filename: "free-call.ts",
            errors: [{ message: /closes over `router`/ }],
        },
        {
            code: `export function createStore() { const state = new Map(); return { get: () => state }; }`,
            filename: "object.ts",
            errors: [{ message: /closes over `state`/ }],
        },
        {
            code: `export const createWidget = () => { const cache = new Map(); return () => cache.size; };`,
            filename: "arrow.ts",
            errors: [{ message: /closes over `cache`/ }],
        },
        {
            code: `export default function create() { const sink = {}; return () => sink; }`,
            filename: "default.ts",
            errors: [{ message: /closes over `sink`/ }],
        },
        {
            code: `export function createBus() { const bus = {}; return bus.on("change", () => bus); }`,
            filename: "retaining-method.ts",
            errors: [{ message: /closes over `bus`/ }],
        },
        {
            code: `export function createPair() { const first = new Map(); const second = new Map(); return [() => first, () => second]; }`,
            filename: "array.ts",
            errors: [{ message: /closes over `first`, `second`/ }],
        },
    ],
});
