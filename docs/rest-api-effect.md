# REST API (Effect v4)

The database layer is exposed over HTTP through `effect/http`, and the route
table is generated from the same spec. This is the Effect v4 counterpart of
`packages/backend/src/http/` and `scripts/generate-rest-api.ts`
(`docs/rest-api.md`). The wire contract — paths, methods, the `devalue` codec,
the `q` parameter — is unchanged; only the server runtime and the validator
changed.

- `packages/backend-effect/scripts/rest-model.ts` — the shared model. Paths,
  methods, filters, and the operations each entity exposes. Hand-written.
- `packages/backend-effect/scripts/generate-routes.ts` — the server generator.
- `packages/backend-effect/src/http/routes.ts` — generated: the `Route[]` the
  router matches on.
- `packages/backend-effect/src/http/router.ts` — the request handler.
  Hand-written.
- `packages/backend-effect/src/http/server.ts` — the `effect/http` server.
  Hand-written.

`rest-model.ts` is identical to the Zod backend's, so both generated tables agree
on the surface.

## The surface

Unchanged from `docs/rest-api.md`: one collection per entity at the `@table`
name, a read and a delete carrying their argument in a single `q` query
parameter, a write carrying it in the body.

| Call | Method | Path | Argument |
| --- | --- | --- | --- |
| list | `GET` | `/<table>/query?q=…` | `list<Entity>Schema` |
| get | `GET` | `/<table>/get?q=…` | `get<Entity>Schema` |
| create | `POST` | `/<table>` | `<entity>Schema` in the body |
| update | `PATCH` | `/<table>` | `<entity>PatchSchema` in the body |
| delete | `DELETE` | `/<table>?q=…` | `[{ <key> }]` |

## The generated route table

```typescript
import { Schema } from "effect";
import type { Route } from "./router.ts";
import { createCustomer, listCustomer, getCustomer, deleteCustomer, updateCustomer } from "../db/index.ts";
import { customerSchema, customerPatchSchema, listCustomerSchema, getCustomerSchema } from "../validation/index.ts";

export const routes: Route[] = [
    {
        method: "GET",
        path: "/customer/query",
        source: "query",
        input: listCustomerSchema,
        handler: (body) => listCustomer(body as never),
    },
    /* … */
    {
        method: "DELETE",
        path: "/customer",
        source: "query",
        // effect/schema has no `.pick`, so the key-only struct is rebuilt from the entity's field.
        input: Schema.Array(Schema.Struct({ id: customerSchema.fields.id })),
        handler: (body) => deleteCustomer(body as never),
    },
];
```

Two changes from the Zod backend:

- **The handler lost its `db` argument.** The generated repository and query
  functions now require `SqlClient` in their `Effect`, so the route table only
  carries the argument, not a database.
- **The delete input rebuilds the key struct.** Zod has
  `<schema>.pick({ id: true })`; `effect/schema` has no `pick`, so the generator
  emits `Schema.Struct({ id: <entitySchema>.fields.id })`. `Schema.Struct` exposes
  its `.fields`, so the key schema is reused rather than re-derived.

## The router

`createRouter(routes)` returns an `Effect` that produces an
`HttpServerResponse`, requires the `SqlClient` the handlers need, and is supplied
the request for each call by `effect/http`:

```typescript
createRouter(routes): Effect.Effect<HttpServerResponse, never, HttpServerRequest | SqlClient>
```

It matches `method path`, reads the argument (the `q` parameter for a `query`
call, the request body for a `body` call), decodes it with `devalue`, validates
it, calls the generated handler, and encodes the result with `devalue`.

Three differences from the `node:http` router:

- **Reading the request is an `Effect`.** The method, URL, and body come from the
  `HttpServerRequest` service. A body read that fails is treated as an empty body
  rather than a fault.
- **Validation uses `effect/schema`.** The input is decoded with
  `Schema.decodeUnknownResult(input, { onExcessProperty: "error" })`. Strictness
  must be turned on explicitly, where `z.strictObject` carried it on the schema;
  this is the one place the decode-time option is applied.
- **The router never fails.** The handler's `SqlError` is captured with
  `Effect.result` and mapped to a status; the return type's error channel is
  `never`, so serving cannot crash a request.

### Status mapping

A failed handler is an `effect/sql` `SqlError`, whose `reason` is a tagged union.
The router maps the tag to a status, replacing the old `code`-string lookup:

| `reason._tag` | Status |
| --- | --- |
| `SqlSyntaxError` | 400 |
| `ConstraintError` | 409 |
| `UniqueViolation` | 409 |
| `SerializationError` | 409 |
| `DeadlockError` | 409 |
| `LockTimeoutError` | 409 |
| `StatementTimeoutError` | 408 |
| anything else | 500 |

A success body is `devalue`; an error body is plain JSON, so a failure is
readable without the codec. This matches the Zod backend.

## The server

`server.ts` is deliberately thin — it hands the router to
`HttpServer.serveEffect`, which supplies the request service per call:

```typescript
export const serve = HttpServer.serveEffect(createRouter(routes));
```

`serve` is an `Effect` requiring a `HttpServer` and a `SqlClient`. `main.ts`
provides them: `@effect/platform-node`'s `NodeHttpServer.layer` for the server
and `PgliteClient.layer` for the database.

`HttpServer` and `HttpClient` are imported from their own modules
(`effect/http/HttpServer`, `effect/http/HttpClient`), not `effect/http`: the
index re-exports them as namespaces, so the service tag is not the named export.

## Testing

- `scripts/generate-routes.test.ts` drives the renderer with hand-built table
  fixtures and asserts the emitted routes.
- `src/http/router.test.ts` serves a hand-built route table with the real
  `effect/http` server (`NodeHttpServer.layerTest`) and drives it with
  `HttpClient`. It covers query/body decoding, the `devalue` round trip (a `Date`
  and a `bigint`), unknown routes, validation failures, unknown keys, malformed
  arguments, `SqlError` status mapping, and the void-to-`null` encoding. The
  routes are fixtures, so no test reads the domain.

## Commands

- `pnpm generate:effect:routes` — writes `src/http/routes.ts`.
- `pnpm --filter backend-effect run generate:routes --out <dir>` — writes
  elsewhere.
- `pnpm generate:effect` — runs it after the repositories and queries generators.
