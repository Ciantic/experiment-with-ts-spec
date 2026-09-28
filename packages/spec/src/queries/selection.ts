import type { $brand } from "zod";

/** A leaf column: a keyword, a branded primitive, a `Date`, or a union of those. */
type Scalar<T> = NonNullable<T> extends string | number | boolean | bigint | Date | $brand<any>
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
