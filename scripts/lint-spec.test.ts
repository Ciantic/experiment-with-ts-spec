import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { lintProject, lintSourceText, readFormulaNames, type Finding } from "./lint-spec.js";

/** The real registries, so `formula=` checks resolve as they do in the CLI. */
function realFormulaNames(): Set<string> {
    const project = new Project({ tsConfigFilePath: "tsconfig.json" });
    return readFormulaNames(project);
}

/** Format findings as `field: message` for concise assertions. */
function messages(findings: Finding[]): string[] {
    return findings.map((finding) => finding.message);
}

describe("lintSourceText", () => {
    const formulaNames = new Set(["rowNetAmount"]);

    it("accepts a field with a valid tag set", () => {
        const findings = lintSourceText(
            `export interface Ok {
                /**
                 * A label.
                 * @fieldName Label
                 * @widget text
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("reports a retired tag with its replacement", () => {
        const findings = lintSourceText(
            `export interface Legacy {
                /**
                 * A label.
                 * @fieldName Label
                 * @readonly
                 * @widget text
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: @readonly is retired; use @generated for system-assigned fields or @computed for derived fields",
        ]);
    });

    it("reports an unrecognised tag", () => {
        const findings = lintSourceText(
            `export interface Unknown {
                /**
                 * @fieldName Label
                 * @widget text
                 * @nonsense
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: @nonsense is not a recognised tag"]);
    });

    it("reports an unknown widget", () => {
        const findings = lintSourceText(
            `export interface BadWidget {
                /**
                 * @fieldName Label
                 * @widget slider
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: @widget `slider` is not one of: text, number, date, select, table, textarea",
        ]);
    });

    it("reports a missing @fieldName and @widget", () => {
        const findings = lintSourceText(
            `export interface Bare {
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: missing @fieldName", "`label`: missing @widget"]);
    });

    it("reports an empty @fieldName", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName
                 * @widget text
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: @fieldName is empty"]);
    });

    it("rejects @generated and @computed together", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Label
                 * @widget number
                 * @generated
                 * @computed storage=stored formula=rowNetAmount
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: @generated and @computed are mutually exclusive"]);
    });

    it("rejects parameters on @generated", () => {
        const findings = lintSourceText(
            `export interface Params {
                /**
                 * @fieldName Label
                 * @widget text
                 * @generated storage=stored
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: @generated takes no parameters, found: storage="]);
    });

    it("requires storage= and formula= on @computed", () => {
        const findings = lintSourceText(
            `export interface Missing {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: @computed is missing storage=",
            "`label`: @computed is missing formula=",
        ]);
    });

    it("rejects an unknown storage mode", () => {
        const findings = lintSourceText(
            `export interface BadStorage {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed storage=cached formula=rowNetAmount
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: storage=`cached` is not one of: generated, stored, derived",
        ]);
    });

    it("rejects an undefined formula", () => {
        const findings = lintSourceText(
            `export interface BadFormula {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed storage=stored formula=doesNotExist
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: formula=`doesNotExist` is not defined in spec/postgres/formulas.ts (rowFormulas, invoiceFormulas)",
        ]);
    });

    it("rejects an unknown @computed parameter", () => {
        const findings = lintSourceText(
            `export interface ExtraParam {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed storage=stored formula=rowNetAmount precision=2
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`label`: @computed has unknown parameter `precision=`"]);
    });

    it("rejects a duplicated tag", () => {
        const findings = lintSourceText(
            `export interface Duplicate {
                /**
                 * @fieldName First
                 * @fieldName Second
                 * @widget text
                 */
                label: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`label`: @fieldName appears more than once",
            "`label`: @fieldName appears more than once",
        ]);
    });

    it("accepts a client-supplied field with neither @generated nor @computed", () => {
        const findings = lintSourceText(
            `export interface ClientSupplied {
                /**
                 * @fieldName Note
                 * @widget textarea
                 */
                note: string;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @inlined naming an entity", () => {
        const findings = lintSourceText(
            `export interface Inlined {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @inlined Customer
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("reports @inlined without an entity", () => {
        const findings = lintSourceText(
            `export interface Bare {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @inlined
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`customer`: @inlined is missing its <Entity>"]);
    });

    it("rejects @inlined together with @relation", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @inlined Customer
                 * @relation Customer
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`customer`: @inlined and @relation are mutually exclusive"]);
    });
});

describe("readFormulaNames", () => {
    it("reads the registries despite the as-const wrapper", () => {
        const names = realFormulaNames();

        expect(names).toContain("rowNetAmount");
        expect(names).toContain("invoiceTotalAmount");
    });
});

describe("the committed spec", () => {
    it("passes lint", () => {
        const project = new Project({ tsConfigFilePath: "tsconfig.json" });
        const { findings, interfaces, properties } = lintProject(project);

        expect(findings).toEqual([]);
        expect(interfaces).toBeGreaterThan(0);
        expect(properties).toBeGreaterThan(0);
    });
});
