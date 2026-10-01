# Queries (Effect v4)

`packages/backend-effect/scripts/generate-queries.ts` turns the spec entities into
the per-entity `list`/`get` reads and the query metadata module, and
`packages/backend-effect/src/db/resolvers.ts` is the hand-written resolver they
run on. This is the Effect v4 counterpart of
`packages/backend/scripts/generate-queries.ts` and
`packages/backend/src/db/resolvers.ts` (`docs/queries.md`) and runs alongside
them, from the same `Table` model. The read *semantics* — selection, filters,
branch batching — are identical; only the effectful plumbing changes.

## Output

- `src/db/queries/model.ts` — the `QueryModel` the resolver is constructed with.
- `src/db/queries/<entity>Queries.ts` — one module per entity, exporting
  `list<Entity>` and (when it has filters) `get<Entity>`.
- `src/db/queries/index.ts` — the barrel.
- `src/db/selection.ts` — re-exports `selection.ts` from `packages/spec`.

```typescript
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Invoice } from "spec/domain/Invoice.ts";
import type { AtLeastOne, Filters, Selection, Selected } from "../selection.ts";
import { createResolver } from "../resolvers.ts";
import { queryModel } from "./model.ts";

const resolver = createResolver(queryModel);

/** List `Invoice` rows, filtered by the `@queryfilter` fields, combined with and. */
export function listInvoice<S extends Selection<Invoice>>(
    opts: Filters<Invoice, "id" | "customerId" | "sellerId"> & { select: S },
): Effect.Effect<Selected<Invoice, S>[], SqlError, SqlClient> {
    const { select, ...args } = opts;
    return resolver.resolveMany<Invoice, S>("invoice", args, { select });
}
```

## What changed from the Zod backend

The generated function lost its `db: SqlExecutor` argument and its `Promise`
return type:

```typescript
// backend
export function listInvoice<S …>(db: SqlExecutor, opts: …): Promise<Selected<Invoice, S>[]>
// backend-effect
export function listInvoice<S …>(opts: …): Effect.Effect<Selected<Invoice, S>[], SqlError, SqlClient>
```

Everything else about the call site — the filter sets and the `select` — is the
same, so the two are drop-in for each other up to the executor.

## The resolver

`createResolver(model)` returns a `Resolver` whose two methods return `Effect`s
that require `SqlClient`:

```typescript
resolveMany<E, S>(table, args, opts): Effect.Effect<Selected<E, S>[], SqlError, SqlClient>
resolveOne<E, S>(table, args, opts): Effect.Effect<Selected<E, S> | undefined, SqlError, SqlClient>
```

The SQL construction (projection planning, `in (…)` filters, batched branches)
is unchanged and still synchronous; only the three functions that execute a
statement — `fetchRows`, `attachToOne`, `attachToMany` — became `Effect.gen`
bodies. A statement runs through the `SqlClient`:

```typescript
const sql = yield* SqlClient;
const text = `select … from … where …`;
const raw = yield* sql.unsafe<Record<string, unknown>>(text, built.params);
```

`sql.unsafe` replaces the Zod backend's `db.query`, and its result *is* the rows
array, so the old `rowsOf` unwrapping of a driver result is gone. The resolver
keeps its own `$n` placeholder building rather than composing `sql` fragments;
that keeps the generated SQL byte-for-byte identical to the Zod resolver's and
leaves the door open to move to the template API later.

Recursion is safe: `fetchRows` calls itself for a branch, but each call is
inside an `Effect.gen` body, so it is deferred rather than evaluated eagerly.

## Testing

- `scripts/generate-queries.test.ts` drives the model builder and the renderer
  with hand-built fixtures and asserts the `Effect`-returning signatures.
- `src/db/resolvers.test.ts` runs the resolver against a seeded in-memory PGlite
  client provided as `PgliteClient.layer({ liveClient })`. It covers projection,
  to-one/to-many/inlined branches, filters, and errors.

The batching invariant — a branch costs exactly one extra query, not one per
parent — is asserted by providing a `Layer` whose `SqlClient` is a `Proxy` that
counts every `unsafe` call before delegating to the real client. The resolver
runs all SQL through `unsafe`, so the count is exact.

## Commands

- `pnpm generate:effect:queries` — writes `src/db/queries`.
- `pnpm --filter backend-effect run generate:queries --out <dir>` — writes
  elsewhere.
- `pnpm generate:effect` — runs it after the repositories generator.
