/** Read types: the column-limiting selection, the filter arguments, and the ordering clauses. See docs/queries.md. */
import type { Brand } from "spec/primitives/Brand.ts";

/** A leaf column: a keyword, a branded primitive, a `Date`, or a union of those. */
type Scalar<T> = NonNullable<T> extends string | number | boolean | bigint | Date | Brand<any>
    ? true
    : false;

/** The element of a child collection, or the entity itself when it is not an array. */
type ElementOf<T> = NonNullable<T> extends readonly (infer U)[] ? NonNullable<U> : NonNullable<T>;

/** Whether `T` is a child collection. */
type IsArray<T> = NonNullable<T> extends readonly unknown[] ? true : false;

/** A sort direction. See docs/queries.md. */
export type Direction = "asc" | "desc";

/** One ordering clause of a read: `[field, direction]` over a whitelisted field. See docs/queries.md. */
export type Order<K extends PropertyKey> = [field: K, direction: Direction];

/** The comparison operators a `@queryWhere` field may name. See docs/queries.md. */
export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** Comparison arguments of a read: each field whitelisted to the operators `@queryWhere` declared, one value each. See docs/queries.md. */
export type Where<E, O extends Partial<Record<keyof E, PropertyKey>>> = {
    [K in keyof O & keyof E]?: { [P in Extract<NonNullable<O[K]>, PropertyKey>]?: NonNullable<E[K]> };
};

/** The filter arguments of a read: each named field, as a set matched with `in (…)`. `R` names the filters a read must carry. See docs/queries.md. */
export type Filters<E, K extends keyof E, R extends K = never> = { [P in R]: NonNullable<E[P]>[] } & Partial<{
    [P in Exclude<K, R>]: NonNullable<E[P]>[];
}>;

/** The scalar field names of `E`: the fields a branch's `filter`, `order`, or `where` may name. See docs/queries.md. */
export type ScalarKeys<E> = {
    [K in keyof E]-?: Scalar<E[K]> extends true ? K : never;
}[keyof E];

/** Which rows of a soft-deletable entity a read returns: the live ones (the default), both, or the trashed ones. See docs/soft-delete.md. */
export type Trashed = "exclude" | "include" | "only";

/** The arguments of a read over `E`, as a branch carries them: the same shape a root read takes. See docs/queries.md. */
export type QueryArgs<E> = {
    select: Selection<E>;
    filter?: { [K in ScalarKeys<E>]?: readonly NonNullable<E[K]>[] };
    order?: readonly (readonly [field: ScalarKeys<E>, direction: Direction])[];
    where?: { [K in ScalarKeys<E>]?: { [P in CompareOp]?: NonNullable<E[K]> } };
    trashed?: Trashed;
    limit?: number;
    offset?: number;
};

/** The fields a caller wants: `true` for a scalar, `true` or a read's arguments for a branch. See docs/queries.md. */
export type Selection<E> = {
    [K in keyof E]?: Scalar<E[K]> extends true ? true : true | QueryArgs<ElementOf<E[K]>>;
};

/** The nested `select` a branch value carries, whether it was written as `true` or as read arguments. See docs/queries.md. */
type BranchSelect<B> = B extends { select: infer S } ? NonNullable<S> : never;

/** The result of `E` under selection `S`: only the selected keys, each optional. See docs/queries.md. */
export type Selected<E, S> = {
    [K in keyof S & keyof E]?: NonNullable<S[K]> extends true
        ? E[K]
        : IsArray<E[K]> extends true
            ? Selected<ElementOf<E[K]>, BranchSelect<S[K]>>[]
            : Selected<ElementOf<E[K]>, BranchSelect<S[K]>>;
};
