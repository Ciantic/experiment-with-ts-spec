# Spec driven experiment

Humans, this readme is for you.

[`packages/spec/src`](./packages/spec/src/) is mostly a succinct description of what the application is made of. The specification is for demonstrating code generation, this doesn't mean it's an invoicing application, but I use it as an example. Domain models and specified behaviour require understanding the business domain, and Postgres and REST functionality. Everything is defined as TypeScript interfaces, with JSDoc annotations forming a mini-DSL for generating the code.

If you change the TypeScript spec, there are deterministic re-generation scripts that generate:

- Repository functions: create, update, upsert and delete functions
- Operation function stubs, these should contain the business logic
- Query function with granular control of which fields are filterable, orderable and so on
- REST endpoints, generated from exposed repository functions and operations

TODO: More specifics goes here.

## Architecture

### Code generation

```mermaid
flowchart TD
    specs["<b>Specs</b><br/>packages/spec/src<br/>Domain models, related interfaces and business logic skeleton"]
    specModel["<b>Spec model</b><br/>scripts/spec/spec-model.ts<br/>One ts-morph parse of the domain"]

    specs --> specModel

    subgraph scripts["scripts/"]
        direction TB
        lint["<b>Spec linter</b><br/>scripts/spec/lint-spec.ts<br/>Gates every generator"]

        pgModel["<b>Postgres model</b><br/>scripts/infra/postgres-model.ts"]
        zodModel["<b>Zod model</b><br/>scripts/sdk/zod-model.ts"]
        restModel["<b>REST model</b><br/>scripts/sdk/rest-model.ts"]

        subgraph infraScripts["infra/"]
            direction TB
            pgSchema["<b>Postgres schema generator</b><br/>generate-postgres-schema.ts<br/>Tables, columns, constraints and triggers"]
            repositories["<b>Repository generator</b><br/>generate-repositories.ts<br/>Create, update, upsert and delete functions"]
            queries["<b>Query generator</b><br/>generate-queries.ts<br/>Typed query functions and query metadata"]
            entityRoutes["<b>Entity route generator</b><br/>generate-entity-routes.ts<br/>Route table for repositories and queries"]
        end

        subgraph backendScripts["backend/"]
            direction TB
            operations["<b>Operation scaffolder</b><br/>generate-operations.ts<br/>One module per @operation"]
            operationRoutes["<b>Operation route generator</b><br/>generate-operation-routes.ts<br/>Operation routes and the combined table"]
        end

        subgraph sdkScripts["sdk/"]
            direction TB
            errors["<b>Error generator</b><br/>generate-errors.ts<br/>One class per @throws"]
            validation["<b>Zod schema generator</b><br/>generate-zod-schemas.ts<br/>Validation schemas and Insert/Patch types"]
            restClient["<b>REST client generator</b><br/>generate-rest-client.ts<br/>Type-safe SDK calls"]
        end
    end

    subgraph packages["Packages"]
        direction TB
        subgraph sdkPkg["sdk"]
            sdkSchemas["<b>Generated schemas and types</b><br/>Domain, repository, operation and query schemas<br/>Insert, Patch and Upsert types"]
            sdkErrors["<b>Generated error classes</b>"]
            sdkApi["<b>Generated API modules</b><br/>Consumed by the hand-written transport"]
        end
        subgraph infraPkg["infra"]
            infraSchema["<b>Generated schema.sql</b>"]
            infraData["<b>Generated repositories and queries</b>"]
            infraRoutes["<b>Generated entity route table</b>"]
            infraRuntime["<b>Context, router, server and mock seed</b>"]
        end
        subgraph backendPkg["backend"]
            backendRoutes["<b>Generated operation routes and table</b>"]
            backendOperations["<b>Operation scaffolds</b><br/>Business logic filled in by hand"]
            backendMain["<b>Process entry point</b>"]
        end
    end

    specModel --> lint
    specModel --> pgModel
    specModel --> zodModel
    specModel --> restModel
    specModel --> operations
    specModel --> errors
    pgModel --> pgSchema
    pgModel --> repositories
    pgModel --> queries
    zodModel --> validation
    restModel --> entityRoutes
    restModel --> operationRoutes
    restModel --> restClient
    errors --> sdkErrors
    validation --> sdkSchemas
    restClient --> sdkApi
    pgSchema --> infraSchema
    repositories --> infraData
    queries --> infraData
    entityRoutes --> infraRoutes
    operationRoutes --> backendRoutes
    operations --> backendOperations
```

### Packages

- `infra` - Postgres schema, generated repositories, queries and entity routes,
  plus the request contexts and HTTP runtime.
- `backend` - The application implementation: operation logic and the process
  entry point over `infra`.
- `sdk` - Type-safe REST API SDK, shared validation schemas, and shared types
- `spec` - Domain models

```mermaid
flowchart LR
    spec["<b>spec</b><br/>Domain interfaces and primitives"]
    sdk["<b>sdk</b><br/>Generated REST client, Zod schemas,<br/>shared write and read types"]
    infra["<b>infra</b><br/>Postgres schema, repositories,<br/>queries, contexts and HTTP runtime"]
    backend["<b>backend</b><br/>Operations and process entry point"]

    sdk --> spec
    infra --> spec
    infra --> sdk
    backend --> infra
    backend --> spec
    backend --> sdk
```

### Request data flow

Data for the requests flows through two contexts:

1. `AppContext` is application specific context, created once on startup.
2. `RequestContext` is request specific context, created from `AppContext` for each request.
3. REST endpoint functionality then use parts from the `RequestContext` such as `db: SqlExecutor` or request details like headers.
