# Errors

## The hierarchy

`packages/backend/src/errors.ts` owns `AppError`, the base of every error the
server raises itself. It carries the HTTP `status` the error answers with, and
an optional `code` for the SQLSTATE a driver raised. `statusFor` in
`packages/backend/src/http/http-response.ts` reads that status first; only an
error that is not an `AppError` is matched against the driver's `code`
(`docs/rest-api.md`).

`packages/backend/src/db/errors.ts` narrows the hierarchy to the database layer:

| Error | Raised when | Status | Code |
| --- | --- | --- | --- |
| `DbError` | base for the errors below | — | — |
| `QueryError` | a read names a field, filter, order, or page the query model refuses | 400 | — |
| `ConflictError` | base for a write that matched fewer rows than the call addressed | 409 | `40001` |
| `VersionConflictError` | a versioned patch or upsert claims a version the row has moved past | 409 | `40001` |
| `NoMatchingRowError` | a versionless patch addresses a key that is not there | 409 | `40001` |
| `ShortWriteError` | a create or snapshot upsert writes fewer rows than it carried | 500 | — |
| `DriverResultError` | `affectedRows` or `resultRows` reads a result the driver did not shape | 500 | — |
| `SavepointOptionsError` | a nested boundary is asked for transaction options | 400 | — |

`ConflictError` carries the SQLSTATE the version trigger raises, so a version
conflict from a repository and one raised by Postgres reach the router as the
same `409`. `NoMatchingRowError` shares the code because both ways of matching
no row take the same recovery: re-read, then retry (`docs/versioning.md`).

The HTTP layer has its own narrow errors: `RequestError` (400) and `BadGroup`
in `packages/backend/src/http/group-handler.ts`, `PayloadTooLargeError` (413)
for a body past the transport cap, `UsageError` for the command line, and
`MockDataError` for spec mock data with no create repository. `GroupFailure`
wraps a handler failure and keeps its status and the tree path of the entry that
raised, so a group failure maps exactly as the same error would outside a group.

## The JSDoc contract

Every `throw new SomeError(…)` names that error in the JSDoc of an enclosing
function:

```ts
/**
 * Patch `seller` rows at the version each row claims.
 * @throws {VersionConflictError} when a row is not at the version the patch supplied
 */
export async function updateSeller(db: SqlExecutor, rows: SellerPatch[]): Promise<void> {
```

The tag names the class and gives the reason it was thrown. A public function
may document a throw inside a private or nested function it contains, so a
generated repository documents the `throw` inside its `write` closure once.

`pnpm lint` runs Oxlint with two rules from `scripts/oxlint/errors.js`:

- `errors/throws-jsdoc` reports a `throw new X(…)` when no enclosing function's
  JSDoc has `@throws {X} with a reason`. The rule walks the enclosing functions,
  so the outermost declaration may carry the tag for a nested closure.
- `errors/no-plain-error` reports a `throw` that constructs the base `Error`,
  including `Object.assign(new Error(…), …)`.

Both rules are syntactic: they read the `throw` statements in a file and do not
trace calls. An error that reaches a function only through another call is
documented by hand where that matters. Test files and scripts are exempt, since
their throws are fixtures and tooling failures rather than API contract.

## Generated repositories

A generated operation declares the errors it raises directly. A create and a
snapshot upsert raise `ShortWriteError`; a versioned update or upsert raises
`VersionConflictError`; a versionless update raises `NoMatchingRowError`. The
error classes are imported from `packages/backend/src/db/errors.ts`, so a
repository module names the type it throws rather than assembling an error with
`Object.assign`.

A driver failure is not wrapped: it reaches the router with the SQLSTATE the
driver gave it, and `statusFor` maps it through the table in
`docs/rest-api.md`. The same applies to `DriverResultError` raised by
`resultRows` while a repository reads a statement's returned rows.
