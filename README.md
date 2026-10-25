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

        pgModel["<b>Postgres model</b><br/>scripts/backend/postgres-model.ts"]
        zodModel["<b>Zod model</b><br/>scripts/sdk/zod-model.ts"]
        restModel["<b>REST model</b><br/>scripts/sdk/rest-model.ts"]

        subgraph backendScripts["backend/"]
            direction TB
            operations["<b>Operation scaffolder</b><br/>generate-operations.ts<br/>One module per @operation"]
            pgSchema["<b>Postgres schema generator</b><br/>generate-postgres-schema.ts<br/>Tables, columns, constraints and triggers"]
            repositories["<b>Repository generator</b><br/>generate-repositories.ts<br/>Create, update, upsert and delete functions"]
            queries["<b>Query generator</b><br/>generate-queries.ts<br/>Typed query functions and query metadata"]
            restApi["<b>REST API generator</b><br/>generate-rest-api.ts<br/>Server route table"]
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
        subgraph backendPkg["backend"]
            backendSchema["<b>Generated schema.sql</b>"]
            backendData["<b>Generated repositories and queries</b>"]
            backendRoutes["<b>Generated route table</b>"]
            backendOperations["<b>Operation scaffolds</b><br/>Business logic filled in by hand"]
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
    restModel --> restApi
    restModel --> restClient
    errors --> sdkErrors
    validation --> sdkSchemas
    restClient --> sdkApi
    pgSchema --> backendSchema
    repositories --> backendData
    queries --> backendData
    restApi --> backendRoutes
    operations --> backendOperations
```

### Packages

- `backend` - Implementation with REST API, database repositories etc.
- `sdk` - Type-safe REST API SDK, shared validation schemas, and shared types
- `spec` - Domain models

Also backend is kind of big, maybe breaking it to infra and services or something like that would be warranted.

```mermaid
flowchart LR
    spec["<b>spec</b><br/>Domain interfaces and primitives"]
    backend["<b>backend</b><br/>Postgres schema, repositories, routes"]
    sdk["<b>sdk</b><br/>Generated REST client, Zod schemas,<br/>shared write and read types"]

    sdk --> spec
    backend --> spec
    backend --> sdk
```

### Request data flow

Data for the requests flows through two contexts:

1. `AppContext` is application specific context, created once on startup.
2. `RequestContext` is request specific context, created from `AppContext` for each request.
3. REST endpoint functionality then use parts from the `RequestContext` such as `db: SqlExecutor` or request details like headers.
