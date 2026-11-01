# Notifications

An entity can publish change events over Postgres `LISTEN`/`NOTIFY`. Two scopes
share one channel:

- `all` — "something changed on the table". One event per change, without a key;
  a subscriber receives `{ op }`.
- `rows` — "one of these rows changed". One event per changed row, carrying the
  primary key; a subscriber receives `{ pks, op }`.

Declare the scopes with `@notify`, and the subset the REST surface exposes with
`@restNotify`:

```ts
/**
 * @pgTable widget
 * @repository create
 * @queries query
 * @notify all rows
 * @restNotify all rows
 */
export interface Widget {
    /** @primaryKey */
    id: WidgetId;
}
```

`@notify` may name either or both scopes. `@restNotify` is optional and may only
name a scope `@notify` declares, so an entity can stream to backend callers and
stay off the wire. `rows` needs a primary key; a keyless table is already a
diagnostic and gets no row scope.

One generated module holds both streams:

- `packages/infra/src/db/queries/watch<Entity>.ts` — generated: `watch<Entity>`
  for `all` and `watch<Entity>Rows` for `rows`.
- `packages/infra/src/db/notifications.ts` — the hand-written subscriptions.
- `packages/infra/src/http/sse.ts` — the stream a generated route answers with.
- `packages/infra/src/postgres/schema.sql` — generated triggers.
- `packages/sdk/src/watch.ts` — the typed `EventSource` helper.

## Filtering by a field

`@notifyFilter` is a bare marker on a stored scalar field: its value is added to
the change payload, so a subscriber can narrow the stream to the rows it cares
about. The field must be a plain column of the interface; a `@relation`,
`@children`, `@computed`, or array field is a lint finding.

```ts
/**
 * @pgTable invoice
 * @repository create
 * @queries query
 * @notify all rows
 */
export interface Invoice {
    /** @primaryKey */
    id: InvoiceId;

    /** @notifyFilter */
    tenantId: TenantId;
}
```

The interface must declare `@notify`. The marker affects both scopes and the
REST surface whenever the entity exposes a watch.

## The triggers

`all` alone installs a statement-level trigger that publishes only `TG_OP`:

```sql
create function "widget_notify"() returns trigger as $$
begin
    perform pg_notify('widget', TG_OP);
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each statement execute function "widget_notify"();
```

`rows` installs a row-level trigger that publishes the operation and the key.
Key values are canonical text, so a `Date`, a `bigint`, and a `Uint8Array`
compare deterministically:

```sql
create function "widget_notify"() returns trigger as $$
begin
    if TG_OP = 'UPDATE' and (OLD."id") is distinct from (NEW."id") then
        perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', OLD."id"::text))::text);
    end if;
    perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', case when TG_OP = 'DELETE' then OLD."id" else NEW."id" end::text))::text);
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each row execute function "widget_notify"();
```

A key change notifies both the old and the new identity, so a watcher of either
row sees a change. A composite key contributes one JSON field per key column.

A `@notifyFilter` adds a `filter` object to the payload: `all` with a filter
publishes `{ op, filter }`, and `rows` with a filter publishes
`{ op, key, filter }`. A statement-level trigger cannot read a changed row's
values, so a filter promotes the trigger to the row level:

```sql
create function "widget_notify"() returns trigger as $$
begin
    if TG_OP = 'UPDATE' and ((OLD."id") is distinct from (NEW."id") or (OLD."tenantId") is distinct from (NEW."tenantId")) then
        perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', OLD."id"::text), 'filter', json_build_object('tenantId', OLD."tenantId"::text))::text);
    end if;
    perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', case when TG_OP = 'DELETE' then OLD."id" else NEW."id" end::text), 'filter', json_build_object('tenantId', case when TG_OP = 'DELETE' then OLD."tenantId" else NEW."tenantId" end::text))::text);
    return null;
end;
$$ language plpgsql;
```

A changed filter value notifies both the old and the new value, so a watcher of
either tenant sees the row leave or enter its scope.

Declaring both scopes installs the row-level trigger, since it serves `rows`;
`all` ignores the key it carries. A write that changes several rows therefore
produces one event per row for both scopes, not one event per statement.

## The server-side stream

The two scopes have two functions:

```ts
watchWidget(db, { ops: ["INSERT"], signal })                  // { op } per change
watchWidget(db, { filter: { tenantId }, signal })             // { op } per matching change
watchWidgetRows(db, { pks, ops: ["UPDATE"], signal })         // { pks, op } per requested row
watchWidgetRows(db, { pks, filter: { tenantId }, signal })    // { pks, op } per matching requested row
```

A scope the annotation does not declare has no function: `all`-only has no
`watchWidgetRows`, and `rows`-only has no `watchWidget`.

```ts
for await (const { op } of watchWidget(db, { filter: { tenantId }, signal })) {
    // a widget of this tenant changed
}

for await (const { pks, op } of watchWidgetRows(db, { pks: [{ id }], signal })) {
    // pks is the key object passed in; op is INSERT, UPDATE, or DELETE
}
```

A filter value is compared with the canonical text the trigger published. An
omitted field is unconstrained, so `{}` matches every row and omitting `filter`
does too. A field without `@notifyFilter` is not part of the filter type.

The streams release their listening connection when the iterator closes or
`signal` aborts. `subscribe` listens on a connection of its own, so a
subscription is not tied to the executor that made a request, and a write on
another connection is delivered.

Both drivers implement `SqlDriver.listen`: PGlite uses its own listener, and
`PgSqlDriver` checks out a pooled connection for `LISTEN` and returns it after
`UNLISTEN`. An executor whose driver does not listen has no `listen` method, and
the subscription refuses it.

## Operations

`ops` filters the stream to one or more of `INSERT`, `UPDATE`, and `DELETE`.
Omitted means every operation; an empty array means none.

## Where the filters run

`ops` and `filter` run in the subscription: the trigger publishes every changed
row on the table's one channel, and the generated stream discards the events the
caller did not name. For a table with heavy traffic this still wakes the listener
for every change; per-value channels are the next step if that becomes
measurable.

## Over REST

One route serves both scopes: `GET /<table>/watch`. Its argument is
`{ pks?, filter?, ops? }`. `filter` is present when a field carries
`@notifyFilter`, and its values are validated against the entity's own schema.

With both scopes exposed, `pks` is optional: omit it for the table stream, or
send it for the row stream. With only `rows`, the route rejects a call without
`pks`; with only `all`, it rejects one with `pks`.

Each event is `{ op }` for the table stream, or `{ pks, op }` for the row stream:

```
data: {"op":"INSERT"}

```

The SDK generates one helper per exposed scope:

```ts
import { createHttpClient } from "sdk/index.ts";
import { watchWidget, watchWidgetRows } from "sdk/api/widget.ts";

const http = createHttpClient("http://127.0.0.1:3000");

const all = watchWidget(http, (event) => {
    // event.op is INSERT, UPDATE, or DELETE
}, { filter: { tenantId }, ops: ["DELETE"] });

const one = watchWidgetRows(http, (event) => {
    // event.pks.id is the widget; event.op is INSERT, UPDATE, or DELETE
}, { pks: [{ id }], filter: { tenantId }, ops: ["UPDATE"] });

// later
all.close();
one.close();
```

The helper uses the platform's `EventSource` by default; pass `options.source`
to supply another implementation, such as a test double. A stream never
finishes, so the group handler refuses a streaming call rather than waiting for
its result.
