# Permissions

`packages/sdk/src/permissions.ts` declares the `PERMISSIONS` const: for each
entity that has a permission to check, whether a tenant scopes it and the
actions it permits, each with display text. `scripts/sdk/generate-permissions.ts` writes it, so the file is never
edited by hand.

```ts
export const PERMISSIONS = {
    "account": {
        name: "Account",
        tenantOwned: false,
        actions: {
            "create": { name: "Create accounts" },
            "query": { name: "Query accounts" },
        },
    },
    "widget": {
        name: "Widget",
        tenantOwned: true,
        actions: {
            "create": { name: "Create widgets" },
            "query": { name: "Query widgets" },
            "watch": { name: "Watch widgets" },
        },
    },
} as const;

export type Permissions = typeof PERMISSIONS;
export type PermissionEntity = keyof Permissions;
export type PermissionAction<E extends PermissionEntity> = keyof Permissions[E]["actions"];

export type TenantPermissionEntity = {
    [E in PermissionEntity]: Permissions[E]["tenantOwned"] extends true ? E : never;
}[PermissionEntity];
export type TenantPermissionAction<E extends TenantPermissionEntity> = keyof Permissions[E]["actions"];
```

A consumer imports the const and its types from `sdk/permissions.ts`, as it
imports `sdk/specErrors.ts`. The value is `as const`, so each entity key and
action key is a literal type, and the exported types name an entity or an action
without needing a value. `TenantPermissionEntity` is the entity keys whose
`tenantOwned` is `true`, so an entity without `@tenantOwned` cannot be passed to
a tenant-scoped check.

`name` is the entity's camel-cased key split into capitalized words:
`invoiceSentRow` becomes `"Invoice Sent Row"`. An action's `name` is its verb
capitalized plus the entity's plural, so `create` on `Invoice` becomes
`"Create invoices"`, matching the batch the call takes. Both are for
presentation; the keys are what a permission check uses.

`SpecInterface` carries both names, evaluated once while the model parses the
declaration: `displayName` and `plural`. The plural comes from `@plural <noun>`
when the entity declares it. Otherwise the model pluralizes the last word of the
display name: `invoiceSentRow` becomes `"invoice sent rows"`. The override is for
irregular plurals, such as `@plural sent invoices` on `InvoiceSent`.

## Where the actions come from

An entity's actions are the calls its REST endpoints expose. A permission is
only worth checking on a call a session can make, so an infra declaration that
no REST tag exposes adds nothing. The generator reads the exposure from the
parsed `SpecModel` in `scripts/spec/spec-model.ts`:

| Declaration       | Actions                                                   |
| ----------------- | --------------------------------------------------------- |
| `@restRepository` | the write operations it names: `create`, `upsert`, `update`, `delete` |
| `@restQueries`    | `query`                                                   |
| `@restWatch`      | `watch`, whatever scopes it names                         |

The writes come first in their canonical order, then the query, then the watch.
An entity without a `@restWatch` has no `watch` action, and an entity that
exposes no call has no entry at all, whatever `@repository` and `@queries` it
declares for backend callers.

A REST operation adds the action its `@restPermission <scope>:<action>` names,
after the entity's exposed actions and in a stable sorted order. The scope must
be an entity key; the action may be new, and an action the entity already
declares is not added twice. An operation is the one way an entity with no
endpoints of its own appears in the table: its scope keeps the entry. An
operation that is `@restPublic` declares no permission. An entity deferred with
`@todo` generates no infra, so the generator leaves it out.

## Tenant-owned entities

An entity that declares `@tenantOwned` carries `tenantOwned: true`; every
other entity carries `false`. The flag is stated once per entity rather than
per action, since tenancy scopes the whole entity. The `@tenant` root is `false`:
it owns the other entities but is not scoped to itself.

A consumer that needs the tenant-owned subset filters the table:

```ts
const tenantOwned = Object.entries(PERMISSIONS).filter(([, entity]) => entity.tenantOwned);
```

The `TenantPermissionEntity` type derives the same subset at compile time. There
is no second const, so an entity's actions cannot drift between two tables.

## Route guards

Every generated entity route carries a `guard`: the router runs it after the
input validates and before the handler, and it refuses the call by throwing. A
single request and a `/$group` entry run the same check.

`scripts/infra/generate-guards.ts` writes one module per exposed call into
`packages/infra/src/http/guards/`, named for the check it makes, so the route
listing reads as a sentence:

```ts
import { canDeleteInvoice } from "../guards/index.ts";

defineRoute({
    id: "deleteInvoice",
    method: "DELETE",
    path: "/invoice",
    source: "query",
    input: z.array(invoicePrimaryKeySchema),
    guard: canDeleteInvoice,
    handler: (ctx, body) => deleteInvoice(ctx.db, body),
}),
```

The module holds the check itself, so a reader sees exactly what the route
refuses without following a factory:

```ts
// packages/infra/src/http/guards/canDeleteInvoice.ts
export const canDeleteInvoice: RouteGuard<readonly InvoicePrimaryKey[]> = async (ctx, argument) => {
    if (argument.length === 0 || (await ctx.hasGlobalPermission("invoice", "delete"))) {
        return;
    }
    const tenants = new Set(await getInvoiceTenants(ctx.db, argument));
    if (tenants.size === 0) {
        throw new ForbiddenError("invoice:delete names no tenant the session can be checked against");
    }
    for (const tenant of tenants) {
        if (!(await ctx.hasTenantPermission("invoice", "delete", tenant))) {
            throw new ForbiddenError(`missing permission invoice:delete in tenant ${tenant}`);
        }
    }
};
```

A global entity's module asks for the one permission its kind names and nothing
else:

```ts
// packages/infra/src/http/guards/canCreateTenant.ts
export const canCreateTenant: RouteGuard = async (ctx) => {
    if (!(await ctx.hasGlobalPermission("tenant", "create"))) {
        throw new ForbiddenError("missing permission tenant:create");
    }
};
```

| Route | Tenants the module checks |
| --- | --- |
| `query` | every tenant the filter names |
| `create` | every inserted row's tenant |
| `watch` | the filter tenant, or the tenant of every key named |
| `upsert` | every row's tenant, and the stored tenant it leaves |
| `update` | the stored tenant, and the tenant a patch moves it to |
| `delete` | the stored tenant of every key |

The tenant field is the entity's `@tenantOwned` field, written into the module as
a literal; a delete reads no tenant from its argument, so it names only the
lookup. A read and a create take the tenant from the argument and need no lookup.
A route that addresses a stored row calls the entity's generated
`get<Entity>Tenants` directly; the module never builds SQL itself.

The argument type is the route's schema type: `InvoiceInsert`, `InvoicePatch`,
`InvoiceUpsert`, or `InvoicePrimaryKey` for a write, and a filter for a read whose
tenant names the `@tenant` root's primary-key type. The parser resolves that type
once into `SpecModel.tenantIdType` — `TenantId` from `spec/user-service/Tenant.ts`,
say — so the guard reads `filter?.tenantId` or `row.tenantId` without indexing the
entity.

Every module is plain TypeScript over the parsed argument, with no shared guard
helper: a read's filter names its tenant as a set, so the module spreads
`filter?.tenantId`; a row names its tenant as one value, so the module reads
`row.tenantId`; a watch names one filter value and falls back to the lookup. The
set is deduplicated with `new Set`, and a value that is absent simply contributes
none.

### The two-level check

A guard asks for the global permission first: `hasGlobalPermission(scope, action)`.
Holding it allows the call whatever tenants it names, and no row is read. Without
it, the guard resolves the tenants the call addresses and requires
`hasTenantPermission(scope, action, tenant)` for each one, where `tenant` is the root's
`TenantId` that `@tenantOwned` pins to the `@tenant` interface. The global check
types `scope` as a `PermissionEntity` type parameter `E` and `action` as
`PermissionAction<E>`; the tenant check uses `TenantPermissionEntity` and
`TenantPermissionAction<E>`. A misspelled entity, an action the entity does not
permit, or a tenant check on an entity without `@tenantOwned` is a compile error.
A call that names several tenants is refused as a whole when the session lacks
any one of them; a guard never narrows a read to the permitted subset.

An upsert and a patch check both sides of a move: the tenant the row is stored in
and the tenant it is written into. A create checks only the row's tenant, since no
row exists yet. The stored tenant comes from the entity's `get<Entity>Tenants`,
run on the request's executor (`ctx.db`), which inside a `transaction` group is
the same boundary as the write.

A read or a watch that names no tenant, and a key that resolves to no stored row,
cannot be checked against a tenant, so the guard refuses the call. An empty batch
of writes names no row, so it is allowed and does nothing. An upsert or a patch
that moves a row is checked against both tenants.

### Optional ownership

An entity that declares `@tenantOwned optional` has rows that may belong
to no tenant, and a null tenant is checked against the **global** permission. The
guard asks for it first, so a session holding it reaches every row. Without it,
the guard refuses any row whose tenant is null:

- A create counts an omitted or null tenant as an unowned row, and an upsert does
  the same, because both write the row whole. A patch counts only an explicit
  null, since an omitted field keeps the stored tenant.
- The lookup answers `(TenantId | null)[]`, so a stored row with no tenant is
  visible to the guard rather than dropped.
- A read filter may name `{ isNull: true }`. That names no tenant, so the guard
  refuses it without the global permission, exactly as it refuses a read that
  names no filter at all.

A batch that mixes tenanted and unowned rows needs the global permission for the
unowned one and `hasTenantPermission` in each named tenant; holding neither is
refused as a whole.

### The generated lookup

The stored-row lookup is generated per entity by `scripts/infra/generate-queries.ts`
into `packages/infra/src/db/queries/get<Entity>Tenants.ts`, with the same SQL a
hand-written read would use:

```ts
import type { TenantId } from "spec/user-service/Tenant.ts";

export async function getInvoiceTenants(
    db: SqlExecutor,
    pks: readonly InvoicePrimaryKey[],
): Promise<TenantId[]> {
    if (pks.length === 0) {
        return [];
    }
    const result = await db.query<{ tenant: TenantId }>(
        'select distinct "tenantId" as "tenant" from "invoice" where "id" = any($1)',
        [pks.map((key) => key.id)],
    );
    return result.rows.map((row) => row.tenant);
}
```

The return type is the `@tenant` root's primary-key type, so every tenant lookup
answers the same type; the parameter is the entity's own primary-key type, so a
guard passes patch or upsert rows only because both carry that key. A composite key matches one
`unnest($n::type[])` per key column. No generated function hardcodes a domain
name, and neither does a guard. An optionally owned entity's lookup returns
`(TenantId | null)[]`, so the null a global row stores reaches the guard.

A guard does not scope the SQL itself. It checks who may run the call, not what
the handler builds, so a resolver that ignored a filter would still read across
tenants, and Postgres RLS with a per-request executor remains the database-level
mechanism — see `docs/tenancy.md` and `docs/rest-api.md`.

`RequestContext.hasGlobalPermission` and `hasTenantPermission` are still the
scaffold, so a guarded server answers `501` until the principal is resolved. Their
parameters are typed against `PERMISSIONS`, which checks every generated guard at
compile time.

### Operation guards

An operation route carries the guard its operation id or `@restPermissionGuard`
names. The guard is hand-written because its argument is the operation's own
input, not an entity filter or a row batch:

```ts
// packages/operations/src/guards/canSendInvoice.ts
export const canSendInvoice: RouteGuard<SendInvoiceInput> = async (ctx, argument) => {
    if (await ctx.hasGlobalPermission("invoice", "send")) {
        return;
    }
    const tenant = argument.invoice.tenantId;
    if (!(await ctx.hasTenantPermission("invoice", "send", tenant))) {
        throw new ForbiddenError(`missing permission invoice:send in tenant ${tenant}`);
    }
};
```

`scripts/operations/generate-operation-guards.ts` scaffolds one guard per
permission, named `can<OperationId>` or the name `@restPermissionGuard` gives.
The scaffold fails closed with `NotImplemented`; replacing the body is the
author's work, and the guard file is never overwritten.
`pnpm lint:operation-guards` runs the generator with `--check`, which reports a
missing guard, a guard that no longer exports its name, and a guard whose body no
longer names the `scope:action` the spec declares, either joined or as the two
arguments of a permission check. The operation route generator imports the guard
from `./guards/<name>.ts` and attaches it under `guard:`. See
`docs/operations.md`.

## Keys

The key is the entity name with its leading word lowercased, the same name the
SDK gives the entity's API module: `Widget` becomes `"widget"`, and
`WidgetPart` becomes `"widgetPart"`. A leading run of capitals is one word, so
`URLRoute` becomes `"urlRoute"`. Entries follow the entity name order, as every
other generated list does.

## Running it

`pnpm run generate:permissions` writes the permissions file. The pipeline runs it
right after the linter, since it reads the entity declarations and the
`@restPermission` tags. `pnpm run generate:queries` writes the
`get<Entity>Tenants` lookups with the other read modules,
`pnpm run generate:guards` writes the entity `can<Call>` modules, and
`pnpm run generate:operation-guards` scaffolds the operation guards before the
operation routes are written. `--out <file>` and `--out <dir>` write elsewhere,
as the error generator does. Like the other generated files, a stale permissions
copy is caught by running the generator, not by a check; the guard generator has
the `--check` mode described above.

## Gotchas

- **Global first, tenant second.** A session holding the global permission runs no
  lookup; only a per-tenant grant reads the stored tenants.
- **A guard lookup is its own statement.** Outside a group transaction it is a
  separate statement from the write, so a row whose tenant changes between the
  two is a narrow window. Carrying the allowed tenants into the generated
  statement's `where` would close it and remove the extra `select`.
- **The guard reads the argument's tenant field.** A field that disagrees with
  the row's tenant is the database's problem, not the guard's — the composite
  foreign keys in `docs/tenancy.md` are what stop it.
- **The guard body is the enforcement.** An operation guard is hand-written, so
  the `@restPermission` tag and the permission string in the body can drift.
  `pnpm lint:operation-guards` catches a body that no longer names the declared
  `scope:action`; it cannot judge a check that names it but tests the wrong
  thing.
- **A shared guard checks one permission.** Two operations may name the same
  guard only when their `@restPermission` is identical; the linter reports a
  shared guard that requires two permissions.
