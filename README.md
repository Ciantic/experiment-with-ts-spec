# Spec driven experiment

Humans, this readme is for you.

- `packages/spec/src` is mostly succinct description of what the application is made of. Understanding domain models require understanding business domain, and Postgres and REST functionality. Everything is defined as TypeScript interfaces, with JSDoc annotations specifying further behavior.

If you change the TypeScript spec, there is deterministic re-generation scripts that generate:

- REST endpoints
- Repository functions create, update and delete functions
- Query function with granular control of which fields are filterable, orderable and so on

TODO: More specifics goes here.