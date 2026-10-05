import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { lintProject, lintSourceText, type Finding } from "./lint-spec.ts";

/** Format findings as `field: message` for concise assertions. */
function messages(findings: Finding[]): string[] {
    return findings.map((finding) => finding.message);
}

describe("lintSourceText", () => {

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
        );

        expect(messages(findings)).toEqual([
            "`label`: @readonly is retired; use @computed for a derived field; a system-assigned column needs no tag",
        ]);
    });

    it("reports @generated as retired, since no tag marks a column system-assigned", () => {
        const findings = lintSourceText(
            `export interface Legacy {
                /**
                 * @fieldName ID
                 * @widget text
                 * @generated
                 */
                id: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`id`: @generated is retired; no tag marks a column as system-assigned; drop it",
        ]);
    });

    it("reports the renamed @default and @table under their new names", () => {
        const findings = lintSourceText(
            `/** @table legacy */
            export interface Legacy {
                /**
                 * @fieldName Source
                 * @widget text
                 * @default 'manual'
                 */
                source: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`Legacy`: @table is retired; use @pgtable instead",
            "`source`: @default is retired; use @pgdefault instead",
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
        );

        expect(messages(findings)).toEqual(["`label`: @fieldName is empty"]);
    });

    it("rejects parameters on @computed", () => {
        const findings = lintSourceText(
            `export interface Missing {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed storage=stored
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @computed takes no parameters, found: storage=",
        ]);
    });

    it("requires @computed on a mechanism tag", () => {
        const findings = lintSourceText(
            `export interface Orphan {
                /**
                 * @fieldName Label
                 * @widget number
                 * @pgtrigger NEW."net" := NEW."q" * NEW."p"
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual(["`label`: @pgtrigger requires @computed"]);
    });

    it("rejects two mechanism tags on one field", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgvirtual "net" + "tax"
                 * @pgtrigger NEW."net" := NEW."q" * NEW."p"
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgvirtual and @pgtrigger are mutually exclusive",
        ]);
    });

    it("requires an expression on a mechanism tag", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgvirtual
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual(["`label`: @pgvirtual is missing its expression"]);
    });

    it("rejects OLD. in a @pgrollup statement, which the generator mirrors", () => {
        const findings = lintSourceText(
            `export interface Rollup {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgrollup update "t" set "n" = OLD."n" where "id" = NEW."id"
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgrollup is written with NEW.; the delete variant is generated from it",
        ]);
    });

    it("accepts a complete @computed field", () => {
        const findings = lintSourceText(
            `export interface Ok {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgtrigger NEW."net" := NEW."q" * NEW."p"
                 */
                label: number;
            }`,
        );

        expect(findings).toEqual([]);
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
        );

        expect(messages(findings)).toEqual([
            "`label`: @fieldName appears more than once",
            "`label`: @fieldName appears more than once",
        ]);
    });

    it("accepts a field with no ownership tag", () => {
        const findings = lintSourceText(
            `export interface ClientSupplied {
                /**
                 * @fieldName Note
                 * @widget textarea
                 */
                note: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @pgdefault with an expression", () => {
        const findings = lintSourceText(
            `export interface Defaulted {
                /**
                 * @fieldName Source
                 * @widget text
                 * @pgdefault 'manual'
                 */
                source?: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @pgdefault alongside @computed", () => {
        const findings = lintSourceText(
            `export interface DefaultedComputed {
                /**
                 * @fieldName Net amount
                 * @widget number
                 * @computed
                 * @pgtrigger NEW."net" := NEW."q" * NEW."p"
                 * @pgdefault 0
                 */
                net?: Money;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @createdAt on a Date field", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @createdAt
                 */
                createdAt?: Date;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("rejects a clock tag on a non-Date field", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Created at
                 * @widget number
                 * @createdAt
                 */
                createdAt?: number;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`createdAt`: @createdAt must be on a `Date` field, found `number`",
        ]);
    });

    it("rejects a clock tag combined with @computed", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Updated at
                 * @widget date
                 * @updatedAt
                 * @computed
                 */
                updatedAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`updatedAt`: @updatedAt and @computed are mutually exclusive"]);
    });

    it("rejects @pgdefault on a clock field", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @createdAt
                 * @pgdefault now()
                 */
                createdAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`createdAt`: @createdAt supplies its own default; drop @pgdefault",
        ]);
    });

    it("rejects a clock tag with a value", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @createdAt now()
                 */
                createdAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`createdAt`: @createdAt takes no value"]);
    });

    it("reports @pgdefault without an expression", () => {
        const findings = lintSourceText(
            `export interface EmptyDefault {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @pgdefault
                 */
                createdAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`createdAt`: @pgdefault is missing its expression"]);
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
                 * @pgdefault 0
                 */
                version?: Version;
            }`,
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
        );

        expect(messages(findings)).toEqual(["`version`: @version must be on a `Version` field, found `string`"]);
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
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive takes no value"]);
    });

    it("requires @zod and @pgtype on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual([
            "`Thing`: @primitive requires @zod",
            "`Thing`: @primitive requires @pgtype",
        ]);
    });

    it("requires @pgtype on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @zod z.uuid()
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive requires @pgtype"]);
    });

    it("reports @pgtype without a storage type", () => {
        const findings = lintSourceText(
            `/**
             * @pgtype
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @pgtype is missing its storage type"]);
    });

    it("reports @zod without a schema expression", () => {
        const findings = lintSourceText(
            `/**
             * @zod
             */
            export type Thing = string;`,
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
        );

        expect(messages(findings)).toEqual(["`Thing`: @nonsense is not a recognised type tag"]);
    });

    it("reports an unrecognised type tag", () => {
        const findings = lintSourceText(
            `/**
             * @nonsense
             */
            export type Thing = string;`,
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
        const findings = lintSourceText(field("value", ""));

        expect(findings).toEqual([]);
    });

    it("rejects @queryfilter with a value", () => {
        const findings = lintSourceText(field("value", "yes"));

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
        );

        expect(messages(findings)).toEqual([
            "`owner`: @queryfilter must be on a scalar field, not a @relation field",
        ]);
    });

    it("rejects @queryfilter on the primary key, which is a filter by default", () => {
        const findings = lintSourceText(field("id", "@primaryKey"));

        expect(messages(findings)).toEqual([
            "`id`: the primary key is a filter by default; drop @queryfilter",
        ]);
    });
});

describe("@primaryKey and @foreignKey", () => {
    it("accepts @primaryKey on a scalar field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey
                 */
                id: ThingId;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("rejects @primaryKey with a value", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey yes
                 */
                id: ThingId;
            }`,
        );

        expect(messages(findings)).toEqual(["`id`: @primaryKey takes no value"]);
    });

    it("accepts @primaryKey on several fields, which is a composite key", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey
                 */
                id: ThingId;
                /**
                 * @fieldName Code
                 * @widget text
                 * @primaryKey
                 */
                code: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("rejects a numbered @primaryKey, since the declaration order is the key order", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey 1
                 */
                id: ThingId;
                /**
                 * @fieldName Code
                 * @widget text
                 * @primaryKey 2
                 */
                code: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`id`: @primaryKey takes no value",
            "`code`: @primaryKey takes no value",
        ]);
    });

    it("rejects @primaryKey on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget select
                 * @relation
                 * @primaryKey
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`owner`: @primaryKey must be on a scalar field, not a @relation field",
        ]);
    });

    it("accepts @foreignKey with the interface it references", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget text
                 * @foreignKey Owner
                 */
                ownerId?: OwnerId;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("rejects @foreignKey without the interface it references", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget text
                 * @foreignKey
                 */
                ownerId?: OwnerId;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`ownerId`: @foreignKey is missing the interface it references, such as `@foreignKey Customer`",
        ]);
    });

    it("rejects @primaryKey and @foreignKey together", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget text
                 * @primaryKey
                 * @foreignKey Owner
                 */
                ownerId?: OwnerId;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`ownerId`: @primaryKey and @foreignKey are mutually exclusive",
        ]);
    });
});

describe("@queryorderby", () => {
    const field = (name: string, extra: string, type = "string") =>
        `export interface Thing {
            /**
             * @fieldName Label
             * @widget text
             * @queryorderby
             ${extra}
             */
            ${name}: ${type};
        }`;

    it("accepts a bare @queryorderby on a scalar field", () => {
        const findings = lintSourceText(field("value", ""));

        expect(findings).toEqual([]);
    });

    it("accepts @queryorderby default asc and desc", () => {
        expect(lintSourceText(field("value", "default asc"))).toEqual([]);
        expect(lintSourceText(field("value", "default desc"))).toEqual([]);
    });

    it("rejects an unknown @queryorderby value", () => {
        const findings = lintSourceText(field("value", "sideways"));

        expect(messages(findings)).toEqual([
            "`value`: @queryorderby takes no value or `default asc|desc`, found `sideways`",
        ]);
    });

    it("rejects `default` with no direction", () => {
        const findings = lintSourceText(field("value", "default"));

        expect(messages(findings)).toEqual([
            "`value`: @queryorderby takes no value or `default asc|desc`, found `default`",
        ]);
    });

    it("rejects @queryorderby on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget select
                 * @relation
                 * @queryorderby
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`owner`: @queryorderby must be on a scalar field, not a @relation field",
        ]);
    });

    it("rejects more than one default ordering field", () => {
        const findings = lintSourceText(
            `export interface Two {
                /**
                 * @fieldName Created
                 * @widget date
                 * @queryorderby default asc
                 */
                createdAt?: Date;
                /**
                 * @fieldName Updated
                 * @widget date
                 * @queryorderby default desc
                 */
                updatedAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`Two`: @queryorderby default may appear on at most one field"]);
    });
});

describe("@where", () => {
    const field = (operators: string) => {
        const where = operators === "" ? "@where" : `@where ${operators}`;
        return `export interface Thing {
            /**
             * @fieldName Value
             * ${where}
             * @widget text
             */
            value: string;
        }`;
    };

    it("accepts a list of known operators", () => {
        expect(lintSourceText(field("gte lte"))).toEqual([]);
        expect(lintSourceText(field("eq ne gt gte lt lte"))).toEqual([]);
    });

    it("rejects a bare @where with no operators", () => {
        const findings = lintSourceText(field(""));

        expect(messages(findings)).toEqual([
            "`value`: @where requires at least one operator, one of: eq, ne, gt, gte, lt, lte",
        ]);
    });

    it("rejects an unknown operator", () => {
        const findings = lintSourceText(field("between"));

        expect(messages(findings)).toEqual([
            "`value`: @where `between` is not one of: eq, ne, gt, gte, lt, lte",
        ]);
    });

    it("rejects @where on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @where eq
                 * @widget select
                 * @relation
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual(["`owner`: @where must be on a scalar field, not a @relation field"]);
    });
});

describe("retired @formula", () => {
    it("points a field-level @formula at the mechanism tags", () => {
        const findings = lintSourceText(
            `/**
             * @formula
             */
            export type RowFormula = "a" | "b";`,
        );

        expect(messages(findings)).toEqual(["`RowFormula`: @formula is not a recognised type tag"]);
    });

    it("reports @formula on a field with its replacement", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Label
                 * @widget number
                 * @formula rowNet
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @formula is retired; put the expression on the field with @pgvirtual, @pgtrigger, or @pgrollup",
        ]);
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
