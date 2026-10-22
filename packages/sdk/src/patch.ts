/** Write types: the patch a caller sends, where `null` clears a nullable column and omitting a field keeps it. See docs/repositories.md. */

/** A patch over `E`: absent fields unwritten, key and version required, `null` clears a nullable field. See docs/optionality.md. */
export type Patch<
    E,
    Omitted extends keyof E,
    Locked extends keyof E,
    Nullable extends keyof E,
> = Omit<Partial<E>, Omitted | Nullable> & { [P in Nullable]?: E[P] | null } & Required<Pick<E, Locked>>;
