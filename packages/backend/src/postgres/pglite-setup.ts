/** PGlite configuration and result type mapping. See docs/schema-generation.md. */
import { PGlite, type DebugLevel, type ParserOptions } from "@electric-sql/pglite";

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

/** A PGlite instance whose results match the spec types. `debug` is PGlite's own log level. */
export function createPglite(options: { debug?: DebugLevel } = {}): PGlite {
    return new PGlite({ parsers: createPgliteParsers(), debug: options.debug ?? 0 });
}
