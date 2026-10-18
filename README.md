# Spec driven experiment

Humans, this readme is for you.

[`packages/spec/src`](./packages/spec/src/) is mostly succinct description of what the application is made of. Specification is for demonstration of the code generation, this doesn't mean to be an invoicing application, but I use it as an example. Domain models and specified behavior require understanding business domain, and Postgres and REST functionality. Everything is defined as TypeScript interfaces, with JSDoc annotations forming a mini DSL for generating the code. 

If you change the TypeScript spec, there is deterministic re-generation scripts that generate:

- REST endpoints
- Repository functions create, update and delete functions
- Query function with granular control of which fields are filterable, orderable and so on

TODO: More specifics goes here.

## Architecture

### Code generation

```mermaid
flowchart TD
    specs["<b>Specs</b><br/>Domain models, related interfaces and business logic skeleton"]
    specModel["<b>Spec model</b><br/>Parsed description of the domain"]

    specs --> specModel

    subgraph packages["Packages"]
        direction TB
        subgraph sdkPkg["sdk"]
            zod["<b>Zod schema generator</b><br/>Validation schemas and Insert/Patch types<br/>Error types"]
            sdkApi["<b>Generated API modules</b><br/>Consumed by the hand-written transport"]
        end
        subgraph backendPkg["backend"]
            pgSchema["<b>Postgres schema generator</b><br/>Tables, columns, constraints and triggers"]
            repositories["<b>Repository generator</b><br/>Create, update and delete functions"]
            queries["<b>Query generator</b><br/>Typed query functions and query metadata"]
            restApi["<b>REST API generator</b><br/>Server route table"]
            restClient["<b>REST client generator</b><br/>Type-safe SDK calls"]
        end
    end

    specModel --> packages
    restClient --> sdkApi
```

### Packages

- `backend` - Implementation with REST API,  database repositories etc
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

