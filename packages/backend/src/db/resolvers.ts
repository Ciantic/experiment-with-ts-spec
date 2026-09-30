/**
 * Generic read resolver over query metadata. See docs/queries.md.
 *
 * Written once by hand: it turns a `Selection` plus a table's generated metadata
 * into SQL. A branch costs one extra query, batched over every parent — there is
 * no JSON aggregation.
 */
import type { Selection, Selected } from "spec/queries/selection.js";
import type { SqlExecutor } from "./sql-executor.js";

/** How a branch field of a table reaches another table. */
export interface QueryRelation {
    kind: "relation" | "children" | "inlined";
    /** The target table, for `relation` and `children`. */
    table?: string;
    /** `relation`: this table's foreign-key column. `children`: the child's foreign-key column. */
    column?: string;
    /** `inlined`: target field -> this table's prefixed column. */
    columns?: Record<string, string>;
}

/** A table as the resolver sees it. */
export interface QueryTable {
    /** The physical table name. */
    name: string;
    /** The primary-key column. */
    key: string;
    /** Scalar fields, mapped to their physical column. */
    fields: Record<string, string>;
    /** Branch fields, mapped to how they are joined or flattened. */
    relations: Record<string, QueryRelation>;
}

/** Every table the resolver may read, keyed by physical table name. */
export interface QueryModel {
    tables: Record<string, QueryTable>;
}

/** What a fetch selects and filters on: root arguments, or a column matched against parent keys. */
type FetchFilter =
    | { kind: "args"; args: Record<string, unknown>; inFilters?: Record<string, string> | undefined }
    | { kind: "match"; column: string; values: unknown[] };

/** What a read selects and filters on, as the generated function passes it. */
export interface ResolveOptions<E, S extends Selection<E>> {
    select: S;
    /** Set-membership arguments from `@in`: argument name -> the field it matches. See docs/queries.md. */
    inFilters?: Record<string, string>;
}

/** A nested fetch's row: its key, the value its filter matched, and the shaped result. */
interface FetchedRow {
    key: unknown;
    match: unknown;
    value: Record<string, unknown>;
}

/** The interface a generated query function is built on, over one entity. */
export interface Resolver {
    resolveMany<E, S extends Selection<E>>(
        db: SqlExecutor,
        table: string,
        args: Record<string, unknown>,
        opts: ResolveOptions<E, S>,
    ): Promise<Selected<E, S>[]>;

    resolveOne<E, S extends Selection<E>>(
        db: SqlExecutor,
        table: string,
        args: Record<string, unknown>,
        opts: ResolveOptions<E, S>,
    ): Promise<Selected<E, S> | undefined>;
}

const KEY_ALIAS = "__key";
const MATCH_ALIAS = "__match";

/** Quote an identifier, matching the generated SQL. */
function quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** The `rows` array from a driver result, whatever else it carries. */
function rowsOf(result: unknown): Record<string, unknown>[] {
    if (result !== null && typeof result === "object" && "rows" in result) {
        const rows = (result as { rows?: unknown }).rows;
        if (Array.isArray(rows)) {
            return rows as Record<string, unknown>[];
        }
    }
    throw new Error("the executor did not return rows");
}

/** The values, with nulls and duplicates dropped, as the keys of an `in (…)` list. */
function distinct(values: unknown[]): unknown[] {
    const seen = new Set<unknown>();
    for (const value of values) {
        if (value !== null && value !== undefined) {
            seen.add(value);
        }
    }
    return [...seen];
}

/** `true` on a branch means its own scalar fields, never recursion into its branches. */
function normalizeSelection(meta: QueryTable, value: unknown): Record<string, unknown> {
    if (value === true) {
        const selection: Record<string, unknown> = {};
        for (const field of Object.keys(meta.fields)) {
            selection[field] = true;
        }
        return selection;
    }
    return value as Record<string, unknown>;
}

/** The target fields an `@inlined` branch selects: every column for `true`. */
function inlinedTargets(columns: Record<string, string>, value: unknown): string[] {
    return value === true ? Object.keys(columns) : Object.keys(value as Record<string, unknown>);
}

/** The physical column an argument of the given name filters, or undefined when it is not filterable. */
function columnForArgument(meta: QueryTable, name: string): string | undefined {
    const field = meta.fields[name];
    if (field !== undefined) {
        return field;
    }
    for (const relation of Object.values(meta.relations)) {
        if (relation.kind === "relation" && relation.column === name) {
            return name;
        }
    }
    return undefined;
}

/** Build a resolver bound to a table model. The generated functions call this once. */
export function createResolver(model: QueryModel): Resolver {
    async function fetch(
        db: SqlExecutor,
        table: string,
        selection: Record<string, unknown>,
        filter: FetchFilter,
    ): Promise<FetchedRow[]> {
        const meta = model.tables[table];
        if (!meta) {
            throw new Error(`no query metadata for table \`${table}\``);
        }

        const alias = quote("t");
        const selects: string[] = [];
        const params: unknown[] = [];
        const where: string[] = [];

        const scalars: string[] = [];
        const inlined: { field: string; relation: QueryRelation }[] = [];
        const toOne: { field: string; relation: QueryRelation }[] = [];
        const toMany: { field: string; relation: QueryRelation }[] = [];

        for (const [field, value] of Object.entries(selection)) {
            const relation = meta.relations[field];
            if (!relation) {
                const column = meta.fields[field];
                if (column === undefined) {
                    throw new Error(`unknown field \`${field}\` on \`${table}\``);
                }
                selects.push(`${alias}.${quote(column)} as ${quote(field)}`);
                scalars.push(field);
                continue;
            }
            if (relation.kind === "inlined") {
                inlined.push({ field, relation });
            } else if (relation.kind === "relation") {
                if (!relation.column) {
                    throw new Error(`relation \`${table}.${field}\` has no foreign-key column`);
                }
                // The key is read only to join the branch; it is not part of the result.
                selects.push(`${alias}.${quote(relation.column)} as ${quote(`__fk_${field}`)}`);
                toOne.push({ field, relation });
            } else {
                if (!relation.column) {
                    throw new Error(`children \`${table}.${field}\` has no foreign-key column`);
                }
                toMany.push({ field, relation });
            }
        }

        // The key is always selected so rows can be mapped; a nested fetch also reads the matched column.
        selects.push(`${alias}.${quote(meta.key)} as ${quote(KEY_ALIAS)}`);
        const matchColumn = filter.kind === "match" && filter.column !== meta.key ? filter.column : undefined;
        if (matchColumn !== undefined) {
            selects.push(`${alias}.${quote(matchColumn)} as ${quote(MATCH_ALIAS)}`);
        }

        // An inlined branch is columns on this row, so it is projected, never joined.
        const projected: Record<string, string[]> = {};
        for (const { field, relation } of inlined) {
            const columns = relation.columns ?? {};
            const targets: string[] = [];
            for (const target of inlinedTargets(columns, selection[field])) {
                const column = columns[target];
                if (column === undefined) {
                    throw new Error(`inlined \`${table}.${field}\` has no column for \`${target}\``);
                }
                selects.push(`${alias}.${quote(column)} as ${quote(`__in_${field}_${target}`)}`);
                targets.push(target);
            }
            projected[field] = targets;
        }

        if (filter.kind === "args") {
            for (const [name, value] of Object.entries(filter.args)) {
                if (value === undefined) {
                    continue;
                }
                const inField = filter.inFilters?.[name];
                if (inField !== undefined) {
                    if (!Array.isArray(value)) {
                        throw new Error(`set filter \`${name}\` on \`${table}\` needs an array`);
                    }
                    const column = columnForArgument(meta, inField);
                    if (column === undefined) {
                        throw new Error(`unknown filter field \`${inField}\` on \`${table}\``);
                    }
                    const values = distinct(value);
                    if (values.length === 0) {
                        where.push("false");
                        continue;
                    }
                    const placeholders = values.map((item) => {
                        params.push(item);
                        return `$${params.length}`;
                    });
                    where.push(`${alias}.${quote(column)} in (${placeholders.join(", ")})`);
                    continue;
                }
                if (Array.isArray(value)) {
                    throw new Error(`filter \`${name}\` on \`${table}\` is an array; annotate it with @in`);
                }
                const column = columnForArgument(meta, name);
                if (column === undefined) {
                    throw new Error(`unknown filter field \`${name}\` on \`${table}\``);
                }
                params.push(value);
                where.push(`${alias}.${quote(column)} = $${params.length}`);
            }
        } else {
            if (filter.values.length === 0) {
                return [];
            }
            const placeholders = filter.values.map((value) => {
                params.push(value);
                return `$${params.length}`;
            });
            where.push(`${alias}.${quote(filter.column)} in (${placeholders.join(", ")})`);
        }

        const filterSql = where.length > 0 ? ` where ${where.join(" and ")}` : "";
        const sql = `select ${selects.join(", ")} from ${quote(meta.name)} as ${alias}${filterSql}`;
        const rows = rowsOf(await db.query(sql, params));

        const fetched: FetchedRow[] = rows.map((row) => {
            const value: Record<string, unknown> = {};
            for (const field of scalars) {
                value[field] = row[field];
            }
            for (const { field } of inlined) {
                const nested: Record<string, unknown> = {};
                for (const target of projected[field] ?? []) {
                    nested[target] = row[`__in_${field}_${target}`];
                }
                value[field] = nested;
            }
            return {
                key: row[KEY_ALIAS],
                match: matchColumn === undefined ? row[KEY_ALIAS] : row[MATCH_ALIAS],
                value,
            };
        });

        // A to-one branch: one batched query for every distinct foreign key.
        for (const { field, relation } of toOne) {
            const targetName = relation.table ?? "";
            const target = model.tables[targetName];
            if (!target) {
                throw new Error(`relation \`${table}.${field}\` targets unknown table \`${targetName}\``);
            }
            const keys = distinct(rows.map((row) => row[`__fk_${field}`]));
            const related = await fetch(db, targetName, normalizeSelection(target, selection[field]), {
                kind: "match",
                column: target.key,
                values: keys,
            });
            const byKey = new Map(related.map((item) => [item.key, item.value]));
            fetched.forEach((item, index) => {
                const foreignKey = rows[index]?.[`__fk_${field}`];
                item.value[field] =
                    foreignKey === null || foreignKey === undefined ? undefined : byKey.get(foreignKey);
            });
        }

        // A to-many branch: one batched query for every distinct parent key, then group in memory.
        for (const { field, relation } of toMany) {
            const targetName = relation.table ?? "";
            const target = model.tables[targetName];
            if (!target || !relation.column) {
                throw new Error(`children \`${table}.${field}\` targets unknown table \`${targetName}\``);
            }
            const keys = distinct(rows.map((row) => row[KEY_ALIAS]));
            const related = await fetch(db, targetName, normalizeSelection(target, selection[field]), {
                kind: "match",
                column: relation.column,
                values: keys,
            });
            const groups = new Map<unknown, Record<string, unknown>[]>();
            for (const item of related) {
                const group = groups.get(item.match);
                if (group) {
                    group.push(item.value);
                } else {
                    groups.set(item.match, [item.value]);
                }
            }
            for (const item of fetched) {
                item.value[field] = groups.get(item.key) ?? [];
            }
        }

        return fetched;
    }

    async function resolveMany<E, S extends Selection<E>>(
        db: SqlExecutor,
        table: string,
        args: Record<string, unknown>,
        opts: ResolveOptions<E, S>,
    ): Promise<Selected<E, S>[]> {
        const rows = await fetch(db, table, opts.select as Record<string, unknown>, {
            kind: "args",
            args,
            inFilters: opts.inFilters,
        });
        return rows.map((row) => row.value) as unknown as Selected<E, S>[];
    }

    async function resolveOne<E, S extends Selection<E>>(
        db: SqlExecutor,
        table: string,
        args: Record<string, unknown>,
        opts: ResolveOptions<E, S>,
    ): Promise<Selected<E, S> | undefined> {
        const rows = await resolveMany<E, S>(db, table, args, opts);
        return rows[0];
    }

    return { resolveMany, resolveOne };
}
