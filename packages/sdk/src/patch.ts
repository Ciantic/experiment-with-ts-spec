/** Write types: the patch a caller sends, where `null` clears a nullable column and omitting a field keeps it. See docs/repositories.md. */

/**
 * The patch over `E`: the fields a patch does not write are absent, the key and version it must
 * carry are required, and a field with a nullable column also accepts `null`, which clears it.
 *
 * `null` and an omitted field are different requests, so the type has to keep them apart: omitting
 * a field leaves the stored value alone, while `null` writes a null. See `docs/optionality.md`.
 */
export type Patch<
    E,
    Omitted extends keyof E,
    Locked extends keyof E,
    Nullable extends keyof E,
> = Omit<Partial<E>, Omitted | Nullable> & { [P in Nullable]?: E[P] | null } & Required<Pick<E, Locked>>;
