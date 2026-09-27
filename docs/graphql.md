# GraphQL

`packages/backend/scripts/generate-graphql.ts` reads `packages/spec/src/domain` and
writes a code-first GraphQL layer into `packages/backend/src/graphql/`.

- `pnpm generate:graphql` — writes `scalars.ts`, `loaders.ts`, `schema.ts`, and `index.ts`.
- `pnpm generate:graphql --out <dir>` — writes elsewhere. A missing directory is created.

The output is committed. Regenerate rather than editing it by hand.

## Why generated

The spec is already the definition of the application: `@table`, `@relation`,
`@children`, `@inlined`, and the field types feed the DDL
(`docs/schema-generation.md`) and the repositories (`docs/repositories.md`). A
hand-written GraphQL schema would be a second definition of the same facts, free
to drift from the tables the resolvers actually query. Generating it keeps one
interpretation in play: a field cannot exist in the API and not in the spec.

The generator reads the spec through `packages/backend/scripts/spec-model.ts`,
like the other two. That module now also exposes a **graph** view of each
interface — `Table.graphFields`, a list of `GraphField` nodes — alongside the
column view. A `GraphField` is one interface property classified by
`kind`:

| `kind` | Meaning | Storage |
| --- | --- | --- |
| `scalar` | A client-supplied column. | The field's own column. |
| `computed` | A `@computed` column. | The field's own column, trigger-maintained. |
| `relation` | A `@relation` entity. | A `<field>Id` foreign key column. |
| `children` | A `@children` collection. | No column on this table; the child carries the key. |
| `inlined` | An `@inlined` snapshot entity. | Prefixed scalar columns on the same table. |

The column view and the graph view come from the same pass, so a field cannot be
in the schema and not in the table.

## The four files

- **`scalars.ts`** — the custom scalars: `Decimal`, `Money`, `Quantity`,
  `TaxRate`, `Version`, `DateTime`. Each is carried as text.
- **`loaders.ts`** — the `DataLoader`s, the paged list queries, and the
  `GraphQLContext` handed to every resolver.
- **`schema.ts`** — one `GraphQLObjectType` per entity, the `Query` root, and the
  `schema` export. Resolvers are inline.
- **`index.ts`** — `createContext(db)` and `execute(source, context)`, the entry
  points a server calls.

## Following relations

A relation resolves through a `DataLoader` — one query per level, batched by
foreign key, so sibling rows share a round trip rather than one per row:

- `Invoice.customer` (`@relation`) loads `customerById` with the row's
  `customerId`.
- `Invoice.rows` (`@children`) loads `invoiceRows`, a loader keyed by the child's
  `invoiceId`. The key column is discovered from the child table: the column
  whose `references.table` is the parent.
- `InvoiceSent.customer` (`@inlined`) loads **nothing**. Its columns are already
  on the row, so the resolver rebuilds the nested object from the `customer…`
  prefix. A query over a snapshot looks the same as one over a draft and costs no
  join.

The three are indistinguishable to a query author, which is the point: following
`Invoice.rows` or `InvoiceSent.customer` is just a nested selection.

## Rows are flat

The resolvers read `Row = Record<string, unknown>`, not the spec entity types.
They have to: storage is flat. `Invoice.customer` is a `customerId` column, not a
`Customer`; an inlined field is a set of prefixed columns. Typing a resolver's
parent as `Invoice` would describe an object the database never returns, so the
generated code names what is actually there — a row keyed by column name — and
the GraphQL type is what callers see. Scalars need no resolver: the column name
and the field name are the same.

## Scalars

| Spec type | GraphQL |
| --- | --- |
| `string`, `Email`, `Unit`, `Currency`, `Language`, `EInvoiceAddress`, `EInvoiceOperator` | `String` |
| `number` | `Float` |
| `boolean` | `Boolean` |
| `GUID`, `BrandedId`, any `<Entity>Id` | `ID` |
| `Date` | `DateTime` |
| `Money`, `Quantity`, `TaxRate`, `Decimal` | the same-named scalar |
| `Version` | `Version` |

`Money`, `Quantity`, `TaxRate`, and `Version` are carried as strings, matching
the drivers: the numeric mappers return `decimal` as a string
(`docs/primitives.md`) and `int8` as a `bigint` (`docs/versioning.md`). A GraphQL
`Float` would reintroduce the precision loss those types exist to avoid; a
`Version` sent as a JSON number would trip `JSON.stringify` on a `bigint`.

## Roots

Each entity gets two `Query` fields: a single node by primary key
(`invoice(id: ID!)`) and a paged list (`invoices(limit: Int, offset: Int)`). The
list reads with `order by <primary key> limit … offset …`, defaulting to 100
rows, so paging is stable without a sort the schema does not model. The singular
root reuses the by-id loader, so a list followed by per-node detail batches.

## Trying it

`packages/backend/src/server/` is hand-written wiring — it knows nothing about the
domain and takes whatever schema and context it is given.

```
pnpm serve:graphql
```

opens an in-memory PGlite (`packages/backend/src/server/pglite-database.ts`) with
the committed `schema.sql` applied, and serves:

| Route | Content |
| --- | --- |
| `POST /graphql` | A GraphQL request: JSON `{ query, variables, operationName }`, or a bare document. |
| `GET /graphql` | The same, with `query`, `variables`, and `operationName` in the query string. |
| `GET /schema` | The SDL, for reading the whole API without introspection. |
| `GET /` | A playground: a query box, a variables box, and the JSON response. Disable with `--no-playground`. |

```
pnpm serve:graphql -- --port 4000 --host 0.0.0.0 --no-playground
```

`PORT` and `HOST` are read from the environment as defaults. The tables are
empty: the server is for exploring the schema and trying queries, not for seeded
data.

The pieces:

- `request-handler.ts` — the HTTP semantics: routing, body parsing, status
  codes. It takes `{ schema, context, playground }` and imports nothing from the
  generated layer, so it is tested with a fixture schema.
- `pglite-database.ts` — the in-memory database behind `RowExecutor`.
- `playground.ts` — the playground HTML.
- `main.ts` — argument parsing and `node:http` wiring.
- `register-typescript.ts` — a resolver hook, see below.

## Why the playground is not GraphiQL

The playground is a hand-written page: a `<textarea>`, a `<button>`, and a
`fetch` to `/graphql`. It pulls nothing from a CDN, so it works offline and
cannot break behind a third party's back.

GraphiQL was the first choice and was dropped after it failed in practice. A
CDN build is the only way to load GraphiQL without adding React and a bundler to
this repo, and both options were broken when tested:

- **esm.sh** served `graphiql@3.9.0`, whose `@graphiql/react` pulls in
  CodeMirror 5. esm.sh's split build of CodeMirror 5 throws
  `Cannot read properties of undefined (reading 'attach')` on render, so the
  editor never appears. Every other GraphiQL version returned `500` from esm.sh
  with `no space left on device` on its build cache, so nothing else could be
  pinned.
- **jsDelivr** bundles React into each package's `+esm` build, so GraphiQL's
  React is not the page's React, and the compiler runtime throws
  `Cannot read properties of undefined (reading 'useMemoCache')`.

A real GraphiQL would mean installing `graphiql`, `react`, and `react-dom` and
bundling them here — the build step this repo deliberately does not have. The
plain page covers what the dev server is for: sending a query and seeing the
result. Use an external GraphiQL against `/graphql` if its editor is wanted; the
endpoint sends `access-control-allow-origin: *` for exactly that.

## Running TypeScript under plain node

The repo runs TypeScript directly, with no build step. Node strips types but
does **not** rewrite `.js` specifiers to `.ts` (the same gotcha
`docs/testing.md` records), and the generated files import each other with
`.js` so vitest and `tsc` can resolve them. `pnpm serve:graphql` therefore runs:

```
node --import ./src/server/register-typescript.ts src/server/main.ts
```

`register-typescript.ts` registers a resolve hook that maps a relative `.js`
specifier to its `.ts` source when one exists, and otherwise defers. It is a
dev-server concern only: the generated files keep `.js`, and nothing else runs
under plain node.

## Deliberately not implemented

- **Mutations.** The GraphQL layer is read-only. Writes are the generated
  repositories (`docs/repositories.md`), where a patch and its optimistic-lock
  version are explicit; exposing them as GraphQL input types is a separate design
  once the read surface settles.
- **Filtering and ordering.** No `where` or `orderBy` argument, on a root or on a
  relation. A `where` compiler over real columns is the natural next step; it is
  left out until the query shapes are known.
- **Nested paging.** A `@children` relation returns every child. Paging a
  relation needs a per-parent cursor, which the single-key loader does not carry.
- **Fragments, directives, aliases, subscriptions.** The parts of GraphQL that
  are not "ask for a field and follow a relation" are unused. TypeScript reuses
  selection shapes via functions instead of fragments.
- **Interfaces and unions.** Every entity is a distinct object type. Two entities
  that share fields — `Invoice` and `InvoiceSent` — are not related in the
  schema, because they are not related in the spec.
- **Enums for closed unions.** A closed literal union is a `CHECK` in Postgres, so
  it could be a GraphQL enum; today every string-like field is `String`. The
  spec's unions are open (`docs/primitives.md`), so enums would be premature.
- **Transport and auth.** The dev server is unauthenticated and in-memory;
  `execute` runs an operation against a context. HTTP hardening, batching,
  persisted queries, and authorization are the caller's.
- **`storage=derived`.** The spec accepts it and the schema generator emits
  nothing for it (`docs/spec-annotations.md`); the query layer does not compute it
  either.

## Gotchas

- **Plural root names are naive.** The list root is the singular plus `s`, so
  `InvoiceSent` becomes `invoiceSents`. Renaming it means teaching the generator
  a plural form.
- **A list reads every column.** The `select` is the table's full column set, so
  a draft's nullable columns and a snapshot's inlined party columns are always
  read. There is no projection pushdown; the GraphQL selection decides what is
  returned, not what is read.
- **`RowExecutor` is not `SqlExecutor`.** The repositories write and ignore the
  result, so `SqlExecutor.query` returns `unknown`. The loaders need rows, so
  they take `RowExecutor`, whose `query` resolves to `{ rows }`. Both drivers
  satisfy both; the split is what keeps a write from depending on a result shape.
- **`dataloader` is a default-imported CommonJS package.** `import DataLoader from
  "dataloader"` relies on the `nodenext` interop; a different module setting would
  need `esModuleInterop`.
- **An inlined value is null when its key column is null.** The resolver tests the
  target's `id` column, so a snapshot whose party is absent returns `null` rather
  than an object of nulls. If the key is present but another column is null, that
  field is null.
- **The list order is the primary key, not a date.** Two entities with the same
  insertion order are not ordered by `createdAt`; adding a sort argument is part
  of the filtering work above.
- **The context is per request.** `createLoaders` must be called once per
  operation. Reusing a `Loaders` across requests serves stale rows and can leak
  data between users.
- **The dev server is a dev server.** It binds `127.0.0.1`, has no
  authentication, and sends `access-control-allow-origin: *` so an external
  GraphiQL can call it. Each new process starts from an empty in-memory database
  and loses everything on exit. Do not expose it.
- **The playground is deliberately plain.** No autocomplete, no schema docs, no
  history — see "Why the playground is not GraphiQL". `GET /schema` is the
  schema reference.
- **Execution errors are 200, malformed requests 400.** Per GraphQL-over-HTTP, a
  request that parses but fails to execute answers `200` with an `errors` array.
  A `400` means the request itself was unusable (bad JSON, missing query).
- **`GET` is not restricted to queries.** The schema is read-only, so there is no
  mutation to reject over `GET`; the usual "mutations must be POST" rule has
  nothing to enforce yet.
- **No transaction and no batching across roots.** The operation's queries run
  independently through the same `db`; nothing wraps them, matching
  `docs/repositories.md`.
- **The decimal scalars serialize with `String(value)`.** A `bigint` or a
  `number` reaching a decimal field is stringified rather than rejected, so a
  mapper regression would not fail loudly here.

## Wiring

1. `packages/backend/scripts/spec-model.ts` classifies every spec field into
   `Table.graphFields` while it builds the column model.
2. `generate-graphql.ts` maps those kinds to GraphQL types, resolvers, and
   `DataLoader`s, and writes the four files.
3. A caller builds a context from a driver and runs an operation:

   ```ts
   const context = createContext(createPglite());
   const result = await execute(
       "query { invoice(id: $id) { number customer { name } rows { description totalAmount } } }",
       context,
       { id },
   );
   ```

See `docs/testing.md` for what is and is not asserted about this layer.
