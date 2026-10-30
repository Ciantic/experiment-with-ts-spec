# REST API

The database layer is exposed over HTTP, and a type-safe client is generated from
the same spec. Nothing about the surface is written by hand except the three files
that must not be generated: the router, the transport, and the entry re-exporting
the transport.

- `scripts/sdk/rest-model.ts` — the shared model. Paths, methods,
  operation ids, filters, the operations each entity exposes, and the calls a
  `@restOperation` declares. Hand-written.
- `scripts/infra/generate-entity-routes.ts` — the entity route generator.
- `scripts/backend/generate-operation-routes.ts` — the operation route
  generator, and the table that joins both route sets.
- `scripts/sdk/generate-rest-client.ts` — the client generator.
- `packages/infra/src/http/routes/` — generated: `<entity>Routes.ts` per entity,
  each a `Route[]` for that collection, plus the `index.ts` barrel exporting
  `entityRoutes`.
- `packages/backend/src/http/routes/` — generated: `operationRoutes.ts` for the
  calls a `@restOperation` declares, plus the `index.ts` barrel joining infra's
  `entityRoutes` with them into the table the router matches a request on and
  the group handler resolves an id in. See `docs/operations.md`.
- `packages/infra/src/http/router.ts` — the request handler. Hand-written.
- `packages/infra/src/http/api-http-response.ts` — the `ApiHttpResponse` class,
  which holds a response's payload and encodes it in its wire form. Hand-written.
- `packages/infra/src/http/server.ts` — a `node:http` server. Hand-written.
- `packages/sdk/src/api/` — generated: one module per entity plus a barrel
  re-exporting them. Imported by name, not re-exported by the entry.
- `packages/sdk/src/index.ts` — the package entry: the call model and the
  transport, and nothing generated. Hand-written.
- `packages/sdk/src/client.ts` — the call model: builders, `exec`, and the
  combinators. Hand-written.
- `packages/sdk/src/http.ts` — the client transport and codec. Hand-written.
- `packages/infra/src/http/group-handler.ts` — the group entry point.
  Hand-written; see `docs/transactions.md`.

- `pnpm generate:entity-routes` — writes infra's entity route modules.
- `pnpm generate:operation-routes` — writes the operation routes and the
  combined table.
- `pnpm generate:rest-client` — writes the client.
- Either accepts `--out <dir>`; a missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand. A
regeneration also removes a module for an entity that is gone, so a dropped
entity leaves no route module and no client module behind.

## The surface

One collection per entity that exposes one. The collection sits at the
`@pgTable` name and exposes the operations its `@restQueries` and
`@restRepository` tags name: a write `@repository` generates but
`@restRepository` omits is reachable to backend callers and absent from the
route table and the SDK, and an entity that carries no `@restQueries query` has
no read route. An entity that names no exposed operation at all has no
collection: no path, no route module, and no client module. See
`docs/spec-annotations.md`. A read and a delete carry their argument in a single
`q` query parameter; a write carries it in the body.

| Call | Id | Method | Path | Argument |
| --- | --- | --- | --- | --- |
| query | `query<Entity>` | `GET` | `/<table>/query?q=…` | `query<Entity>Schema` |
| create | `create<Entity>` | `POST` | `/<table>` | `[<entity>InsertSchema]` in the body |
| upsert | `upsert<Entity>` | `PUT` | `/<table>` | `[<entity>UpsertSchema]` in the body |
| update | `update<Entity>` | `PATCH` | `/<table>` | `[<entity>PatchSchema]` in the body |
| delete | `delete<Entity>` | `DELETE` | `/<table>?q=…` | `[{ id }]` |
| operation | `sendWidget` | as `@restOperation` names it | as `@restOperation` names it | the operation's input |
| group | — | `POST` | `/$group` | a tree of the calls above, in the body |

The id is the call's name: the generated client function is it, and a group entry
names it instead of a verb and a path. A single request never carries one — the
URL is the address.

The group path is the one call not derived from an entity: it takes a tree of
calls and runs them in one request, and it is owned by the hand-written group
handler rather than the generated table. The handler resolves each entry's id out
of the same table the router matches a request on, so the two entry points cannot
disagree about what a call is. `docs/transactions.md` records its body, its
results, and how a `transaction` group differs from a `batch`.

Which side carries the argument is a field on the model (`source: "query" |
"body"`), so the generated table and the generated client read it rather than
each applying a rule. The router obeys the table: it decodes `q` for a `query`
call and the body for a `body` call, and ignores the other. A group entry carries
its argument as a field of the tree, so it is the one place `source` does not
apply.

A route handler receives one `RequestContext`, whose only field is `db`; a
generated entity route reads `ctx.db`, and a generated operation route passes
`ctx` itself to the module, so the operation's chosen context is compile-checked
against it. `createAppContext` in `packages/infra/src/context.ts` builds the
process's context once at startup, and `createRequestContext(app, request)` builds
a request's context over it. See `docs/operations.md`.

A read pages, orders, and compares: it returns at most `limit` matching rows
(default 1000) starting at `offset`, in the `order` the caller names, narrowed by
`filter` sets and `where` comparisons. A filter the entity marks `@queryFilter
required` has to be named, so a read of a tenant-scoped entity that omits its
`tenantId` is a 400 rather than the whole table. A filter with a
`@queryFilter default=<value>` matches that value when the read omits it,
which is how a nullable `deletedAt` hides trashed rows (`docs/soft-delete.md`).
A nullable field's filter also takes `{ isNull: true }` or `{ isNotNull: true }`
instead of a set, which is how a read asks for the deleted rows. A
caller that wants a single row takes the first result (`docs/queries.md`).

A create takes `<entity>InsertSchema`, the columns the database does not own, and
a patch takes `<entity>PatchSchema`, mirroring the repository signatures exactly
(`docs/repositories.md`). An upsert takes `<entity>UpsertSchema` — the create's
field set plus the version it claims — and is a `PUT`, since replacing a row
whole is idempotent: the same body sent twice leaves the row in the same state,
except for the counter the statement increments. A delete needs only the key, so it
takes `<entity>PrimaryKeySchema`: the entity projected to its `@primaryKey`
fields — one per column of a composite key — made strict so a key the statement
ignores is a 400 (`docs/validation.md`).

A create and an upsert answer `200` with the keys they wrote, in the order the
rows were carried — the rows the repository returned, unchanged
(`docs/repositories.md`) — and the client types the response `<Entity>PrimaryKey[]`.
`update` and `delete` answer `200` with `null`, the codec's spelling of a void
write. The key type is the one validation declares, so the client's read of a
write's answer and the key a delete sends are one definition.

## Why a read is a `GET` with `q`

A read is safe, idempotent, and fully determined by its URL, so `GET` is what it
is — and a shared cache may store it, which a `POST` body could never allow.
What `GET` cannot do is carry the argument as a body, and the reads take a
structured one:

- **A filter is a set.** `Filters` maps a field to an array, and every clause is
  `= any($n)`. `?id=a&id=b` can spell one set; it cannot spell two independent ones
  without inventing an encoding.
- **`select` is a nested object.** The argument
  `{ label: true, rows: { select: { note: true } } }` survives a query string
  only with bracket encoding, and then the argument is parsed by hand instead
  of by `strictObject`, which is what makes an unknown key fail rather than be
  stripped.

So the whole argument goes into one parameter, `?q=<devalue>`, encoded and
decoded by the same codec the responses use. One parameter and one codec means no
bracket syntax, no per-field URL grammar, and one validator still in play.

A write keeps a real body, because `q` has a length limit that a batch of rows
would meet. The delete uses `q` because it carries keys rather than row data, and
a `DELETE` body is not universally relayed by intermediaries.

The cost is that limit: a URL is bounded by Node's `maxHeaderSize` (16 kB by
default) and often tighter behind a proxy, so a filter naming thousands of ids
is refused where a body would have been accepted. That is the trade for a read
that is safe and cacheable.

Grouping by collection keeps the paths resource-shaped, so methods still carry
the meaning they usually do.

## Two generators over one model

`scripts/sdk/rest-model.ts` holds everything both sides must agree on:
the method, the path, where the argument travels, and the filter fields. Neither
generator may re-derive any of it — that is the way the two would drift. It sits
beside the client generator in `scripts/sdk`, and the route generators import it
from there; the drift check drives them all and stays with the backend's table.

The model is mapped from the parsed spec, the same `parseSpec` the validation
generator reads, so the REST pair and the Postgres generators each depend on the
spec rather than on each other.

The generators are split, rather than one writing both, because their outputs
have different import rules:

| | `generate-entity-routes.ts` / `generate-operation-routes.ts` | `generate-rest-client.ts` |
| --- | --- | --- |
| May import | `sdk/*`, `../db/queries/*`, `../db/repositories/*`, `./router.ts`, `infra` | `spec/*`, type-only `../selection.ts` and `../repositories/*`, and its own `../client.ts` |
| Lives in | `scripts/infra`, `scripts/backend` | `scripts/sdk` |
| Emits | `packages/infra/src/http/routes/*.ts`, `packages/backend/src/http/routes/*.ts` | `packages/sdk/src/api/*.ts` |

That second row is the point of the client and is asserted by a test: **the
generated client imports nothing from infra or the backend.** It cannot reach a table
name, a column, a driver, or `zod`. Its imports of the schema modules are
type-only: the read types (`Selection`, `Selected`, `Filters`, `Order`, `Where`)
come from `../selection.ts` and the write types (`<Entity>Patch`,
`<Entity>Insert`) from `../repositories/*`, the same definitions the resolver and
the route table use, so `zod` (and every schema) stays out of the client's
runtime. Everything else it agrees with the server on is what `packages/spec`
declares.

A drift check is the second assertion: both generators are driven from one model
and the `(method, path)` sets they render are compared, so a route added on the
server and forgotten in the client fails a test rather than a request.

## The client builds calls; `exec` sends them

Because the read types are shared with the server, the generated client keeps the
server's narrowing. A generated function takes the argument and returns a call, and `exec`
is the one function that talks to the network:

```typescript
export function queryWidget<S extends Selection<Widget>>(
    opts: {
        filter: Filters<Widget, "id" | "tenantId" | "accountId" | "supplierId", "tenantId">;
        order?: Order<"createdAt" | "updatedAt">[];
        where?: Where<Widget, { startsAt: "gte" | "lte" }>;
        limit?: number;
        offset?: number;
        select: S;
    },
): Call<Selected<Widget, S>[]> {
    return call<Selected<Widget, S>[]>("GET", "/widget/query", opts);
}
```

```typescript
const [widget] = await exec(http, queryWidget({
    filter: { tenantId: [tenantId], id: [id] },
    select: { label: true, total: true, rows: { select: { note: true } } },
}));
// widget.rows![0].note    ✓
// widget.rows![0].total   ✗  not selected
```

Nothing about the narrowing changes: the selection is fixed where the builder is
called, so `Selected<E, S>` is the same conditional type it is on the server.

This is why the client is generated from the spec rather than derived from an
OpenAPI document: `Selected<E, S>` is a conditional type, and conditional types
do not survive a round trip through a document format.

`update` takes the `<Entity>Patch` type from the SDK's schema modules — the same
definition the repository takes and the route table validates with — so the
client cannot drift from the server:

```typescript
import type { WidgetInsert } from "../repositories/widgetInsertSchema.ts";
import type { WidgetPatch } from "../repositories/widgetPatchSchema.ts";
import type { WidgetPrimaryKey } from "../repositories/widgetPrimaryKeySchema.ts";

export function updateWidget(rows: WidgetPatch[]): Call<void>
export function deleteWidget(rows: WidgetPrimaryKey[]): Call<void>
```

A create narrows the same way, to `<Entity>Insert`, so the type a caller sends
and the schema that validates it agree, and it answers `<Entity>PrimaryKey[]`
(`docs/validation.md`). Every one is imported
type-only and re-exported, so `zod` stays out of the client's runtime.

A builder carries no client, which is what lets `exec` accept several of them at
once. `transaction` and `batch` group calls into one request, and only
`transaction` makes the group atomic; `docs/transactions.md` owns that model.

## Transport

The codec is [`devalue`](https://github.com/Rich-Harris/devalue), on both sides,
and it carries the `q` parameter as well as the bodies.

- A read or a delete sends its argument as `?q=<encodeURIComponent(stringify(…))>`.
- A create or an update sends `devalue.stringify`'d rows as the body, under
  `content-type: application/json` (a `devalue` payload is a valid JSON string).
- A group sends `devalue.stringify`'d tree as the body, the same way.
- A success response is `devalue`; the client decodes it.
- A failure is plain `JSON.stringify`, so an error is readable in a log or in
  `curl` without a decoder. It carries `error` and, when the server classified
  it, `kind`; a group failure adds `path`, and a refused argument adds `issues`.
  The client branches on the status: not-ok means parse JSON and rebuild the
  class from `kind`, ok means decode. See `docs/errors.md`.

The reason to prefer it over a wire schema per entity is that `Date` and `bigint`
survive as themselves. `version` is `bigint & Brand`, `startsAt` is a `Date`,
and the amounts are branded strings; a JSON encoding would need an ISO-string
`z.iso.datetime().transform(…)` and a digit-string `BigInt` conversion, which
changes the schema's output type and fights `Selected<E, S>` at the edge. With
`devalue` the generated validation schemas validate the decoded body unchanged,
and no transport model of an entity exists at all.

Two rules follow from the codec:

- **A miss is `null` on the wire.** A write has no value to send, so the
  server encodes `null`; the generated signature types the call as `void`.
- **Decode, never evaluate.** `devalue.parse` reconstructs plain values and
  executes nothing. `uneval`/`eval` must never be used, and the transport is a
  parser of untrusted input: the router caps the body at 1 MB.

## Status mapping

The router and the group handler answer a value or throw the failure; the server
turns a thrown error into an `ApiHttpResponse.failure`: a status and a plain-JSON
payload. An `AppError` names its own status and kind; only an error that is not
one is matched against the driver's `code` (`statusFor`,
`src/http/api-http-response.ts`). `docs/errors.md` records the hierarchy and the
body shape.

| Code | Status | Meaning |
| --- | --- | --- |
| `22P02` | 400 | invalid text representation |
| `23502` | 400 | not-null violation |
| `23503` | 409 | foreign-key violation |
| `23505` | 409 | unique violation |
| `40001` | 409 | a version conflict, or a patch or upsert that matched no row (`docs/versioning.md`) |
| anything else | 500 | a server fault |

A generated query raises `QueryError` (400) for a read the query model refuses,
and a body past the transport cap raises `PayloadTooLargeError` (413). A `q`
parameter or a body that does not decode is a `RequestError` (400), an argument
the schema rejects is a `ValidationError` (400) with the Zod issues, and a
method/path pair not in the table is a `NotFoundError` (404). An absent argument
decodes as `undefined`, which the schema then rejects — the same path as an
empty body.

A group failure answers the same way and adds the `path` of the entry that
failed, so a caller can name it without re-deriving it from the tree it sent. A
typed conflict inside a group keeps its `kind`, so the SDK raises the same class
with the path attached. `docs/transactions.md` records the shape.

A group that names transaction options it cannot open a boundary with — a
`batch`, or a group nested inside another boundary — is a 400 at the `path` of
that group, and so is a mode that is not one of the literals a `begin` accepts.
No mode reaches the statement unvalidated.

## Gotchas

- **`curl` cannot read a response.** A success body is `devalue`; without a
  decoder it is a ref array. A `q` parameter is equally opaque, so a hand-made
  request needs an encoder too. The error bodies are the exception, deliberately.
- **A read URL has a length limit.** The argument is in the URL, so a filter
  naming thousands of ids fails where a body would have worked. Node answers a
  too-large request itself (`maxHeaderSize`, 16 kB by default) before the router
  sees it, and a proxy's limit may be lower.
- **The wire format is JavaScript-specific.** `devalue` has no cross-language
  spec, so there is no OpenAPI artifact and no non-JS client. See "Deliberately
  not implemented".
- **A create takes only what it writes.** `<entity>InsertSchema` carries the
  columns the database does not own, so `id` and the `@computed` fields a client
  must not choose are absent and a stray one is a 400; a `@pgDefault` field, a
  clock, and a defaulted `@version` are present but optional, since the column
  default fills them when the client omits one, and a field with a nullable
  column also takes `null`, which means the same as omitting it
  (`docs/repositories.md`). The generated client types the same way, as
  `<Entity>Insert`.
- **A patch takes only what an update writes.** `<entity>PatchSchema` is the
  create's field set plus the version, so the same branches and derivable values
  are absent and a stray one is a 400 rather than a no-op; a defaulted column may
  be sent to override the default. The generated `<Entity>Patch` type narrows
  with it. A field with a nullable column also takes `null`, which clears it,
  where omitting the field keeps the stored value (`docs/repositories.md`).
- **An upsert replaces the row whole, and claims its version.**
  `<entity>UpsertSchema` is the create's field set plus the version, so a field
  it omits takes its default rather than the stored value, and a branch it omits
  writes nulls over the snapshot. The version it carries is the revision a new
  row is born at and the revision a stored row must hold; a stored row at another
  version answers `409` (`docs/versioning.md`).
- **A `query` with no filters scans the table, up to `limit`.** `queryTenant(http,
  { select })` is legal by design and returns the first 1000 rows; a read of a
  tenant-scoped entity must name its tenant, and nothing else narrows it. There is
  no authorization.
- **The version precondition is the client's to send.** `update` requires the
  version the client read; the statement matches on it, so a stale one is a 409
  rather than a silent skip. An id that is not there answers the same way.
  `upsert` requires one too, and answers the same way when the stored row is at
  another version.
- **The server reads no configuration.** `createApiServer(app, routes)` takes the
  context startup built and the assembled route table; the caller owns the port
  and TLS.

## Deliberately not implemented

- **Authorization.** Nothing scopes a read to a principal, so the API exposes the
  whole database to whoever can reach it. The two shapes are Postgres RLS with a
  per-request executor, or a guard reading the annotation model; both are a
  decision before this is deployable, not a generator change. What the schema
  does enforce is that a row cannot be *linked* across tenants, and that a read
  of a tenanted entity names its tenant — see `docs/tenancy.md`.
- **A JSON encoding for non-JS clients.** `devalue` cannot be described by an
  OpenAPI document, so no such document is emitted. The fix when a non-JS
  consumer is real is `Accept` negotiation adding a JSON encoding, not a document
  that misdescribes the bytes.
- **Validating an operation's response.** The route validates the input and has a
  generated result schema, but the result is encoded unvalidated, as with every
  other call.
- **Cursor pagination and a total count.** A read pages with `limit`/`offset`
  (default 1000), and `order` is whitelisted by `@queryOrderBy`
  (`docs/queries.md`). There is no keyset cursor and no count of the matches.
- **A public protocol version.** Client and server ship from one commit, so a
  deployed client and a moved server must be updated together.
