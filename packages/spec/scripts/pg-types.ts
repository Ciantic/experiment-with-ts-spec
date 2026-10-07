/**
 * The Postgres types `@pgType` may name and the JavaScript type each one selects as.
 * Mirrors pg-unified-mapping, which the drivers' result parsers already implement. See docs/schema-generation.md.
 */
import type { JsType } from "./spec-model.ts";

/** The type each Postgres type selects as, keyed by the name pg-unified-mapping uses. */
const PG_TYPE_SELECT: Record<string, JsType> = {
    int2: "number",
    int4: "number",
    int8: "bigint",
    float4: "number",
    float8: "number",
    decimal: "string",
    money: "string",
    text: "string",
    varchar: "string",
    char: "string",
    bytea: "Uint8Array",
    timestamp: "string",
    timestamptz: "Date",
    date: "string",
    time: "string",
    timetz: "string",
    interval: "string",
    boolean: "boolean",
    uuid: "string",
    jsonb: "object",
    json: "object",
    inet: "string",
    cidr: "string",
    macaddr: "string",
    macaddr8: "string",
    bit: "string",
    varbit: "string",
    tsvector: "string",
    tsquery: "string",
    xml: "string",
    point: "string",
    line: "string",
    lseg: "string",
    box: "string",
    path: "string",
    polygon: "string",
    circle: "string",
    xmin: "number",
    pg_lsn: "string",
    pg_snapshot: "string",
};

/** Postgres' own spellings of a mapped type, so `integer` and `int4` name the same entry. */
const PG_TYPE_ALIASES: Record<string, string> = {
    smallint: "int2",
    integer: "int4",
    bigint: "int8",
    real: "float4",
    "double precision": "float8",
    numeric: "decimal",
    bool: "boolean",
    "character varying": "varchar",
    character: "char",
    "bit varying": "varbit",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time with time zone": "timetz",
    "time without time zone": "time",
};

/** The Postgres type a bare TypeScript type maps to when an alias declares no `@pgType`. */
export const DEFAULT_PG_TYPES: Record<string, string> = {
    string: "text",
    number: "float8",
    boolean: "boolean",
    bigint: "int8",
    Date: "timestamptz",
};

/** The JavaScript type a Postgres type selects as, or undefined when the mapping does not know the name. */
export function selectJsType(pgType: string): JsType | undefined {
    return PG_TYPE_SELECT[PG_TYPE_ALIASES[pgType] ?? pgType];
}
