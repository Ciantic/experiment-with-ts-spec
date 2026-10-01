# Repositories (Effect v4)

`packages/backend-effect/scripts/generate-repositories.ts` turns the domain
models in `packages/spec/src/domain` into CRUD repositories on `effect/sql`,
written to `packages/backend-effect/src/db/repositories`. It is the Effect v4
counterpart of `packages/backend/scripts/generate-repositories.ts`
(`docs/repositories.md`) and runs alongside it, from the same `Table` model.

The Zod backend took an explicit `db: SqlExecutor` argument and returned a
`Promise`. The Effect backend threads the database through the type system
instead: every function returns an `Effect` that **requires the `SqlClient`
service**, and the caller provides it as a `Layer`.

## Output

- `src/db/repositories/<entity>.ts` — one module per entity, exporting
  `create<Entity>`, `update<Entity>`, `delete<Entity>`, and the `<Entity>Patch`
  type.
- `src/db/repositories/index.ts` — the barrel re-exporting every module.

```typescript
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Customer } from "spec/domain/Customer.ts";

/** A partial update: every column is optional except the key and the version. */
export type CustomerPatch = Partial<Customer> & Required<Pick<Customer, "id" | "version">>;

export function createCustomer(rows: Customer[]): Effect.Effect<void, SqlError, SqlClient> {
    if (rows.length === 0) {
        return Effect.void;
    }
    return Effect.gen(function* () {
        const sql = yield* SqlClient;
        const values = rows.map((row) => ({ id: row.id, name: row.name, email: row.email }));
        yield* sql`insert into "customer" ${sql.insert(values)}`;
    });
}
```

## The signature

Every generated function is
`Effect.Effect<void, SqlError, SqlClient>`:

- **`SqlError`** is the typed failure channel. `effect/sql` classifies a driver
  error into a `SqlError` whose `reason` carries a tag (`UniqueViolation`,
  `SerializationError`, `ConstraintError`, …), so the HTTP layer can map it to a
  status without inspecting a driver-specific `code` string.
- **`SqlClient`** is the requirement. Nothing is threaded as an argument; the
  caller provides a `Layer` (a real client, or `PgliteClient.layer()` in a test).

`SqlClient` is imported from `effect/sql/SqlClient`, not `effect/sql`: the
latter's index re-exports it as a namespace, so `effect/sql/SqlClient` is where
the tag itself lives.

## Create uses `sql.insert`

An insert is a single multi-row statement built with the `sql` template and its
`insert` helper, which turns an array of records into
`(columns) values (…), (…)`:

```typescript
const values = rows.map((row) => ({ id: row.id, customerId: row.customer?.id }));
yield* sql`insert into "customer" ${sql.insert(values)}`;
```

The record keys are the physical column names, and the values go through the
column's recorded read accessor, so an `@inlined`/`@relation` field is projected
from the entity object (`customer?.id`) rather than inserted as a nested object.
A column with a database default is left out, exactly as in the Zod backend.

The Zod generator hand-built `values ($1::uuid, $2::text, …)` for the insert;
`sql.insert` does that now, parameterised, with no casts needed because
PostgreSQL infers each parameter's type from its target column.

## Update and delete use `sql.unsafe`

The update and delete keep a hand-built, parameterised statement. Their shapes
are not expressible with the helpers:

- **Update** is `update … set "col" = coalesce(data."col", "table"."col") from
  (values …) as data(…) where …`. A patch that omits a column must keep the
  stored value, so every non-version column is `coalesce`d, and the version is
  assigned directly as the optimistic-lock precondition. The `values` alias is
  otherwise untyped text, so each placeholder is cast to its column type — the
  same reason the Zod backend casts.
- **Delete** is `delete from … using (values …) as data(…) where …`, which
  supports a composite primary key; `sql.in` would only cover a single key.

Both are executed with `sql.unsafe(text, parameters)`. This is the escape hatch
`effect/sql` provides for a statement the template helpers cannot build; the SQL
and the parameters are byte-for-byte what the Zod generator produced, so the two
backends stay in step.

## Empty input

Every function returns `Effect.void` for an empty array before touching the
database, so no statement is issued. `Effect.void` is assignable to the declared
return type because `Effect` is covariant in its error and requirement channels.

## Testing

`scripts/generate-repositories.test.ts` drives the renderer with hand-built
table fixtures (no domain, no ts-morph), then transpiles a generated module and
runs create/update/delete against an in-memory PGlite client provided as a
`PgliteClient.layer()`. It asserts the generated SQL *executes*, not what the
data means. See `docs/testing.md`.

The module is evaluated with a stub `require` that returns the test's own
`effect` and `SqlClient`, so the generated code and the test share one service
tag and one layer. Only `effect` and `effect/sql/SqlClient` are injected; any
other runtime import fails the test.

## Commands

- `pnpm generate:effect:repositories` — writes `src/db/repositories`.
- `pnpm --filter backend-effect run generate:repositories --out <dir>` — writes
  elsewhere.
- `pnpm generate:effect` — runs it after the schema and validation generators.
