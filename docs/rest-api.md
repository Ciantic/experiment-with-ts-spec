# REST API

The database layer is exposed over HTTP, and a type-safe client is generated from
the same spec. Nothing about the surface is written by hand except the two
halves that must not be generated: the router and the transport.

- `packages/backend/scripts/rest-model.ts` — the shared model. Paths, methods,
  filters, and the operations each entity exposes. Hand-written.
- `packages/backend/scripts/generate-rest-api.ts` — the server generator.
- `packages/backend/scripts/generate-rest-client.ts` — the client generator.
- `packages/backend/src/http/routes.ts` — generated: the `Route[]` the router
  matches on.
- `packages/backend/src/http/router.ts` — the request handler. Hand-written.
- `packages/backend/src/http/server.ts` — a `node:http` server. Hand-written.
- `packages/sdk/src/` — generated: one module per entity plus a barrel.
- `packages/sdk/src/http.ts` — the client transport and codec. Hand-written.

- `pnpm generate:rest-api` — writes the route table.
- `pnpm generate:rest-client` — writes the client.
- Either accepts `--out <dir>`; a missing directory is created.

The generated output is committed. Regenerate rather than editing it by hand.

## The surface

One collection per entity, at the `@table` name. A read and a delete carry
their argument in a single `q` query parameter; a write carries it in the body.

| Call | Method | Path | Argument |
| --- | --- | --- | --- |
| query | `GET` | `/<table>/query?q=…` | `query<Entity>Schema` |
| create | `POST` | `/<table>` | `[<entity>InsertSchema]` in the body |
| update | `PATCH` | `/<table>` | `[<entity>PatchSchema]` in the body |
| delete | `DELETE` | `/<table>?q=…` | `[{ id }]` |

Which side carries the argument is a field on the model (`source: "query" |
"body"`), so the generated table and the generated client read it rather than
each applying a rule. The router obeys the table: it decodes `q` for a `query`
call and the body for a `body` call, and ignores the other.

A read pages, orders, and compares: it returns at most `limit` matching rows
(default 1000) starting at `offset`, in the `order` the caller names, narrowed by
`where`. A caller that wants a single row takes the first result
(`docs/queries.md`).

A create takes `<entity>InsertSchema`, the columns the database does not own, and
a patch takes `<entity>PatchSchema`, mirroring the repository signatures exactly
(`docs/repositories.md`). A delete needs only the key, so it takes
`<entity>PrimaryKeySchema`: the entity projected to its `@primaryKey` fields — one
per column of a composite key — made strict so a key the statement ignores is a
400 (`docs/validation.md`).

## Why a read is a `GET` with `q`

A read is safe, idempotent, and fully determined by its URL, so `GET` is what it
is — and a shared cache may store it, which a `POST` body could never allow.
What `GET` cannot do is carry the argument as a body, and the reads take a
structured one:

- **A filter is a set.** `Filters` maps a field to an array, and every clause is
  `in (…)`. `?id=a&id=b` can spell one set; it cannot spell two independent ones
  without inventing an encoding.
- **`select` is a nested object.** `{ number: true, rows: { description: true } }`
  survives a query string only with bracket encoding, and then the argument is
  parsed by hand instead of by `strictObject`, which is what makes an unknown key
  fail rather than be stripped.

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

`rest-model.ts` holds everything both sides must agree on: the method, the path,
where the argument travels, and the filter fields. Neither generator may
re-derive any of it — that is the way the two would drift.

The generators are split, rather than one writing both, because their outputs
have different import rules:

| | `generate-rest-api.ts` | `generate-rest-client.ts` |
| --- | --- | --- |
| May import | `validation/*`, `../db/queries/*`, `../db/repositories/*`, `./router.ts` | `spec/*`, type-only `validation/*`, and `./http.ts` |
| Emits | `packages/backend/src/http/routes.ts` | `packages/sdk/src/*.ts` |

That second row is the point of the client and is asserted by a test: **the
generated client imports nothing from the backend.** It cannot reach a table
name, a column, a driver, or `zod`. The one cross-package import it does have is
type-only: its `<Entity>Patch` and `<Entity>Insert` come from
`packages/validation`, the same definitions the repositories take and the route
table validates with, and a type-only import keeps `zod` (and every schema) out
of the client's runtime. Everything else it agrees with the server on is what
`packages/spec` declares.

A drift check is the second assertion: both generators are driven from one model
and the `(method, path)` sets they render are compared, so a route added on the
server and forgotten in the client fails a test rather than a request.

## The client is the reads with `db` replaced

Because the read types live in the spec, the generated client keeps the server's
narrowing. `db: SqlExecutor` becomes `http: HttpClient` and nothing else changes:

```typescript
export function queryInvoice<S extends Selection<Invoice>>(
    http: HttpClient,
    opts: {
        filter?: Filters<Invoice, "id" | "customerId" | "sellerId">;
        order?: Order<"createdAt" | "updatedAt">[];
        where?: Where<Invoice, { issueDate: "gte" | "lte" }>;
        limit?: number;
        offset?: number;
        select: S;
    },
): Promise<Selected<Invoice, S>[]> {
    return http.query<Selected<Invoice, S>[]>("GET", "/invoice/query", opts);
}
```

`http.query` puts the argument in `?q=`, `http.send` in the body. The generated
module picks between them from the model's `source`, so the call site never
mentions the transport.

So a call site narrows across the wire exactly as it does in the backend:

```typescript
const [invoice] = await queryInvoice(http, {
    filter: { id: [id] },
    select: { number: true, totalAmount: true, rows: { description: true } },
});
// invoice.rows![0].description  ✓
// invoice.rows![0].taxAmount    ✗  not selected
```

This is why the client is generated from the spec rather than derived from an
OpenAPI document: `Selected<E, S>` is a conditional type, and conditional types
do not survive a round trip through a document format.

`update` takes the `<Entity>Patch` type from `packages/validation` — the same
definition the repository takes and the route table validates with — so the
client cannot drift from the server:

```typescript
import type { InvoiceInsert, InvoicePatch } from "validation/invoice.ts";

export function updateInvoice(http: HttpClient, rows: InvoicePatch[]): Promise<void>
```

A create narrows the same way, to `<Entity>Insert`, so the type a caller sends
and the schema that validates it agree (`docs/validation.md`). Both are imported
type-only and re-exported, so the client's public surface is unchanged and `zod`
stays out of its runtime.

## Transport

The codec is [`devalue`](https://github.com/Rich-Harris/devalue), on both sides,
and it carries the `q` parameter as well as the bodies.

- A read or a delete sends its argument as `?q=<encodeURIComponent(stringify(…))>`.
- A create or an update sends `devalue.stringify`'d rows as the body, under
  `content-type: application/json` (a `devalue` payload is a valid JSON string).
- A success response is `devalue`; the client decodes it.
- A failure is plain `JSON.stringify`, so an error is readable in a log or in
  `curl` without a decoder. The client branches on the status: not-ok means
  parse JSON, ok means decode.

The reason to prefer it over a wire schema per entity is that `Date` and `bigint`
survive as themselves. `version` is `bigint & Brand`, `issueDate` is a `Date`,
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
  parser of untrusted input: the server caps the body at 1 MB.

## Status mapping

The router turns a thrown database error into a status from its `code`:

| Code | Status | Meaning |
| --- | --- | --- |
| `22P02` | 400 | invalid text representation |
| `23502` | 400 | not-null violation |
| `23503` | 409 | foreign-key violation |
| `23505` | 409 | unique violation |
| `40001` | 409 | serialization failure — the version conflict (`docs/versioning.md`) |
| anything else | 500 | a server fault |

A `q` parameter or a body that does not decode is 400, an argument the schema
rejects is 400 with the Zod issues, and a method/path pair not in the table is
404. An absent argument decodes as `undefined`, which the schema then rejects —
the same path as an empty body.

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
  columns the database does not own, so `id` and the `@default` / `@computed`
  fields a client must not choose are absent and a stray one is a 400. The
  generated client types the same way, as `<Entity>Insert`.
- **A patch takes only what an update writes.** `<entity>PatchSchema` is the
  create's field set plus the version, so the same branches and defaulted columns
  are absent and a stray one is a 400 rather than a no-op. The generated
  `<Entity>Patch` type narrows with it. What the patch still cannot do is clear a
  column: `coalesce` cannot tell an omitted field from a `null` one, so the patch
  contract carries that limitation over HTTP unchanged (`docs/repositories.md`).
- **A `query` with no filters scans the table, up to `limit`.**
  `queryInvoice(http, { select })` is legal by design and returns the first 1000
  rows. There is no authorization.
- **The version precondition is the client's to send.** `update` requires the
  version the client read; a stale one is a 409 from the trigger, not a silent
  skip.
- **The server reads no configuration.** `createApiServer(db)` takes the
  executor; the caller owns the port, TLS, and the driver.

## Deliberately not implemented

- **Authorization.** Nothing scopes a read to a principal, so the API exposes the
  whole database to whoever can reach it. The two shapes are Postgres RLS with a
  per-request executor, or a guard reading the annotation model; both are a
  decision before this is deployable, not a generator change.
- **A JSON encoding for non-JS clients.** `devalue` cannot be described by an
  OpenAPI document, so no such document is emitted. The fix when a non-JS
  consumer is real is `Accept` negotiation adding a JSON encoding, not a document
  that misdescribes the bytes.
- **An operations route.** `InvoiceOperations` is a contract with no
  implementation, and `lint-spec.ts` deliberately keeps `operations/` out of the
  entity set, so the generator does not see it. `POST /invoice/send` is
  hand-wired when the operation exists.
- **Cursor pagination and a total count.** A read pages with `limit`/`offset`
  (default 1000), and `order` is whitelisted by `@queryorderby`
  (`docs/queries.md`). There is no keyset cursor and no count of the matches.
- **A public protocol version.** Client and server ship from one commit, so a
  deployed client and a moved server must be updated together.
