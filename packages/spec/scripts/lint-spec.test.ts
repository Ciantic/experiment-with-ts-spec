import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { loadSpec, parseSpec } from "./spec-model.ts";
import { lintSourceText, lintSpec, type Diagnostic } from "./lint-spec.ts";

/** Format findings as `field: message` for concise assertions. */
function messages(findings: Diagnostic[]): string[] {
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

    it("reports every legacy spelling of a renamed tag", () => {
        const findings = lintSourceText(
            `/** @table legacy */
            export interface Legacy {
                /**
                 * @fieldName Source
                 * @widget text
                 * @default 'manual'
                 * @pgtype uuid
                 * @where gte
                 * @queryorderby
                 * @pgtrigger NEW."x" := 1
                 */
                source: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`Legacy`: @table is retired; use @pgTable instead",
            "`source`: @default is retired; use @pgDefault instead",
            "`source`: @pgtype is retired; use @pgType instead",
            "`source`: @where is retired; use @queryWhere instead",
            "`source`: @queryorderby is retired; use @queryOrderBy instead",
            "`source`: @pgtrigger is retired; use @pgTrigger instead",
        ]);
    });

    it("points a retired @pgRollup at the trigger header", () => {
        const findings = lintSourceText(
            `export interface Legacy {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgRollup Child: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgRollup is retired; use @pgTrigger with `on <Child>` instead",
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
                 * @pgTrigger NEW."net" := NEW."q" * NEW."p"
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual(["`label`: @pgTrigger requires @computed"]);
    });

    it("rejects two mechanism tags on one field", () => {
        const findings = lintSourceText(
            `export interface Both {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgVirtual "net" + "tax"
                 * @pgTrigger NEW."net" := NEW."q" * NEW."p"
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgVirtual and @pgTrigger are mutually exclusive",
        ]);
    });

    it("requires an expression on a mechanism tag", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgVirtual
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual(["`label`: @pgVirtual is missing its expression"]);
    });

    it("accepts a @pgTrigger header naming table, timing, and events", () => {
        const findings = lintSourceText(
            `export interface Ok {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert or update or delete on Child: update "t" set "n" = 1 where "id" in (OLD."id", NEW."id")
                 */
                label: number;
            }`,
        );

        expect(messages(findings)).toEqual([]);
    });

    it("requires a statement after a @pgTrigger header", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert on Child:
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual(["`label`: @pgTrigger is missing its statement"]);
    });

    it("requires a @pgTrigger header to end its clause with a colon", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert on Child
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger header needs `: <statement>`, such as `after insert on InvoiceRow: …`",
        ]);
    });

    it("requires at least one event in a @pgTrigger header", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after on Child: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger header needs at least one event: insert, update, delete",
        ]);
    });

    it("rejects an event that is not insert, update, or delete", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert or truncate on Child: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger event `truncate` is not one of: insert, update, delete",
        ]);
    });

    it("reports `instead of`, which is a trigger on a view", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger instead of insert on Child: insert into "t" values (1)
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger cannot be `instead of`, which is a trigger on a view, and the spec has no views",
        ]);
    });

    it("requires a @pgTrigger header to start with its timing", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger on Child: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger header starts with its timing: `before insert or update on <Entity>: …`",
        ]);
    });

    it("requires the entity after a @pgTrigger header's on", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert on: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger `on` is missing the entity it attaches to",
        ]);
    });

    it("reports a level that is not row or statement", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert for each thing: update "t" set "n" = 1
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger level reads `for each row` or `for each statement`",
        ]);
    });

    it("reports a statement-level trigger on a field, which has a column to fill", () => {
        const findings = lintSourceText(
            `export interface Empty {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger after insert for each statement: insert into "log" ("id") values (1)
                 */
                label: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`label`: @pgTrigger on a field runs `for each row`; a statement-level trigger belongs on the interface",
        ]);
    });

    it("accepts an interface-level @pgTrigger that assigns no column", () => {
        const findings = lintSourceText(
            `/**
             * @pgTable invoice
             * @pgTrigger after insert or update or delete: insert into "invoice_audit" ("id", "op") values (coalesce(NEW."id", OLD."id"), tg_op)
             */
            export interface Invoice {
                /**
                 * @fieldName ID
                 * @primaryKey
                 * @widget text
                 */
                id: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts an interface-level @pgTrigger that runs for each row", () => {
        const findings = lintSourceText(
            `/**
             * @pgTable invoice
             * @pgTrigger after insert for each row: insert into "invoice_audit" ("id") values (NEW."id")
             */
            export interface Invoice {
                /**
                 * @fieldName ID
                 * @primaryKey
                 * @widget text
                 */
                id: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("reports an interface-level @pgTrigger that assigns a column", () => {
        const findings = lintSourceText(
            `/**
             * @pgTable invoice
             * @pgTrigger before insert: NEW."total" := 1
             */
            export interface Invoice {
                /**
                 * @fieldName ID
                 * @primaryKey
                 * @widget text
                 */
                id: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`Invoice`: @pgTrigger on an interface cannot assign a column; move it to the field with @computed",
        ]);
    });

    it("reports an interface-level @pgTrigger that names a table", () => {
        const findings = lintSourceText(
            `/**
             * @pgTable invoice
             * @pgTrigger after insert on Row: insert into "log" ("id") values (1)
             */
            export interface Invoice {
                /**
                 * @fieldName ID
                 * @primaryKey
                 * @widget text
                 */
                id: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`Invoice`: @pgTrigger on an interface is already attached to its own table; `on` is for a field",
        ]);
    });

    it("accepts a complete @computed field", () => {
        const findings = lintSourceText(
            `export interface Ok {
                /**
                 * @fieldName Label
                 * @widget number
                 * @computed
                 * @pgTrigger NEW."net" := NEW."q" * NEW."p"
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

    it("accepts @pgDefault with an expression", () => {
        const findings = lintSourceText(
            `export interface Defaulted {
                /**
                 * @fieldName Source
                 * @widget text
                 * @pgDefault 'manual'
                 */
                source: string;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @pgDefault alongside @computed", () => {
        const findings = lintSourceText(
            `export interface DefaultedComputed {
                /**
                 * @fieldName Net amount
                 * @widget number
                 * @computed
                 * @pgTrigger NEW."net" := NEW."q" * NEW."p"
                 * @pgDefault 0
                 */
                net: Money;
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
                createdAt: Date;
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
                createdAt: number;
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
                updatedAt: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`updatedAt`: @updatedAt and @computed are mutually exclusive"]);
    });

    it("rejects @pgDefault on a clock field", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @createdAt
                 * @pgDefault now()
                 */
                createdAt: Date;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`createdAt`: @createdAt supplies its own default; drop @pgDefault",
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
                createdAt: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`createdAt`: @createdAt takes no value"]);
    });

    it("reports @pgDefault without an expression", () => {
        const findings = lintSourceText(
            `export interface EmptyDefault {
                /**
                 * @fieldName Created at
                 * @widget date
                 * @pgDefault
                 */
                createdAt: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`createdAt`: @pgDefault is missing its expression"]);
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
                 * @pgDefault 0
                 */
                version: Version;
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
                version: Version;
                /**
                 * @fieldName Other
                 * @widget number
                 * @version
                 */
                other: Version;
            }`,
        );

        expect(messages(findings)).toEqual(["`Two`: @version may appear on at most one field"]);
    });
});

describe("not-null fields", () => {
    it("rejects @createdAt on an optional field", () => {
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

        expect(messages(findings)).toEqual([
            "`createdAt`: @createdAt makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });

    it("rejects @updatedAt on an optional field", () => {
        const findings = lintSourceText(
            `export interface Stamped {
                /**
                 * @fieldName Updated at
                 * @widget date
                 * @updatedAt
                 */
                updatedAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`updatedAt`: @updatedAt makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });

    it("rejects @version on an optional field", () => {
        const findings = lintSourceText(
            `export interface Versioned {
                /**
                 * @fieldName Version
                 * @widget number
                 * @version
                 * @pgDefault 0
                 */
                version?: Version;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`version`: @version makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });

    it("rejects @pgDefault on an optional field", () => {
        const findings = lintSourceText(
            `export interface Defaulted {
                /**
                 * @fieldName Source
                 * @widget text
                 * @pgDefault 'manual'
                 */
                source?: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`source`: @pgDefault makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });

    it("rejects @primaryKey on an optional field", () => {
        const findings = lintSourceText(
            `export interface Keyed {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey
                 */
                id?: string;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`id`: @primaryKey makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });

    it("accepts the same tags on a required field", () => {
        const findings = lintSourceText(
            `export interface Keyed {
                /**
                 * @fieldName ID
                 * @widget text
                 * @primaryKey
                 */
                id: string;
                /**
                 * @fieldName Created at
                 * @widget date
                 * @createdAt
                 */
                createdAt: Date;
            }`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts @foreignKey on an optional field, since it adds no not-null column", () => {
        const findings = lintSourceText(
            `export interface Relating {
                /**
                 * @fieldName Owner ID
                 * @widget text
                 * @foreignKey Owner
                 */
                ownerId?: string;
            }`,
        );

        expect(findings).toEqual([]);
    });
});

describe("type-level tags", () => {
    it("accepts a @primitive type carrying its @zod schema and @pgType", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgType uuid
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
             * @pgType uuid
             * @zod z.uuid()
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive takes no value"]);
    });

    it("requires @zod and @pgType on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual([
            "`Thing`: @primitive requires @zod",
            "`Thing`: @primitive requires @pgType",
        ]);
    });

    it("requires @pgType on a @primitive type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @zod z.uuid()
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @primitive requires @pgType"]);
    });

    it("reports @pgType without a storage type", () => {
        const findings = lintSourceText(
            `/**
             * @pgType
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @pgType is missing its storage type"]);
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
             * @pgType uuid
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

    it("accepts a @pgType whose select type is the alias's JavaScript type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgType int8
             * @zod z.bigint()
             */
            export type Version = bigint & $brand<"Version">;`,
        );

        expect(findings).toEqual([]);
    });

    it("accepts a Postgres spelling of a mapped type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgType integer
             * @zod z.number().int()
             */
            export type Counter = number;`,
        );

        expect(findings).toEqual([]);
    });

    it("resolves the alias through its brands before comparing the @pgType", () => {
        const findings = lintSourceText(
            `export type GUID = string;
            /**
             * @primitive
             * @pgType decimal
             * @zod z.string()
             */
            export type Decimal = string & $brand<"Decimal">;
            /**
             * @primitive
             * @pgType decimal
             * @zod z.string()
             */
            export type Money = Decimal & $brand<"Money">;`,
        );

        expect(findings).toEqual([]);
    });

    it("reports a @pgType that contradicts the alias's JavaScript type", () => {
        const findings = lintSourceText(
            `/**
             * @primitive
             * @pgType int8
             * @zod z.string()
             */
            export type Liar = string;`,
        );

        expect(messages(findings)).toEqual([
            "`Liar`: @pgType `int8` selects as a `bigint`, but the alias is a `string`",
        ]);
    });

    it("reports a @pgType the mapping does not know", () => {
        const findings = lintSourceText(
            `/**
             * @pgType int83
             */
            export type Thing = string;`,
        );

        expect(messages(findings)).toEqual(["`Thing`: @pgType `int83` is not a Postgres type the mapping knows"]);
    });

    it("resolves the built-in types and an array element", () => {
        const findings = lintSourceText(
            `/**
             * @pgType timestamptz
             */
            export type Moment = Date;
            /**
             * @pgType text
             */
            export type Lines = string[];
            /**
             * @pgType jsonb
             */
            export type Bag = Record<string, unknown>;`,
        );

        expect(findings).toEqual([]);
    });

    it("gives up on a union whose members disagree, rather than guessing", () => {
        const findings = lintSourceText(
            `/**
             * @pgType int8
             */
            export type Target = string | number;`,
        );

        expect(findings).toEqual([]);
    });

    it("gives up on an alias that refers to itself", () => {
        const findings = lintSourceText(
            `/**
             * @pgType int8
             */
            export type Target = Target;`,
        );

        expect(findings).toEqual([]);
    });
});

describe("@queryFilter", () => {
    const field = (name: string, extra: string, type = "string") =>
        `export interface Thing {
            /**
             * @fieldName Label
             * @widget text
             * @queryFilter
             ${extra}
             */
            ${name}: ${type};
        }`;

    it("accepts @queryFilter on a scalar field", () => {
        const findings = lintSourceText(field("value", ""));

        expect(findings).toEqual([]);
    });

    it("rejects @queryFilter with a value", () => {
        const findings = lintSourceText(field("value", "yes"));

        expect(messages(findings)).toEqual(["`value`: @queryFilter takes no value"]);
    });

    it("rejects @queryFilter on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget select
                 * @relation
                 * @queryFilter
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`owner`: @queryFilter must be on a scalar field, not a @relation field",
        ]);
    });

    it("rejects @queryFilter on the primary key, which is a filter by default", () => {
        const findings = lintSourceText(field("id", "@primaryKey"));

        expect(messages(findings)).toEqual([
            "`id`: the primary key is a filter by default; drop @queryFilter",
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
                owner: Owner;
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
                ownerId: OwnerId;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`ownerId`: @primaryKey and @foreignKey are mutually exclusive",
        ]);
    });
});

describe("@pgAutoIncrement", () => {
    const field = (extra: string, type = "number") =>
        `export interface Thing {
            /**
             * @fieldName ID
             * @widget number
             * @primaryKey
             * @pgAutoIncrement
             ${extra}
             */
            id: ${type};
        }`;

    it("accepts @pgAutoIncrement on a primary key", () => {
        const findings = lintSourceText(field(""));

        expect(findings).toEqual([]);
    });

    it("rejects @pgAutoIncrement with a value", () => {
        const findings = lintSourceText(field("integer"));

        expect(messages(findings)).toEqual(["`id`: @pgAutoIncrement takes no value"]);
    });

    it("rejects @pgAutoIncrement on a field that is not the primary key", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Key
                 * @widget text
                 * @primaryKey
                 */
                key: string;
                /**
                 * @fieldName Counter
                 * @widget number
                 * @pgAutoIncrement
                 */
                counter: number;
            }`,
        );

        expect(messages(findings)).toEqual(["`counter`: @pgAutoIncrement must be on a @primaryKey field"]);
    });

    it("rejects a second owner of the column's insert value", () => {
        const findings = lintSourceText(field("@pgDefault 0"));

        expect(messages(findings)).toEqual(["`id`: @pgAutoIncrement and @pgDefault are mutually exclusive"]);
    });

    it("rejects @pgAutoIncrement on an array field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget number
                 * @primaryKey
                 * @pgAutoIncrement
                 */
                id: number[];
            }`,
        );

        expect(messages(findings)).toEqual([
            "`id`: @pgAutoIncrement must be on a single field, not an array",
            "`id`: @primaryKey must be on a single field, not an array",
        ]);
    });

    it("rejects @pgAutoIncrement on an optional field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName ID
                 * @widget number
                 * @pgAutoIncrement
                 */
                id?: number;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`id`: @pgAutoIncrement must be on a @primaryKey field",
            "`id`: @pgAutoIncrement makes its column `not null`, so the field is required; drop the `?`",
        ]);
    });
});

describe("@queryOrderBy", () => {
    const field = (name: string, extra: string, type = "string") =>
        `export interface Thing {
            /**
             * @fieldName Label
             * @widget text
             * @queryOrderBy
             ${extra}
             */
            ${name}: ${type};
        }`;

    it("accepts a bare @queryOrderBy on a scalar field", () => {
        const findings = lintSourceText(field("value", ""));

        expect(findings).toEqual([]);
    });

    it("accepts @queryOrderBy default asc and desc", () => {
        expect(lintSourceText(field("value", "default asc"))).toEqual([]);
        expect(lintSourceText(field("value", "default desc"))).toEqual([]);
    });

    it("rejects an unknown @queryOrderBy value", () => {
        const findings = lintSourceText(field("value", "sideways"));

        expect(messages(findings)).toEqual([
            "`value`: @queryOrderBy takes no value or `default asc|desc`, found `sideways`",
        ]);
    });

    it("rejects `default` with no direction", () => {
        const findings = lintSourceText(field("value", "default"));

        expect(messages(findings)).toEqual([
            "`value`: @queryOrderBy takes no value or `default asc|desc`, found `default`",
        ]);
    });

    it("rejects @queryOrderBy on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @widget select
                 * @relation
                 * @queryOrderBy
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual([
            "`owner`: @queryOrderBy must be on a scalar field, not a @relation field",
        ]);
    });

    it("rejects more than one default ordering field", () => {
        const findings = lintSourceText(
            `export interface Two {
                /**
                 * @fieldName Created
                 * @widget date
                 * @queryOrderBy default asc
                 */
                createdAt?: Date;
                /**
                 * @fieldName Updated
                 * @widget date
                 * @queryOrderBy default desc
                 */
                updatedAt?: Date;
            }`,
        );

        expect(messages(findings)).toEqual(["`Two`: @queryOrderBy default may appear on at most one field"]);
    });
});

describe("@queryWhere", () => {
    const field = (operators: string) => {
        const where = operators === "" ? "@queryWhere" : `@queryWhere ${operators}`;
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

    it("rejects a bare @queryWhere with no operators", () => {
        const findings = lintSourceText(field(""));

        expect(messages(findings)).toEqual([
            "`value`: @queryWhere requires at least one operator, one of: eq, ne, gt, gte, lt, lte",
        ]);
    });

    it("rejects an unknown operator", () => {
        const findings = lintSourceText(field("between"));

        expect(messages(findings)).toEqual([
            "`value`: @queryWhere `between` is not one of: eq, ne, gt, gte, lt, lte",
        ]);
    });

    it("rejects @queryWhere on a relation field", () => {
        const findings = lintSourceText(
            `export interface Thing {
                /**
                 * @fieldName Owner
                 * @queryWhere eq
                 * @widget select
                 * @relation
                 */
                owner?: Owner;
            }`,
        );

        expect(messages(findings)).toEqual(["`owner`: @queryWhere must be on a scalar field, not a @relation field"]);
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
            "`label`: @formula is retired; put the expression on the field with @pgVirtual or @pgTrigger",
        ]);
    });
});

describe("lintSpec over a project", () => {
    const entityGlob = "/src/domain/**/*.ts";
    const aliasGlob = "/src/**/*.ts";

    it("lints interfaces under domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile("/src/domain/Invoice.ts", "export interface Invoice { label: string; }");

        const { findings, interfaces } = lintSpec(parseSpec(project, { entityGlob, aliasGlob }));

        expect(interfaces).toBe(1);
        expect(messages(findings)).toEqual([
            "`Invoice`: missing @repository, naming at least one of: create, upsert, update, delete",
            "`Invoice`: missing @restRepository, naming at least one of: create, upsert, update, delete",
            "`label`: missing @fieldName",
            "`label`: missing @widget",
        ]);
    });

    it("skips contract interfaces outside domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            "/src/operations/Contract.ts",
            "export interface Contract { list(): void; }",
        );
        project.createSourceFile("/src/domain/Invoice.ts", "export interface Invoice { label: string; }");

        const { findings, interfaces } = lintSpec(parseSpec(project, { entityGlob, aliasGlob }));

        expect(interfaces).toBe(1);
        expect(messages(findings)).toEqual([
            "`Invoice`: missing @repository, naming at least one of: create, upsert, update, delete",
            "`Invoice`: missing @restRepository, naming at least one of: create, upsert, update, delete",
            "`label`: missing @fieldName",
            "`label`: missing @widget",
        ]);
    });

    it("still scans type aliases outside domain/", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile("/src/operations/bad.ts", "/** @nonsense */ export type Thing = string;");

        const { findings } = lintSpec(parseSpec(project, { entityGlob, aliasGlob }));

        expect(messages(findings)).toEqual(["`Thing`: @nonsense is not a recognised type tag"]);
    });

    it("checks a @pgType against an alias declared in another file", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            "/src/primitives/Liar.ts",
            `/**
 * @primitive
 * @pgType int8
 * @zod z.string()
 */
export type Liar = string & $brand<"Liar">;`,
        );

        const { findings } = lintSpec(parseSpec(project, { entityGlob, aliasGlob }));

        expect(messages(findings)).toEqual([
            "`Liar`: @pgType `int8` selects as a `bigint`, but the alias is a `string`",
        ]);
    });

    /** Lint one entity with the given interface doc, and no field problems, for the operation rules. */
    function lintEntity(doc: string): string[] {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            "/src/domain/Invoice.ts",
            `${doc}
export interface Invoice {
    /**
     * @fieldName ID
     * @widget text
     * @primaryKey
     */
    id: string;
}`,
        );
        return messages(lintSpec(parseSpec(project, { entityGlob, aliasGlob })).findings);
    }

    it("accepts an entity that names the writes it generates and exposes", () => {
        const findings = lintEntity(`/**
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 */`);

        expect(findings).toEqual([]);
    });

    it("accepts an entity with no @queries, which reads nothing", () => {
        const findings = lintEntity(`/**
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 */`);

        expect(findings).toEqual([]);
    });

    it("reports a missing @repository and @restRepository", () => {
        const findings = lintEntity("/** @pgTable invoice */");

        expect(findings).toEqual([
            "`Invoice`: missing @repository, naming at least one of: create, upsert, update, delete",
            "`Invoice`: missing @restRepository, naming at least one of: create, upsert, update, delete",
        ]);
    });

    it("reports an operation that is not one of the four writes", () => {
        const findings = lintEntity(`/**
 * @repository creat
 * @restRepository creat
 */`);

        expect(findings).toEqual([
            "`Invoice`: @repository `creat` is not one of: create, upsert, update, delete",
            "`Invoice`: @restRepository `creat` is not one of: create, upsert, update, delete",
        ]);
    });

    it("reports a read that is not one of the known read operations", () => {
        const findings = lintEntity(`/**
 * @repository create
 * @restRepository create
 * @queries read
 * @restQueries read
 */`);

        expect(findings).toEqual([
            "`Invoice`: @queries `read` is not one of: query",
            "`Invoice`: @restQueries `read` is not one of: query",
        ]);
    });

    it("requires a value on the read tags, since the operation is named", () => {
        const findings = lintEntity(`/**
 * @repository create
 * @restRepository create
 * @queries
 * @restQueries
 */`);

        expect(findings).toEqual([
            "`Invoice`: @queries requires at least one of: query",
            "`Invoice`: @restQueries requires at least one of: query",
        ]);
    });

    it("reports an operation named twice", () => {
        const findings = lintEntity(`/**
 * @repository create create
 * @restRepository create
 */`);

        expect(findings).toEqual(["`Invoice`: @repository names `create` twice"]);
    });

    it("requires at least one operation in each write list", () => {
        const findings = lintEntity(`/**
 * @repository
 * @restRepository
 */`);

        expect(findings).toEqual([
            "`Invoice`: @repository requires at least one of: create, upsert, update, delete",
            "`Invoice`: @restRepository requires at least one of: create, upsert, update, delete",
        ]);
    });

    it("reports an exposed operation the repository does not generate", () => {
        const findings = lintEntity(`/**
 * @repository create update
 * @restRepository create upsert
 */`);

        expect(findings).toEqual(["`Invoice`: @restRepository `upsert` is not in @repository"]);
    });

    it("reports an exposed read the entity does not generate", () => {
        const findings = lintEntity(`/**
 * @repository create
 * @restRepository create
 * @restQueries query
 */`);

        expect(findings).toEqual(["`Invoice`: @restQueries `query` is not in @queries"]);
    });

    it("reports a tag that appears twice", () => {
        const findings = lintEntity(`/**
 * @repository create
 * @repository update
 * @restRepository create
 */`);

        expect(findings).toEqual(["`Invoice`: @repository appears more than once"]);
    });
});

describe("the committed spec", () => {
    it("passes lint", () => {
        const { findings, interfaces, properties } = lintSpec(loadSpec());

        expect(findings).toEqual([]);
        expect(interfaces).toBeGreaterThan(0);
        expect(properties).toBeGreaterThan(0);
    });
});
