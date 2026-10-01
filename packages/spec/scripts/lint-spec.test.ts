import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { lintProject, lintSourceText, readFormulaNames, type Finding } from "./lint-spec.ts";

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

    it("accepts @inlined as a bare marker", () => {
        const findings = lintSourceText(
            `export interface Inlined {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @inlined
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @relation and @children on the right shapes", () => {
        const findings = lintSourceText(
            `export interface Branches {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @relation
                 */
                customer?: Customer;
                /**
                 * @fieldName Rows
                 * @widget table
                 * @children
                 */
                rows?: InvoiceRow[];
            }`,
            formulaNames,
        );

        expect(findings).toEqual([]);
    });

    it("reports a value on a branch marker", () => {
        const findings = lintSourceText(
            `export interface Valued {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @inlined Customer
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`customer`: @inlined takes no value; the entity comes from the field type",
        ]);
    });

    it("rejects @inlined together with @relation", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Customer
                 * @widget select
                 * @relation
                 * @inlined
                 */
                customer?: Customer;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual(["`customer`: @relation and @inlined are mutually exclusive"]);
    });

    it("rejects @relation together with @children", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Rows
                 * @widget table
                 * @relation
                 * @children
                 */
                rows?: InvoiceRow[];
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`rows`: @relation and @children are mutually exclusive",
            "`rows`: @relation must be on a single entity field, not an array",
        ]);
    });

    it("rejects @children on a single entity", () => {
        const findings = lintSourceText(
            `export interface Bad {
                /**
                 * @fieldName Rows
                 * @widget table
                 * @children
                 */
                rows?: InvoiceRow;
            }`,
            formulaNames,
        );

        expect(messages(findings)).toEqual([
            "`rows`: @children must be on an array field, such as `rows?: InvoiceRow[]`",
        ]);
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

describe("type-level tags", () => {
    it("accepts a @primitive type carrying its @zod schema and @pgtype", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgtype uuid
             * @zod z.uuid().brand<"ThingId">()
             */
            export type ThingId = string & $brand<"ThingId">;`,
            new Set(),
        );

        expect(findings).toEqual([]);
    });

    it("reports a value on the @primitive marker", () => {
        const findings = lintSourceText(
            `/**
             * @primitive something
             * @pgtype uuid
             * @zod z.uuid()
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive takes no value"]);
    });

    it("requires a schema tag and @pgtype on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual([
            "`Thing`: @primitive requires @zod or @effect",
            "`Thing`: @primitive requires @pgtype",
        ]);
    });

    it("accepts a @primitive type carrying its @effect schema and @pgtype", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgtype uuid
             * @effect Schema.String.check(Schema.isUUID())
             */
            export type ThingId = string;`,
            new Set(),
        );

        expect(findings).toEqual([]);
    });

    it("reports @effect without a schema expression", () => {
        const findings = lintSourceText(
            `/**
             * @effect
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @effect is missing its schema expression"]);
    });

    it("requires @pgtype on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @zod z.uuid()
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive requires @pgtype"]);
    });

    it("reports @pgtype without a storage type", () => {
        const findings = lintSourceText(
            `/**
             * @pgtype
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @pgtype is missing its storage type"]);
    });

    it("reports @zod without a schema expression", () => {
        const findings = lintSourceText(
            `/**
             * @zod
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @zod is missing its schema expression"]);
    });

    it("reports a duplicated @zod", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgtype uuid
             * @zod z.uuid()
             * @zod z.string()
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual([
            "`Thing`: @zod appears more than once",
            "`Thing`: @zod appears more than once",
        ]);
    });

    it("reports an unrecognised type tag", () => {
        const findings = lintSourceText(
            `/**
             * @nonsense
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @nonsense is not a recognised type tag"]);
    });

    it("reports an unrecognised type tag", () => {
        const findings = lintSourceText(
            `/**
             * @nonsense
             */
            export type Thing = string;`,
            new Set(),
        );

        expect(messages(findings)).toEqual(["`Thing`: @nonsense is not a recognised type tag"]);
    });
});

describe("@queryfilter", () => {
    const field = (name: string, extra: string, type = "string") =>
        `export interface Thing {
            /**
             * @fieldName Label
             * @widget text
             * @queryfilter
             ${extra}
             */
            ${name}: ${type};
        }`;

    it("accepts @queryfilter on a scalar field", () => {
        const findings = lintSourceText(field("value", ""), new Set());

        expect(findings).toEqual([]);
    });

    it("rejects @queryfilter with a value", () => {
        const findings = lintSourceText(field("value", "yes"), new Set());

        expect(messages(findings)).toEqual(["`value`: @queryfilter takes no value"]);
    });

    it("rejects @queryfilter on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget select
                 * @relation
                 * @queryfilter
                 */
                owner?: Owner;
            }`,
            new Set(),
        );

        expect(messages(findings)).toEqual([
            "`owner`: @queryfilter must be on a scalar field, not a @relation field",
        ]);
    });

    it("rejects @queryfilter on id, which is a filter by default", () => {
        const findings = lintSourceText(field("id", ""), new Set());

        expect(messages(findings)).toEqual(["`id`: `id` is a filter by default; drop @queryfilter"]);
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

describe("lintProject", () => {
    const entityGlob = "/src/domain/**/*.ts";
    const aliasGlob = "/src/**/*.ts";

    it("lints interfaces under domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile("/src/domain/Invoice.ts", "export interface Invoice { label: string; }");

        const { findings, interfaces } = lintProject(project, { entityGlob, aliasGlob });

        expect(interfaces).toBe(1);
        expect(messages(findings)).toEqual(["`label`: missing @fieldName", "`label`: missing @widget"]);
    });

    it("skips contract interfaces outside domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            "/src/operations/Contract.ts",
            "export interface Contract { list(): void; }",
        );
        project.createSourceFile("/src/domain/Invoice.ts", "export interface Invoice { label: string; }");

        const { findings, interfaces } = lintProject(project, { entityGlob, aliasGlob });

        expect(interfaces).toBe(1);
        expect(messages(findings)).toEqual(["`label`: missing @fieldName", "`label`: missing @widget"]);
    });

    it("still scans type aliases outside domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile("/src/operations/bad.ts", "/** @nonsense */ export type Thing = string;");

        const { findings } = lintProject(project, { entityGlob, aliasGlob });

        expect(messages(findings)).toEqual(["`Thing`: @nonsense is not a recognised type tag"]);
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
