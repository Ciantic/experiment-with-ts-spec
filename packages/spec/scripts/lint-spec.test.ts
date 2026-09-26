import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { lintProject, lintSourceText, readFormulaNames, type Finding } from "./lint-spec.js";

/** The real union types, so `formula=` checks resolve as they do in the CLI. */
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
            "`label`: formula=`doesNotExist` is not declared by any @formula type in spec/",
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

    it("accepts @default with an expression on a @generated field", () => {
        const findings = lintSourceText(
            `export interface Defaulted {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @generated
                 * @default now()
                 */
                createdAt?: Date;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @default alongside @computed", () => {
        const findings = lintSourceText(
            `export interface DefaultedComputed {
                /**
                 * @fieldName Updated at
                 * @widget date
                 * @computed storage=stored formula=rowNetAmount
                 * @default now()
                 */
                updatedAt?: Date;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("reports @default without an expression", () => {
        const findings = lintSourceText(
            `export interface EmptyDefault {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @default
                 */
                createdAt?: Date;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`createdAt`: @default is missing its expression"]);
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

    it("accepts @version on a Version field", () => {
        const findings = lintSourceText(
            `export interface Versioned {
                /**
                 * @fieldName Version
                 * @widget number
                 * @version
                 * @default 0
                 */
                version?: Version;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("rejects @version on a field that is not a Version", () => {
        const findings = lintSourceText(
            `export interface BadVersion {
                /**
                 * @fieldName Version
                 * @widget text
                 * @version
                 */
                version: string;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`version`: @version must be on a `Version` field, found `string`"]);
    });

    it("rejects @version together with @generated", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Version
                 * @widget number
                 * @version
                 * @generated
                 */
                version?: Version;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`version`: @version and @generated are mutually exclusive"]);
    });

    it("rejects more than one @version field in an interface", () => {
        const findings = lintSourceText(
            `export interface Two {
                /**
                 * @fieldName Version
                 * @widget number
                 * @version
                 */
                version?: Version;
                /**
                 * @fieldName Other
                 * @widget number
                 * @version
                 */
                other?: Version;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`Two`: @version may appear on at most one field"]);
    });
});

describe("readFormulaNames", () => {
    it("discovers names from @formula-annotated types", () => {
        const names = realFormulaNames();

        expect(names).toContain("rowNetAmount");
        expect(names).toContain("invoiceTotalAmount");
    });
});

describe("lintFormulaType", () => {
    it("accepts an @formula type of string literals", () => {
        const findings = lintSourceText(
            `/**
             * @formula
             */
            export type ThingFormula = "a" | "b";`,
            new Set(),
        );

        expect(findings).toEqual([]);
    });

    it("accepts a single-member @formula type", () => {
        const findings = lintSourceText(
            `/**
             * @formula
             */
            export type OneFormula = "only";`,
            new Set(),
        );

        expect(findings).toEqual([]);
    });

    it("rejects an @formula type with no string literals", () => {
        const findings = lintSourceText(
            `/**
             * @formula
             */
            export type BadFormula = number;`,
            new Set(),
        );

        expect(messages(findings)).toEqual([
            "`BadFormula`: @formula type must declare at least one string literal",
        ]);
    });

    it("rejects an @formula union with a non-literal member", () => {
        const findings = lintSourceText(
            `/**
             * @formula
             */
            export type MixedFormula = "a" | string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual([
            "`MixedFormula`: @formula type members must all be string literals",
        ]);
    });

    it("ignores a type without the @formula annotation", () => {
        const findings = lintSourceText(`export type NotAFormula = "a" | "b";`, new Set());

        expect(findings).toEqual([]);
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
