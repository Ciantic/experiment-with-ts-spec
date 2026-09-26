/** A monotonic record revision, used as an optimistic-lock precondition. See docs/versioning.md. */
export type Version = bigint & { readonly __brand: "Version" };
