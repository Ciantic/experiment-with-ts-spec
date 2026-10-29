/** PGlite configuration, result type mapping, and the driver the app injects. See docs/schema-generation.md. */
import type { DebugLevel, PGlite, ParserOptions } from "@electric-sql/pglite";
import { createSingleConnectionDriver, type SqlDriver } from "../db/sql-driver.ts";

/** Postgres type OIDs, from src/include/catalog/pg_type.dat. */
const OID = {
    int8: 20,
    timestamp: 1114,
    date: 1082,
} as const;

/** Result parsers ported from https://github.com/Ciantic/pg-unified-mapping. */
export function createPgliteParsers(): ParserOptions {
    return {
        [OID.int8]: (value: string) => BigInt(value),
        [OID.timestamp]: (value: string) => value,
        [OID.date]: (value: string) => value,
    };
}

/** The PGlite class, taken as a parameter so the package stays a development dependency of infra. */
export type PgliteConstructor = typeof PGlite;

/** A PGlite driver whose results match the spec types, over one serialized connection. `debug` is PGlite's own log level. */
export function createPgliteDriver(Pglite: PgliteConstructor, options: { debug?: DebugLevel } = {}): SqlDriver {
    const pglite = new Pglite({ parsers: createPgliteParsers(), debug: options.debug ?? 0 });
    return createSingleConnectionDriver(pglite);
}
