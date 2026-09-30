/**
 * The read types moved to `spec/src/selection.ts`, so the generated REST client
 * can share them without importing the backend. Re-exported here so the
 * generated query modules keep importing their own package. See docs/rest-api.md.
 */
export * from "spec/selection.js";
