# Permissions

`packages/sdk/src/permissions.ts` declares the `PERMISSIONS` const: for each
entity, the infra-level actions it permits, and `TENANT_OWNED_PERMISSIONS`,
which holds the subset that a tenant scopes. `scripts/sdk/generate-permissions.ts`
writes it, so the file is never edited by hand.

```ts
export const PERMISSIONS = {
    "account": ["create", "upsert", "update", "delete", "query"],
    "widget": ["create", "update", "query", "watch"],
} as const;

export type Permissions = typeof PERMISSIONS;

export const TENANT_OWNED_PERMISSIONS = {
    "widget": ["create", "update", "query", "watch"],
} as const;

export type TenantOwnedPermissions = typeof TENANT_OWNED_PERMISSIONS;
```

The SDK reads both consts at runtime, and a consumer imports them from
`sdk/permissions.ts`, as it imports `sdk/specErrors.ts`. The tuples are
`as const`, so each action is a literal type, and `Permissions` names the keys
and actions without needing a value.

## Where the actions come from

An entity's actions are the ones its infra declarations generate. The generator
reads them from the parsed `SpecModel` in `scripts/spec/spec-model.ts`:

| Declaration   | Actions                                                   |
| ------------- | --------------------------------------------------------- |
| `@repository` | the write operations it names: `create`, `upsert`, `update`, `delete` |
| `@queries`    | `query`                                                   |
| `@watch`      | `watch`, whatever scopes it names                         |

The writes come first in their canonical order, then the query, then the watch.
An entity without a `@watch` has no `watch` action.

A `@restRepository`, `@restQueries`, or `@restWatch` adds nothing. It exposes
over REST an action the infra already has, so the permissions name the infra
action once.

Operations (`@operation`) are application logic rather than infra actions, so
they are not listed. An entity deferred with `@todo` generates no infra, so the
generator leaves it out.

## Tenant-owned entities

`TENANT_OWNED_PERMISSIONS` holds the rows of `PERMISSIONS` for the entities that
declare `@tenantOwned <column>`, and `TenantOwnedPermissions` is its type. An
entity without that tag is not in the subset, so the `@tenant` root is absent:
it owns the other entities but is not scoped to itself. A tenant-owned entity
permits the same actions in both tables, since the two read the same
declarations.

## Route guards

Every generated entity route carries a `guard`: the router runs it after the
input validates and before the handler, and it refuses the call by throwing. A
single request and a `/$group` entry run the same check.

The route listing names the guard the way it names a schema:

```ts
defineRoute({
    id: "deleteInvoice",
    method: "DELETE",
    path: "/invoice",
    source: "query",
    input: z.array(invoicePrimaryKeySchema),
    guard: tenantOwnedDeleteGuard("invoice", getInvoiceTenants),
    handler: (ctx, body) => deleteInvoice(ctx.db, body),
}),
```

A global entity carries `permissionGuard`, named for the action the call kind is:

```ts
guard: permissionGuard("tenant", "create"),
```

| Guard | Route | Tenants it checks |
| --- | --- | --- |
| `tenantOwnedQueryGuard(scope, column)` | `query` | every tenant the filter names |
| `tenantOwnedCreateGuard(scope, column)` | `create` | every inserted row's tenant |
| `tenantOwnedWatchGuard(scope, column, lookup)` | `watch` | the filter tenant, or the tenant of every key named |
| `tenantOwnedUpsertGuard(scope, column, lookup)` | `upsert` | every row's tenant, and the stored tenant it leaves |
| `tenantOwnedUpdateGuard(scope, column, lookup)` | `update` | the stored tenant, and the tenant a patch moves it to |
| `tenantOwnedDeleteGuard(scope, lookup)` | `delete` | the stored tenant of every key |

`column` is the entity's `@tenantOwned` field, written into the call by the route
generator; a delete reads no tenant from its argument, so it takes only the
lookup.

A read and a create take the tenant from the argument, so they need no lookup. A
route that addresses a stored row receives the entity's generated
`get<Entity>Tenants`, which names that row's tenants; the guard calls it before
the handler and never builds SQL itself.

The argument a guard reads is the one the handler receives, so the tenant a call
names in its filter or rows is the tenant it would read or write.

Each factory is generic over that argument and defaults to the shape it reads:
`TenantFilterArgument` for a read, `TenantRowsArgument` for a write, and
`TenantWatchArgument` for a stream. A call site names no type argument, so the
route's own `input` supplies it, and the guard's argument is checked against the
schema's type — `{ filter?: { tenantId?: TenantId[] } }` for an invoice read. The
factory body sees only the constraint, since one guard serves every entity and
reads the tenant column by its runtime name.

### The two-level check

A guard asks for the global permission first: `hasPermission(scope, action)`.
Holding it allows the call whatever tenants it names, and no row is read. Without
it, the guard resolves the tenants the call addresses and requires
`hasPermission(scope, action, tenant)` for each one, where `tenant` is the root's
`TenantId` that `@tenantOwned` pins to the `@tenant` interface. A call that names
several tenants is refused as a whole when the session lacks any one of them; a
guard never narrows a read to the permitted subset.

`tenantOwnedUpdateGuard` and `tenantOwnedUpsertGuard` check both sides of a move:
the tenant the row is stored in and the tenant it is written into. A create
checks only the row's tenant, since no row exists yet. The stored tenant comes
from the entity's `get<Entity>Tenants`, run on the request's executor (`ctx.db`),
which inside a `transaction` group is the same boundary as the write.

A read or a watch that names no tenant, and a key that resolves to no stored row,
cannot be checked against a tenant, so the guard refuses the call. An empty batch
of writes names no row, so it is allowed and does nothing. An upsert or a patch
that moves a row is checked against both tenants.

### The generated lookup

The stored-row lookup is generated per entity by `scripts/infra/generate-queries.ts`
into `packages/infra/src/db/queries/get<Entity>Tenants.ts`, with the same SQL a
hand-written read would use:

```ts
export async function getInvoiceTenants(
    db: SqlExecutor,
    pks: readonly InvoicePrimaryKey[],
): Promise<Invoice["tenantId"][]> {
    if (pks.length === 0) {
        return [];
    }
    const result = await db.query<{ tenant: Invoice["tenantId"] }>(
        'select distinct "tenantId" as "tenant" from "invoice" where "id" = any($1)',
        [pks.map((key) => key.id)],
    );
    return result.rows.map((row) => row.tenant);
}
```

The parameter is the entity's own primary-key type. `TenantLookup` leaves the row
type open, so a lookup accepting the narrower key type still satisfies the
guard's uniform contract: the guard hands over the parsed rows it holds, which
for a patch or an upsert are a superset of the key. A composite key matches one
`unnest($n::type[])` per key column. No generated function hardcodes a domain
name, and neither does a guard.

A guard does not scope the SQL itself. It checks who may run the call, not what
the handler builds, so a resolver that ignored a filter would still read across
tenants, and Postgres RLS with a per-request executor remains the database-level
mechanism — see `docs/tenancy.md` and `docs/rest-api.md`.

`RequestContext.hasPermission` is still the scaffold, so a guarded server answers
`501` until the principal is resolved. An operation route carries no guard yet:
the spec has no annotation naming the permission a call needs.

## Keys

The key is the entity name with its leading word lowercased, the same name the
SDK gives the entity's API module: `Widget` becomes `"widget"`, and
`WidgetPart` becomes `"widgetPart"`. A leading run of capitals is one word, so
`URLRoute` becomes `"urlRoute"`. Entries follow the entity name order, as every
other generated list does.

## Running it

`pnpm run generate:permissions` writes the permissions file. The pipeline runs it
right after the linter, since it reads only the entity declarations.
`pnpm run generate:queries` writes the `get<Entity>Tenants` lookups with the
other read modules. `--out <file>` writes elsewhere, as the error generator does. Like
the other generated files, a stale copy is caught by running the generator, not
by a check.

## Gotchas

- **Global first, tenant second.** A session holding the global permission runs no
  lookup; only a per-tenant grant reads the stored tenants.
- **A guard lookup is its own statement.** Outside a group transaction it is a
  separate statement from the write, so a row whose tenant changes between the
  two is a narrow window. Carrying the allowed tenants into the generated
  statement's `where` would close it and remove the extra `select`.
- **The guard reads the argument's tenant column.** A column that disagrees with
  the row's tenant is the database's problem, not the guard's — the composite
  foreign keys in `docs/tenancy.md` are what stop it.
- **Nothing lints the actions.** The const has no tags for the linter to check,
  so a change to a declaration reaches the file only when the generator runs.
