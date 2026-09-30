/**
 * Generic read resolver over query metadata. See docs/queries.md.
 *
 * Written once by hand: it turns a `Selection` plus a table's generated metadata
 * into SQL. A branch costs one extra query, batched over every parent — there is
 * no JSON aggregation.
 */
import type { Selection, Selected } from "./selection.js";
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
    | { kind: "args"; args: Record<string, unknown> }
    | { kind: "match"; column: string; values: unknown[] };

/** What a read selects and filters on, as the generated function passes it. */
export interface ResolveOptions<E, S extends Selection<E>> {
    select: S;
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

/** The alias a root query gives its table. */
const TABLE_ALIAS = quote("t");

/** The alias a to-one branch's foreign-key column is projected under. */
function foreignKeyAlias(field: string): string {
    return `__fk_${field}`;
}

/** The alias an inlined column is projected under. */
function inlinedAlias(field: string, target: string): string {
    return `__in_${field}_${target}`;
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
    return meta.fields[name];
}

/** A WHERE clause and its positional parameters. */
interface FilterSql {
    /** The clause including a leading ` where `, or "" when nothing filters. */
    where: string;
    params: unknown[];
}

/** A branch to load with one batched query. */
interface Branch {
    field: string;
    relation: QueryRelation;
    /** The nested selection as written; `true` means every scalar of the branch. */
    nested: unknown;
}

/** A selection split into its select list, scalars, inlined columns, and branches. */
interface Projection {
    /** Select-list expressions, aliased to the result keys. */
    columns: string[];
    /** Scalar fields, copied from the row under their own name. */
    scalars: string[];
    /** Inlined branches, each with the targets projected from this table's own row. */
    inlined: { field: string; targets: string[] }[];
    toOne: Branch[];
    toMany: Branch[];
}

/** Push values as positional parameters and return their `$n` placeholders. */
function placeholders(params: unknown[], values: unknown[]): string {
    return values
        .map((value) => {
            params.push(value);
            return `$${params.length}`;
        })
        .join(", ");
}

/** Split a selection into the select list, the scalars, the inlined columns, and the branches. */
function planProjection(table: string, meta: QueryTable, selection: Record<string, unknown>): Projection {
    const columns: string[] = [];
    const scalars: string[] = [];
    const inlined: Projection["inlined"] = [];
    const toOne: Branch[] = [];
    const toMany: Branch[] = [];

    for (const [field, nested] of Object.entries(selection)) {
        const relation = meta.relations[field];
        if (!relation) {
            const column = meta.fields[field];
            if (column === undefined) {
                throw new Error(`unknown field \`${field}\` on \`${table}\``);
            }
            columns.push(`${TABLE_ALIAS}.${quote(column)} as ${quote(field)}`);
            scalars.push(field);
            continue;
        }
        if (relation.kind === "inlined") {
            const map = relation.columns ?? {};
            const targets: string[] = [];
            for (const target of inlinedTargets(map, nested)) {
                const column = map[target];
                if (column === undefined) {
                    throw new Error(`inlined \`${table}.${field}\` has no column for \`${target}\``);
                }
                columns.push(`${TABLE_ALIAS}.${quote(column)} as ${quote(inlinedAlias(field, target))}`);
                targets.push(target);
            }
            inlined.push({ field, targets });
            continue;
        }
        if (relation.kind === "relation") {
            if (!relation.column) {
                throw new Error(`relation \`${table}.${field}\` has no foreign-key column`);
            }
            columns.push(`${TABLE_ALIAS}.${quote(relation.column)} as ${quote(foreignKeyAlias(field))}`);
            toOne.push({ field, relation, nested });
            continue;
        }
        if (!relation.column) {
            throw new Error(`children \`${table}.${field}\` has no foreign-key column`);
        }
        toMany.push({ field, relation, nested });
    }

    return { columns, scalars, inlined, toOne, toMany };
}

/** The select list: the projection's columns, the row key, and the matched column when it differs. */
function selectList(meta: QueryTable, projection: Projection, matchColumn: string | undefined): string {
    const columns = [...projection.columns, `${TABLE_ALIAS}.${quote(meta.key)} as ${quote(KEY_ALIAS)}`];
    if (matchColumn !== undefined) {
        columns.push(`${TABLE_ALIAS}.${quote(matchColumn)} as ${quote(MATCH_ALIAS)}`);
    }
    return columns.join(", ");
}

/** One argument's clause: a set, `column in (…)`. See docs/queries.md. */
function argumentClause(
    table: string,
    meta: QueryTable,
    name: string,
    value: unknown,
    params: unknown[],
): string {
    if (!Array.isArray(value)) {
        throw new Error(`filter \`${name}\` on \`${table}\` must be an array`);
    }
    const column = columnForArgument(meta, name);
    if (column === undefined) {
        throw new Error(`unknown filter field \`${name}\` on \`${table}\``);
    }
    const values = distinct(value);
    if (values.length === 0) {
        return "false";
    }
    return `${TABLE_ALIAS}.${quote(column)} in (${placeholders(params, values)})`;
}

/** Build the WHERE clause for a fetch, or undefined when the filter cannot match anything. */
function buildFilter(table: string, meta: QueryTable, filter: FetchFilter): FilterSql | undefined {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.kind === "match") {
        if (filter.values.length === 0) {
            return undefined;
        }
        clauses.push(`${TABLE_ALIAS}.${quote(filter.column)} in (${placeholders(params, filter.values)})`);
    } else {
        for (const [name, value] of Object.entries(filter.args)) {
            if (value === undefined) {
                continue;
            }
            clauses.push(argumentClause(table, meta, name, value, params));
        }
    }

    return { where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "", params };
}

/** Shape one raw row into its key, the value its filter matched, and the projected fields. */
function mapRow(projection: Projection, row: Record<string, unknown>, matchColumn: string | undefined): FetchedRow {
    const value: Record<string, unknown> = {};
    for (const field of projection.scalars) {
        value[field] = row[field];
    }
    for (const { field, targets } of projection.inlined) {
        const nested: Record<string, unknown> = {};
        for (const target of targets) {
            nested[target] = row[inlinedAlias(field, target)];
        }
        value[field] = nested;
    }
    return {
        key: row[KEY_ALIAS],
        match: matchColumn === undefined ? row[KEY_ALIAS] : row[MATCH_ALIAS],
        value,
    };
}

/** Attach each to-one branch: one batched query for every distinct foreign key. */
async function attachToOne(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    branches: Branch[],
    rows: Record<string, unknown>[],
    fetched: FetchedRow[],
): Promise<void> {
    for (const { field, relation, nested } of branches) {
        const targetName = relation.table ?? "";
        const target = model.tables[targetName];
        if (!target) {
            throw new Error(`relation \`${table}.${field}\` targets unknown table \`${targetName}\``);
        }
        const keys = distinct(rows.map((row) => row[foreignKeyAlias(field)]));
        const related = await fetchRows(model, db, targetName, normalizeSelection(target, nested), {
            kind: "match",
            column: target.key,
            values: keys,
        });
        const byKey = new Map(related.map((item) => [item.key, item.value]));
        fetched.forEach((item, index) => {
            const foreignKey = rows[index]?.[foreignKeyAlias(field)];
            item.value[field] = foreignKey === null || foreignKey === undefined ? undefined : byKey.get(foreignKey);
        });
    }
}

/** Attach each to-many branch: one batched query for every distinct parent key, grouped in memory. */
async function attachToMany(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    branches: Branch[],
    rows: Record<string, unknown>[],
    fetched: FetchedRow[],
): Promise<void> {
    for (const { field, relation, nested } of branches) {
        const targetName = relation.table ?? "";
        const target = model.tables[targetName];
        if (!target || !relation.column) {
            throw new Error(`children \`${table}.${field}\` targets unknown table \`${targetName}\``);
        }
        const keys = distinct(rows.map((row) => row[KEY_ALIAS]));
        const related = await fetchRows(model, db, targetName, normalizeSelection(target, nested), {
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
}

/** Read one table, then attach its branches. A branch recurses here with a `match` filter. */
async function fetchRows(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    selection: Record<string, unknown>,
    filter: FetchFilter,
): Promise<FetchedRow[]> {
    const meta = model.tables[table];
    if (!meta) {
        throw new Error(`no query metadata for table \`${table}\``);
    }

    const projection = planProjection(table, meta, selection);
    const matchColumn = filter.kind === "match" && filter.column !== meta.key ? filter.column : undefined;
    const built = buildFilter(table, meta, filter);
    if (built === undefined) {
        return [];
    }

    const sql = `select ${selectList(meta, projection, matchColumn)} from ${quote(meta.name)} as ${TABLE_ALIAS}${built.where}`;
    const rows = rowsOf(await db.query(sql, built.params));
    const fetched = rows.map((row) => mapRow(projection, row, matchColumn));

    await attachToOne(model, db, table, projection.toOne, rows, fetched);
    await attachToMany(model, db, table, projection.toMany, rows, fetched);
    return fetched;
}

/** Build a resolver bound to a table model. The generated functions call this once. */
export function createResolver(model: QueryModel): Resolver {
    async function resolveMany<E, S extends Selection<E>>(
        db: SqlExecutor,
        table: string,
        args: Record<string, unknown>,
        opts: ResolveOptions<E, S>,
    ): Promise<Selected<E, S>[]> {
        const rows = await fetchRows(model, db, table, opts.select as Record<string, unknown>, {
            kind: "args",
            args,
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
