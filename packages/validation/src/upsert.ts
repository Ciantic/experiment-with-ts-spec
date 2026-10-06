/** Write types: the upsert a caller sends, which writes a row whole and claims its version. See docs/repositories.md. */

/** The upsert over `E`: what a create writes, plus the version it claims and the nulls it may send. */
export type Upsert<
    E,
    Omitted extends keyof E,
    Locked extends keyof E,
    Nullable extends keyof E,
    Relaxed extends keyof E,
> = Omit<E, Omitted | Locked | Nullable | Relaxed> &
    Partial<Pick<E, Relaxed>> &
    { [P in Nullable]?: E[P] | null } &
    Required<Pick<E, Locked>>;
