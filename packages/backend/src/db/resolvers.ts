/**
 * Generic read resolver over query metadata. See docs/queries.md.
 *
 * Written once by hand: it turns a `Selection` plus a table's generated metadata
 * into SQL. A branch costs one extra query, batched over every parent — there is
 * no JSON aggregation.
 */
import type { Direction, Selection, Selected } from "validation/selection.ts";
import type { SqlExecutor } from "./sql-executor.ts";

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
    /** Orderable field names; absent when the entity marks none. See docs/queries.md. */
    order?: string[];
    /** The entity's default ordering, applied to a root read that names none. See docs/queries.md. */
    defaultOrder?: { field: string; direction: Direction };
    /** Comparison fields mapped to their allowed operators; absent when the entity marks none. */
    where?: Record<string, string[]>;
}

/** Every table the resolver may read, keyed by physical table name. */
export interface QueryModel {
    tables: Record<string, QueryTable>;
}

/** What a fetch selects and filters on: root arguments, or a column matched against parent keys. */
type FetchFilter =
    | { kind: "args"; args: Record<string, unknown> }
    | { kind: "match"; column: string; values: unknown[] };

/** One ordering clause, as a read passes it: `[field, direction]`. See docs/queries.md. */
export type OrderClause = [field: string, direction: Direction];

/** One field's comparisons, as a read passes them: `{ gte: …, lte: … }`. See docs/queries.md. */
export type WhereClause = Record<string, Record<string, unknown>>;

/** The SQL operator each comparison maps to. */
const COMPARISON_SQL: Record<string, string> = {
    eq: "=",
    ne: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
};

/** What a read selects and filters on, as the generated function passes it. */
export interface ResolveOptions<E, S extends Selection<E>> {
    select: S;
    /** `| undefined` so a generated call may forward an absent ordering under exactOptionalPropertyTypes. */
    order?: OrderClause[] | undefined;
    /** The most rows a root read returns; absent means {@link DEFAULT_LIMIT}. See docs/queries.md. */
    limit?: number | undefined;
    /** The number of leading rows a root read skips; absent means 0. See docs/queries.md. */
    offset?: number | undefined;
    /** Comparison arguments; each field is restricted to its `@queryWhere` operators. See docs/queries.md. */
    where?: WhereClause | undefined;
}

/** The rows a root read returns when it names no `limit`. See docs/queries.md. */
export const DEFAULT_LIMIT = 1000;

/** A root read's paging window, already defaulted and validated. */
interface Page {
    limit: number;
    offset: number;
}

/** Fill in the paging defaults and reject a value that would reach the SQL unchecked. See docs/queries.md. */
function resolvePage(limit: number | undefined, offset: number | undefined): Page {
    const resolvedLimit = limit ?? DEFAULT_LIMIT;
    const resolvedOffset = offset ?? 0;
    if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1) {
        throw new Error(`limit must be a positive integer, found \`${String(limit)}\``);
    }
    if (!Number.isInteger(resolvedOffset) || resolvedOffset < 0) {
        throw new Error(`offset must be a non-negative integer, found \`${String(offset)}\``);
    }
    return { limit: resolvedLimit, offset: resolvedOffset };
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

/**
 * The comparison clauses for a root read, one `column <op> $n` per named operator. A field and an
 * operator are both checked against the generated whitelist, because the operator reaches the SQL
 * and the value is parameterized. Several operators on one field AND together, so `gte` + `lte` is
 * a range. See docs/queries.md.
 */
function whereClauses(table: string, meta: QueryTable, where: WhereClause, params: unknown[]): string[] {
    const clauses: string[] = [];
    for (const [field, condition] of Object.entries(where)) {
        if (condition === undefined) {
            continue;
        }
        const column = columnForArgument(meta, field);
        if (column === undefined) {
            throw new Error(`unknown where field \`${field}\` on \`${table}\``);
        }
        const allowed = meta.where?.[field] ?? [];
        const parts: string[] = [];
        for (const [operator, value] of Object.entries(condition)) {
            if (value === undefined) {
                continue;
            }
            const sqlOperator = COMPARISON_SQL[operator];
            if (sqlOperator === undefined || !allowed.includes(operator)) {
                throw new Error(`where operator \`${operator}\` is not allowed on \`${field}\` of \`${table}\``);
            }
            params.push(value);
            parts.push(`${TABLE_ALIAS}.${quote(column)} ${sqlOperator} $${params.length}`);
        }
        if (parts.length > 0) {
            clauses.push(`(${parts.join(" and ")})`);
        }
    }
    return clauses;
}

/** Build the WHERE clause for a fetch, or undefined when the filter cannot match anything. */
function buildFilter(
    table: string,
    meta: QueryTable,
    filter: FetchFilter,
    where?: WhereClause,
): FilterSql | undefined {
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
        // Comparisons are a root concern, like `order` and paging; a branch fetch never carries them.
        if (where) {
            clauses.push(...whereClauses(table, meta, where, params));
        }
    }

    return { where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "", params };
}

/** Copy a projected field unless it is `null`, matching the optional spec. See docs/queries.md. */
function copyField(target: Record<string, unknown>, field: string, value: unknown): void {
    if (value !== null && value !== undefined) {
        target[field] = value;
    }
}

/**
 * The `order by` clause for a root read, or "" when nothing orders. Only whitelisted fields may
 * order, and a direction is validated because it reaches the SQL. A read that names no ordering
 * falls back to the entity default. See docs/queries.md.
 */
function buildOrder(table: string, meta: QueryTable, order: OrderClause[] | undefined): string {
    // Normalise the entity default to the same tuple shape, so the loop has one case.
    const clauses: OrderClause[] =
        order && order.length > 0
            ? order
            : meta.defaultOrder
                ? [[meta.defaultOrder.field, meta.defaultOrder.direction]]
                : [];
    if (clauses.length === 0) {
        return "";
    }
    const orderable = new Set(meta.order ?? []);
    const parts = clauses.map(([field, direction]) => {
        const column = meta.fields[field];
        if (column === undefined || !orderable.has(field)) {
            throw new Error(`unknown order field \`${field}\` on \`${table}\``);
        }
        // A tuple decodes to unchecked values, so the direction is re-checked before it reaches SQL.
        if (direction !== "asc" && direction !== "desc") {
            throw new Error(`order direction for \`${field}\` on \`${table}\` must be "asc" or "desc"`);
        }
        return `${TABLE_ALIAS}.${quote(column)} ${direction}`;
    });
    return ` order by ${parts.join(", ")}`;
}

/** Shape one raw row into its key, the value its filter matched, and the projected fields. */
function mapRow(projection: Projection, row: Record<string, unknown>, matchColumn: string | undefined): FetchedRow {
    const value: Record<string, unknown> = {};
    for (const field of projection.scalars) {
        copyField(value, field, row[field]);
    }
    for (const { field, targets } of projection.inlined) {
        const nested: Record<string, unknown> = {};
        for (const target of targets) {
            copyField(nested, target, row[inlinedAlias(field, target)]);
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
            copyField(item.value, field, byKey.get(foreignKey));
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
    order?: OrderClause[],
    page?: Page,
    where?: WhereClause,
): Promise<FetchedRow[]> {
    const meta = model.tables[table];
    if (!meta) {
        throw new Error(`no query metadata for table \`${table}\``);
    }

    const projection = planProjection(table, meta, selection);
    const matchColumn = filter.kind === "match" && filter.column !== meta.key ? filter.column : undefined;
    const built = buildFilter(table, meta, filter, where);
    if (built === undefined) {
        return [];
    }

    // Only a root read orders and pages; a batched branch keeps its own order and is never cut.
    const root = filter.kind === "args";
    const orderSql = root ? buildOrder(table, meta, order) : "";
    const params = [...built.params];
    let pageSql = "";
    if (root && page) {
        params.push(page.limit);
        pageSql += ` limit $${params.length}`;
        if (page.offset > 0) {
            params.push(page.offset);
            pageSql += ` offset $${params.length}`;
        }
    }

    const sql = `select ${selectList(meta, projection, matchColumn)} from ${quote(meta.name)} as ${TABLE_ALIAS}${built.where}${orderSql}${pageSql}`;
    const rows = rowsOf(await db.query(sql, params));
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
        const rows = await fetchRows(
            model,
            db,
            table,
            opts.select as Record<string, unknown>,
            { kind: "args", args },
            opts.order,
            resolvePage(opts.limit, opts.offset),
            opts.where,
        );
        return rows.map((row) => row.value) as unknown as Selected<E, S>[];
    }

    return { resolveMany };
}
