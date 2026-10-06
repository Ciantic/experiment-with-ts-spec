/** Write types: the insert a caller sends, where a nullable column also takes `null`. See docs/repositories.md. */

/** The insert over `E`: what a create writes, plus the defaulted fields it may omit and the nulls it may send. */
export type Insert<
    E,
    Omitted extends keyof E,
    Nullable extends keyof E,
    Relaxed extends keyof E,
> = Omit<E, Omitted | Nullable | Relaxed> &
    Partial<Pick<E, Relaxed>> &
    { [P in Nullable]?: E[P] | null };
