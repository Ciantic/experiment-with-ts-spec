/**
 * Read types: the column-limiting selection and the filter arguments.
 * Hand-written, not generated. See docs/queries.md.
 *
 * These live in the spec because the generated REST client must agree with the
 * server on the shape of a read, and the client may import nothing from the
 * backend. See docs/rest-api.md.
 */
import type { Brand } from "./primitives/Brand.ts";

/** A leaf column: a keyword, a branded primitive, a `Date`, or a union of those. */
type Scalar<T> = NonNullable<T> extends string | number | boolean | bigint | Date | Brand<any>
    ? true
    : false;

/** The element of a child collection, or the entity itself when it is not an array. */
type ElementOf<T> = NonNullable<T> extends readonly (infer U)[] ? NonNullable<U> : NonNullable<T>;

/** Whether `T` is a child collection. */
type IsArray<T> = NonNullable<T> extends readonly unknown[] ? true : false;

/** The fields a caller wants: `true` for a scalar, a nested `Selection` for a branch. See docs/queries.md. */
export type Selection<E> = {
    [K in keyof E]?: Scalar<E[K]> extends true ? true : true | Selection<ElementOf<E[K]>>;
};

/** The result of `E` under selection `S`: only the selected keys, each optional. See docs/queries.md. */
export type Selected<E, S> = {
    [K in keyof S & keyof E]?: NonNullable<S[K]> extends true
        ? E[K]
        : IsArray<E[K]> extends true
            ? Selected<ElementOf<E[K]>, NonNullable<S[K]>>[]
            : Selected<ElementOf<E[K]>, NonNullable<S[K]>>;
};

/** The filter arguments of a read: each named field, as a set matched with `in (…)`. See docs/queries.md. */
export type Filters<E, K extends keyof E> = Partial<{ [P in K]: NonNullable<E[P]>[] }>;

/** The filter arguments of a `get`: at least one field named, the rest optional. See docs/queries.md. */
export type AtLeastOne<T> = {
    [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>>;
}[keyof T];
