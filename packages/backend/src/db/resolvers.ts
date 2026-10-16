/**
 * Generic read resolver over query metadata. See docs/queries.md.
 *
 * Written once by hand: it turns a `Selection` plus a table's generated metadata
 * into SQL. A branch costs one extra query, batched over every parent — there is
 * no JSON aggregation.
 */
import type { Direction, Selection, Selected } from "validation/selection.ts";
import { resultRows, type SqlExecutor } from "./sql-executor.ts";

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
    /** Filter fields a read must name, from `@queryFilter required`; absent when the entity marks none. See docs/queries.md. */
    requiredFilters?: string[];
    /** Orderable field names; absent when the entity marks none. See docs/queries.md. */
    order?: string[];
    /** The entity's default ordering, applied to a read that names none. See docs/queries.md. */
    defaultOrder?: { field: string; direction: Direction };
    /** Comparison fields mapped to their allowed operators; absent when the entity marks none. */
    where?: Record<string, string[]>;
}

/** Every table the resolver may read, keyed by physical table name. */
export interface QueryModel {
    tables: Record<string, QueryTable>;
}

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

/** A read's paging window, already defaulted and validated. A branch's `limit` bounds rows per parent. */
interface Page {
    limit?: number | undefined;
    offset: number;
}

/** Fill in a root read's paging defaults and reject a value that would reach the SQL unchecked. See docs/queries.md. */
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

/** A branch's paging window, already validated; absent when the branch names neither `limit` nor `offset`. */
function branchPage(limit: number | undefined, offset: number | undefined, path: string): Page | undefined {
    if (limit === undefined && offset === undefined) {
        return undefined;
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error(`limit on \`${path}\` must be a positive integer, found \`${String(limit)}\``);
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        throw new Error(`offset on \`${path}\` must be a non-negative integer, found \`${String(offset)}\``);
    }
    return { limit, offset: offset ?? 0 };
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
const RANK_ALIAS = "__rank";

/** Quote an identifier, matching the generated SQL. */
function quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** The alias a query gives its table. */
const TABLE_ALIAS = quote("t");

/** The alias a per-parent paging subquery is ranked and read under. */
const RANKED_ALIAS = quote("r");

/** The alias a to-one branch's foreign-key column is projected under. */
function foreignKeyAlias(field: string): string {
    return `__fk_${field}`;
}

/** The alias an inlined column is projected under. */
function inlinedAlias(field: string, target: string): string {
    return `__in_${field}_${target}`;
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
function allScalars(meta: QueryTable): Record<string, unknown> {
    const selection: Record<string, unknown> = {};
    for (const field of Object.keys(meta.fields)) {
        selection[field] = true;
    }
    return selection;
}

/** A branch's value: `true` for every scalar, or the read arguments it carries. See docs/queries.md. */
interface BranchRead {
    select: Record<string, unknown>;
    args: Record<string, unknown>;
    order?: OrderClause[] | undefined;
    where?: WhereClause | undefined;
    page?: Page | undefined;
}

/** Read a branch's value: `true`, or the same arguments a root read takes, applied to the branch. */
function branchRead(meta: QueryTable, value: unknown, path: string): BranchRead {
    if (value === true) {
        return { select: allScalars(meta), args: {} };
    }
    const args = (value ?? {}) as Record<string, unknown>;
    const select = args.select;
    if (select === null || typeof select !== "object") {
        throw new Error(`branch \`${path}\` needs a \`select\``);
    }
    return {
        select: select as Record<string, unknown>,
        args: (args.filter as Record<string, unknown> | undefined) ?? {},
        order: args.order as OrderClause[] | undefined,
        where: args.where as WhereClause | undefined,
        page: branchPage(args.limit as number | undefined, args.offset as number | undefined, path),
    };
}

/** The target fields an `@inlined` branch selects: every column for `true`, else the branch's `select`. */
function inlinedTargets(columns: Record<string, string>, value: unknown): string[] {
    if (value === true) {
        return Object.keys(columns);
    }
    return Object.keys((value as { select?: Record<string, unknown> }).select ?? {});
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
    /** The branch value as written: `true`, or the read arguments it carries. */
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

/** The output aliases a projection carries, so a per-parent paging subquery can project them back out. */
function outputAliases(projection: Projection, matchColumn: string | undefined): string[] {
    const aliases = [
        ...projection.scalars,
        ...projection.inlined.flatMap(({ field, targets }) =>
            targets.map((target) => inlinedAlias(field, target)),
        ),
        ...projection.toOne.map(({ field }) => foreignKeyAlias(field)),
        KEY_ALIAS,
    ];
    if (matchColumn !== undefined) {
        aliases.push(MATCH_ALIAS);
    }
    return aliases;
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
 * The comparison clauses for a read, one `column <op> $n` per named operator. A field and an
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

/** What a fetch reads: the projection, the filter arguments, and the paging/ordering of one read. */
interface FetchRead {
    select: Record<string, unknown>;
    /** The filter arguments: a root read's, or a branch's own. */
    args: Record<string, unknown>;
    /** A branch's link to its parents: the column and the parent values to match. */
    match?: { column: string; values: unknown[] } | undefined;
    order?: OrderClause[] | undefined;
    where?: WhereClause | undefined;
    page?: Page | undefined;
    /** True for a batched branch, whose page applies to each parent rather than to the whole result. */
    perParent?: boolean | undefined;
}

/** Build the WHERE clause for a fetch, or undefined when the filter cannot match anything. */
function buildFilter(table: string, meta: QueryTable, read: FetchRead): FilterSql | undefined {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (read.match) {
        if (read.match.values.length === 0) {
            return undefined;
        }
        clauses.push(`${TABLE_ALIAS}.${quote(read.match.column)} in (${placeholders(params, read.match.values)})`);
    }

    // A required filter is an invariant rather than a typing convention: a read that omits one
    // throws here instead of scanning the table unscoped. A branch names its own target's.
    for (const name of meta.requiredFilters ?? []) {
        if (read.args[name] === undefined) {
            throw new Error(`filter \`${name}\` is required on \`${table}\``);
        }
    }
    for (const [name, value] of Object.entries(read.args)) {
        if (value === undefined) {
            continue;
        }
        clauses.push(argumentClause(table, meta, name, value, params));
    }
    if (read.where) {
        clauses.push(...whereClauses(table, meta, read.where, params));
    }

    return { where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "", params };
}

/**
 * The rendered `order by` parts for a read. Only whitelisted fields may order, and a direction is
 * validated because it reaches the SQL. A read that names no ordering falls back to the entity
 * default. See docs/queries.md.
 */
function orderParts(table: string, meta: QueryTable, order: OrderClause[] | undefined): string[] {
    const clauses: OrderClause[] =
        order && order.length > 0
            ? order
            : meta.defaultOrder
                ? [[meta.defaultOrder.field, meta.defaultOrder.direction]]
                : [];
    const orderable = new Set(meta.order ?? []);
    return clauses.map(([field, direction]) => {
        const column = meta.fields[field];
        if (column === undefined || !orderable.has(field)) {
            throw new Error(`unknown order field \`${field}\` on \`${table}\``);
        }
        if (direction !== "asc" && direction !== "desc") {
            throw new Error(`order direction for \`${field}\` on \`${table}\` must be "asc" or "desc"`);
        }
        return `${TABLE_ALIAS}.${quote(column)} ${direction}`;
    });
}

/** A read's select list, its WHERE, its order, and its page, as one statement. */
function plainSql(
    meta: QueryTable,
    projection: Projection,
    matchColumn: string | undefined,
    where: string,
    order: string[],
    page: Page | undefined,
    params: unknown[],
): string {
    const orderSql = order.length > 0 ? ` order by ${order.join(", ")}` : "";
    let pageSql = "";
    if (page?.limit !== undefined) {
        params.push(page.limit);
        pageSql += ` limit $${params.length}`;
    }
    if (page && page.offset > 0) {
        params.push(page.offset);
        pageSql += ` offset $${params.length}`;
    }
    return `select ${selectList(meta, projection, matchColumn)} from ${quote(meta.name)} as ${TABLE_ALIAS}${where}${orderSql}${pageSql}`;
}

/**
 * A batched branch's statement when it pages. A branch's `limit`/`offset` bound the rows of each
 * parent, so the page cannot be a plain `limit`: `row_number()` ranks the branch rows per parent
 * and the outer query keeps the window of each. See docs/queries.md.
 */
function pagedBranchSql(
    meta: QueryTable,
    projection: Projection,
    matchColumn: string | undefined,
    where: string,
    order: string[],
    page: Page,
    params: unknown[],
): string {
    // The parent a branch row belongs to is the value its link matched: the child's foreign key,
    // or the target's key for a to-one relation, which the key alias carries when they are one.
    const partitionColumn = matchColumn ?? meta.key;
    const partitionAlias = matchColumn === undefined ? KEY_ALIAS : MATCH_ALIAS;
    const windowOrder =
        order.length > 0 ? order.join(", ") : `${TABLE_ALIAS}.${quote(partitionColumn)} asc`;
    const ranked = `${selectList(meta, projection, matchColumn)}, row_number() over (partition by ${TABLE_ALIAS}.${quote(partitionColumn)} order by ${windowOrder}) as ${quote(RANK_ALIAS)}`;
    const aliases = outputAliases(projection, matchColumn)
        .map((alias) => `${RANKED_ALIAS}.${quote(alias)}`)
        .join(", ");
    const conditions: string[] = [];
    params.push(page.offset);
    conditions.push(`${RANKED_ALIAS}.${quote(RANK_ALIAS)} > $${params.length}`);
    if (page.limit !== undefined) {
        params.push(page.offset + page.limit);
        conditions.push(`${RANKED_ALIAS}.${quote(RANK_ALIAS)} <= $${params.length}`);
    }
    return `select ${aliases} from (select ${ranked} from ${quote(meta.name)} as ${TABLE_ALIAS}${where}) as ${RANKED_ALIAS} where ${conditions.join(" and ")} order by ${RANKED_ALIAS}.${quote(partitionAlias)}, ${RANKED_ALIAS}.${quote(RANK_ALIAS)}`;
}

/** Copy a projected field unless it is `null`, matching the optional spec. See docs/queries.md. */
function copyField(target: Record<string, unknown>, field: string, value: unknown): void {
    if (value !== null && value !== undefined) {
        target[field] = value;
    }
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
        const read = branchRead(target, nested, `${table}.${field}`);
        const keys = distinct(rows.map((row) => row[foreignKeyAlias(field)]));
        const related = await fetchRows(model, db, targetName, {
            ...read,
            match: { column: target.key, values: keys },
            perParent: true,
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
        const read = branchRead(target, nested, `${table}.${field}`);
        const keys = distinct(rows.map((row) => row[KEY_ALIAS]));
        const related = await fetchRows(model, db, targetName, {
            ...read,
            match: { column: relation.column, values: keys },
            perParent: true,
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

/** Read one table, then attach its branches. A branch recurses here with a parent link and its own arguments. */
async function fetchRows(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    read: FetchRead,
): Promise<FetchedRow[]> {
    const meta = model.tables[table];
    if (!meta) {
        throw new Error(`no query metadata for table \`${table}\``);
    }

    const projection = planProjection(table, meta, read.select);
    const matchColumn = read.match !== undefined && read.match.column !== meta.key ? read.match.column : undefined;
    const built = buildFilter(table, meta, read);
    if (built === undefined) {
        return [];
    }

    const order = orderParts(table, meta, read.order);
    const params = [...built.params];
    // A branch's page bounds each parent, so it needs the ranked subquery; a root read pages plainly.
    const sql =
        read.perParent && read.page
            ? pagedBranchSql(meta, projection, matchColumn, built.where, order, read.page, params)
            : plainSql(meta, projection, matchColumn, built.where, order, read.perParent ? undefined : read.page, params);
    const rows = resultRows(await db.query(sql, params));
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
        const rows = await fetchRows(model, db, table, {
            select: opts.select as Record<string, unknown>,
            args,
            order: opts.order,
            where: opts.where,
            page: resolvePage(opts.limit, opts.offset),
        });
        return rows.map((row) => row.value) as unknown as Selected<E, S>[];
    }

    return { resolveMany };
}
