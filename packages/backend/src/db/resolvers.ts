/** Generic read resolver: turns a `Selection` and a table's generated metadata into SQL. See docs/queries.md. */
import type { Direction, FilterDefault, Selection, Selected } from "validation/selection.ts";
import { QueryError } from "validation/errors.ts";
import { resultRows, type SqlExecutor } from "./sql-executor.ts";

/** A branch that reads another table: `relation` is to-one, `children` is to-many. */
export interface TableRelation {
    kind: "relation" | "children";
    /** The target table. */
    table: string;
    /** `relation`: this table's foreign-key column. `children`: the child's foreign-key column. */
    column: string;
}

/** A branch whose fields are columns of this table's own row. */
export interface InlinedRelation {
    kind: "inlined";
    /** Target field -> this table's prefixed column. */
    columns: Record<string, string>;
}

/** How a branch field of a table reaches another table, or flattens into its own row. */
export type QueryRelation = TableRelation | InlinedRelation;

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
    /** The comparison fields mapped to their allowed operators; absent when the entity marks none. */
    where?: Record<string, string[]>;
    /** Filter values matched when a read omits them, from `@queryFilter default=<value>`. See docs/queries.md. */
    filterDefaults?: Record<string, FilterDefault>;
}

/** The value a filter matches when a read omits it, from `@queryFilter default=<value>`. See docs/queries.md. */
export type { FilterDefault } from "validation/selection.ts";

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

/**
 * Fill in a root read's paging defaults and reject a value that would reach the SQL unchecked.
 * @throws {QueryError} when the limit is not a positive integer or the offset is not a non-negative one
 */
function resolvePage(limit: number | undefined, offset: number | undefined): Page {
    const resolvedLimit = limit ?? DEFAULT_LIMIT;
    const resolvedOffset = offset ?? 0;
    if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1) {
        throw new QueryError(`limit must be a positive integer, found \`${String(limit)}\``);
    }
    if (!Number.isInteger(resolvedOffset) || resolvedOffset < 0) {
        throw new QueryError(`offset must be a non-negative integer, found \`${String(offset)}\``);
    }
    return { limit: resolvedLimit, offset: resolvedOffset };
}

/**
 * A branch's paging window, already validated; absent when the branch names neither `limit` nor `offset`.
 * @throws {QueryError} when the branch's limit or offset is not the integer the SQL can take
 */
function branchPage(limit: number | undefined, offset: number | undefined, path: string): Page | undefined {
    if (limit === undefined && offset === undefined) {
        return undefined;
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new QueryError(`limit on \`${path}\` must be a positive integer, found \`${String(limit)}\``);
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        throw new QueryError(`offset on \`${path}\` must be a non-negative integer, found \`${String(offset)}\``);
    }
    return { limit, offset: offset ?? 0 };
}

/** A nested fetch's row: its key, the value its filter matched, the raw row, and the shaped result. */
interface FetchedRow {
    key: unknown;
    match: unknown;
    row: Record<string, unknown>;
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

/** The values, with nulls and duplicates dropped, as the members of a set. */
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

/**
 * Read a branch's value: `true`, or the same arguments a root read takes, applied to the branch.
 * @throws {QueryError} when the branch names no select
 */
function branchRead(meta: QueryTable, value: unknown, path: string): BranchRead {
    if (value === true) {
        return { select: allScalars(meta), args: {} };
    }
    const args = (value ?? {}) as Record<string, unknown>;
    const select = args.select;
    if (select === null || typeof select !== "object") {
        throw new QueryError(`branch \`${path}\` needs a \`select\``);
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

/** The clauses of one statement and the positional parameters they bind. */
interface Clauses {
    /** The clause including a leading ` where `, or "" when nothing filters. */
    where: string;
    /** The rendered `order by` parts. */
    order: string[];
    params: unknown[];
}

/** A branch to load with one batched query. */
interface Branch {
    field: string;
    relation: TableRelation;
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

/** What a statement and its row mapping share: the table, its projection, and how rows link to a parent. */
interface ReadPlan {
    meta: QueryTable;
    projection: Projection;
    /** The column linking a branch row to its parent; undefined when the link is the row's own key, or for a root read. */
    matchColumn: string | undefined;
}

/** A set clause binding the values as one array parameter, so the statement's parameter count does not grow with the set; Postgres infers the array type from the column. */
function inSet(column: string, values: unknown[], params: unknown[]): string {
    params.push(values);
    return `${TABLE_ALIAS}.${quote(column)} = any($${params.length})`;
}

/**
 * Split a selection into the select list, the scalars, the inlined columns, and the branches.
 * @throws {QueryError} when the selection names a field the table does not have, or an inlined field no column
 */
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
                throw new QueryError(`unknown field \`${field}\` on \`${table}\``);
            }
            columns.push(`${TABLE_ALIAS}.${quote(column)} as ${quote(field)}`);
            scalars.push(field);
            continue;
        }
        if (relation.kind === "inlined") {
            const targets: string[] = [];
            for (const target of inlinedTargets(relation.columns, nested)) {
                const column = relation.columns[target];
                if (column === undefined) {
                    throw new QueryError(`inlined \`${table}.${field}\` has no column for \`${target}\``);
                }
                columns.push(`${TABLE_ALIAS}.${quote(column)} as ${quote(inlinedAlias(field, target))}`);
                targets.push(target);
            }
            inlined.push({ field, targets });
            continue;
        }
        if (relation.kind === "relation") {
            columns.push(`${TABLE_ALIAS}.${quote(relation.column)} as ${quote(foreignKeyAlias(field))}`);
            toOne.push({ field, relation, nested });
            continue;
        }
        toMany.push({ field, relation, nested });
    }

    return { columns, scalars, inlined, toOne, toMany };
}

/** Plan one read of a table: its projection and the column that links its rows to a parent. */
function planRead(table: string, meta: QueryTable, read: FetchRead): ReadPlan {
    const projection = planProjection(table, meta, read.select);
    const matchColumn = read.match !== undefined && read.match.column !== meta.key ? read.match.column : undefined;
    return { meta, projection, matchColumn };
}

/** The select list: the projection's columns, the row key, and the matched column when it differs. */
function selectList({ meta, projection, matchColumn }: ReadPlan): string {
    const columns = [...projection.columns, `${TABLE_ALIAS}.${quote(meta.key)} as ${quote(KEY_ALIAS)}`];
    if (matchColumn !== undefined) {
        columns.push(`${TABLE_ALIAS}.${quote(matchColumn)} as ${quote(MATCH_ALIAS)}`);
    }
    return columns.join(", ");
}

/** The output aliases a projection carries, so a per-parent paging subquery can project them back out. */
function outputAliases({ projection, matchColumn }: ReadPlan): string[] {
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

/** The comparison operators that test for null; each takes `true` and binds no parameter. See docs/queries.md. */
const NULL_COMPARISON_SQL: Record<string, string> = {
    isNull: "is null",
    isNotNull: "is not null",
};

/** A filter's null test, when the value is one; undefined for a set or a malformed value. See docs/queries.md. */
function nullFilterTest(value: unknown): "is null" | "is not null" | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    if (entries.length !== 1) {
        return undefined;
    }
    const [name, test] = entries[0] as [string, unknown];
    if (test !== true) {
        return undefined;
    }
    if (name === "isNull") {
        return "is null";
    }
    if (name === "isNotNull") {
        return "is not null";
    }
    return undefined;
}

/**
 * One argument's clause: a set (`column = any($n)`), or a null test. See docs/queries.md.
 * @throws {QueryError} when the filter names no column, or its value is neither an array nor a null test
 */
function argumentClause(
    table: string,
    meta: QueryTable,
    name: string,
    value: unknown,
    params: unknown[],
): string {
    const column = meta.fields[name];
    if (column === undefined) {
        throw new QueryError(`unknown filter field \`${name}\` on \`${table}\``);
    }
    const nullTest = nullFilterTest(value);
    if (nullTest !== undefined) {
        return `${TABLE_ALIAS}.${quote(column)} ${nullTest}`;
    }
    if (!Array.isArray(value)) {
        throw new QueryError(`filter \`${name}\` on \`${table}\` must be an array or a null test`);
    }
    const values = distinct(value);
    if (values.length === 0) {
        return "false";
    }
    return inSet(column, values, params);
}

/**
 * One omitted filter's default clause: a null test, or a value compared with the column. See docs/queries.md.
 * @throws {QueryError} when the default names a filter field the table does not have
 */
function defaultClause(
    table: string,
    meta: QueryTable,
    name: string,
    value: FilterDefault,
    params: unknown[],
): string {
    const column = meta.fields[name];
    if (column === undefined) {
        throw new QueryError(`unknown filter field \`${name}\` on \`${table}\``);
    }
    if (value.kind === "isNull") {
        return `${TABLE_ALIAS}.${quote(column)} is null`;
    }
    if (value.kind === "isNotNull") {
        return `${TABLE_ALIAS}.${quote(column)} is not null`;
    }
    params.push(value.value);
    return `${TABLE_ALIAS}.${quote(column)} = $${params.length}`;
}

/**
 * The comparison clauses for a read, one `column <op> $n` per whitelisted operator; a null test binds nothing.
 * @throws {QueryError} when the where names no column, or an operator the field does not allow or a null test that is not `true`
 */
function whereClauses(table: string, meta: QueryTable, where: WhereClause, params: unknown[]): string[] {
    const clauses: string[] = [];
    for (const [field, condition] of Object.entries(where)) {
        if (condition === undefined) {
            continue;
        }
        const column = meta.fields[field];
        if (column === undefined) {
            throw new QueryError(`unknown where field \`${field}\` on \`${table}\``);
        }
        const allowed = meta.where?.[field] ?? [];
        const parts: string[] = [];
        for (const [operator, value] of Object.entries(condition)) {
            if (value === undefined) {
                continue;
            }
            const nullOperator = NULL_COMPARISON_SQL[operator];
            if (nullOperator !== undefined) {
                if (!allowed.includes(operator)) {
                    throw new QueryError(`where operator \`${operator}\` is not allowed on \`${field}\` of \`${table}\``);
                }
                if (value !== true) {
                    throw new QueryError(`where operator \`${operator}\` on \`${field}\` of \`${table}\` takes \`true\``);
                }
                parts.push(`${TABLE_ALIAS}.${quote(column)} ${nullOperator}`);
                continue;
            }
            const sqlOperator = COMPARISON_SQL[operator];
            if (sqlOperator === undefined || !allowed.includes(operator)) {
                throw new QueryError(`where operator \`${operator}\` is not allowed on \`${field}\` of \`${table}\``);
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
}

/**
 * Build the clauses for a fetch, or undefined when the filter cannot match anything.
 * @throws {QueryError} when the read names a filter field the table does not have, or omits one its queryFilter requires
 */
function buildClauses(table: string, meta: QueryTable, read: FetchRead): Clauses | undefined {
    const filters: string[] = [];
    const params: unknown[] = [];

    if (read.match) {
        if (read.match.values.length === 0) {
            return undefined;
        }
        filters.push(inSet(read.match.column, read.match.values, params));
    }

    // A required filter is an invariant: a read that omits one throws instead of scanning unscoped.
    for (const name of meta.requiredFilters ?? []) {
        if (read.args[name] === undefined) {
            throw new QueryError(`filter \`${name}\` is required on \`${table}\``);
        }
    }
    for (const [name, value] of Object.entries(read.args)) {
        if (value === undefined) {
            continue;
        }
        filters.push(argumentClause(table, meta, name, value, params));
    }
    // A filter a read leaves out falls back to its default; a comparison on the field overrides it.
    for (const [name, value] of Object.entries(meta.filterDefaults ?? {})) {
        if (read.args[name] !== undefined || read.where?.[name] !== undefined) {
            continue;
        }
        filters.push(defaultClause(table, meta, name, value, params));
    }
    if (read.where) {
        filters.push(...whereClauses(table, meta, read.where, params));
    }

    return {
        where: filters.length > 0 ? ` where ${filters.join(" and ")}` : "",
        order: orderParts(table, meta, read.order),
        params,
    };
}

/**
 * The rendered `order by` parts for a read, falling back to the entity default. See docs/queries.md.
 * @throws {QueryError} when the order names no column, or a direction other than `asc` or `desc`
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
            throw new QueryError(`unknown order field \`${field}\` on \`${table}\``);
        }
        if (direction !== "asc" && direction !== "desc") {
            throw new QueryError(`order direction for \`${field}\` on \`${table}\` must be "asc" or "desc"`);
        }
        return `${TABLE_ALIAS}.${quote(column)} ${direction}`;
    });
}

/** A read's select list, its WHERE, its order, and its page, as one statement. */
function plainSql(plan: ReadPlan, clauses: Clauses, page: Page | undefined): string {
    const { where, order, params } = clauses;
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
    return `select ${selectList(plan)} from ${quote(plan.meta.name)} as ${TABLE_ALIAS}${where}${orderSql}${pageSql}`;
}

/** A batched branch's statement when it pages: `row_number()` ranks rows per parent, so the window is per parent. See docs/queries.md. */
function pagedBranchSql(plan: ReadPlan, clauses: Clauses, page: Page): string {
    const { meta, matchColumn } = plan;
    const { where, order, params } = clauses;
    // The parent of a branch row is the value its link matched; with no match column the key alias carries it.
    const partitionColumn = matchColumn ?? meta.key;
    const partitionAlias = matchColumn === undefined ? KEY_ALIAS : MATCH_ALIAS;
    const windowOrder =
        order.length > 0 ? order.join(", ") : `${TABLE_ALIAS}.${quote(partitionColumn)} asc`;
    const ranked = `${selectList(plan)}, row_number() over (partition by ${TABLE_ALIAS}.${quote(partitionColumn)} order by ${windowOrder}) as ${quote(RANK_ALIAS)}`;
    const aliases = outputAliases(plan)
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
function mapRow({ projection, matchColumn }: ReadPlan, row: Record<string, unknown>): FetchedRow {
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
        row,
        value,
    };
}

/**
 * One batched query for a branch, over every distinct parent key.
 * @throws {QueryError} when the branch targets a table the query model does not have
 */
async function fetchBranch(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    { field, relation, nested }: Branch,
    parents: FetchedRow[],
): Promise<FetchedRow[]> {
    const target = model.tables[relation.table];
    if (!target) {
        throw new QueryError(`\`${table}.${field}\` targets unknown table \`${relation.table}\``);
    }
    const read = branchRead(target, nested, `${table}.${field}`);
    const toOne = relation.kind === "relation";
    const keys = distinct(parents.map((parent) => (toOne ? parent.row[foreignKeyAlias(field)] : parent.key)));
    const column = toOne ? target.key : relation.column;
    return fetchRows(model, db, relation.table, { ...read, match: { column, values: keys } });
}

/** Attach each to-one branch, by the foreign key each parent carries. */
async function attachToOne(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    branches: Branch[],
    fetched: FetchedRow[],
): Promise<void> {
    for (const branch of branches) {
        const related = await fetchBranch(model, db, table, branch, fetched);
        const byKey = new Map(related.map((item) => [item.key, item.value]));
        for (const parent of fetched) {
            copyField(parent.value, branch.field, byKey.get(parent.row[foreignKeyAlias(branch.field)]));
        }
    }
}

/** Attach each to-many branch, grouped in memory by the parent key each row matched. */
async function attachToMany(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    branches: Branch[],
    fetched: FetchedRow[],
): Promise<void> {
    for (const branch of branches) {
        const related = await fetchBranch(model, db, table, branch, fetched);
        const groups = new Map<unknown, Record<string, unknown>[]>();
        for (const item of related) {
            const group = groups.get(item.match);
            if (group) {
                group.push(item.value);
            } else {
                groups.set(item.match, [item.value]);
            }
        }
        for (const parent of fetched) {
            parent.value[branch.field] = groups.get(parent.key) ?? [];
        }
    }
}

/**
 * Read one table, then attach its branches. A branch recurses here with a parent link and its own arguments.
 * @throws {QueryError} when the table is not in the query model, or the read names a field, filter, order, or page the model refuses
 */
async function fetchRows(
    model: QueryModel,
    db: SqlExecutor,
    table: string,
    read: FetchRead,
): Promise<FetchedRow[]> {
    const meta = model.tables[table];
    if (!meta) {
        throw new QueryError(`no query metadata for table \`${table}\``);
    }

    const plan = planRead(table, meta, read);
    const clauses = buildClauses(table, meta, read);
    if (clauses === undefined) {
        return [];
    }

    // A branch's page bounds each parent, so it needs the ranked subquery; a root read pages plainly.
    const sql =
        read.match && read.page
            ? pagedBranchSql(plan, clauses, read.page)
            : plainSql(plan, clauses, read.page);
    const fetched = resultRows(await db.query(sql, clauses.params)).map((row) => mapRow(plan, row));

    await attachToOne(model, db, table, plan.projection.toOne, fetched);
    await attachToMany(model, db, table, plan.projection.toMany, fetched);
    return fetched;
}

/**
 * Build a resolver bound to a table model. The generated functions call this once.
 * @throws {QueryError} when a read names a field, filter, order, or page the model refuses
 */
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
