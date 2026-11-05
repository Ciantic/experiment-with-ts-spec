# Notifications

An entity can publish change events over Postgres `LISTEN`/`NOTIFY`. The two
scopes are independent: each has its own tag, trigger, and channel.

- `all` — "something changed on the table". Without a filter it is a
  statement-level trigger, so a bulk write publishes one event; with a filter it
  fires per row. Either way the event carries no key: a subscriber receives
  `{ op }`.
- `rows` — "one of these rows changed". One event per changed row, carrying the
  primary key; a subscriber receives `{ pks, op }`.

Declare each scope with its own tag, and the subset the REST surface exposes with
`@restWatch`:

```ts
/**
 * @pgTable widget
 * @repository create
 * @queries query
 * @watchAll ops=insert,update
 * @watchRows
 * @restWatch all rows
 */
export interface Widget {
    /** @primaryKey */
    id: WidgetId;
}
```

`@watchAll` and `@watchRows` are independent: an entity may declare either or
both. `ops=` on each tag restricts the operations that scope's trigger
publishes, one or more of `insert`, `update`, and `delete`; omitted means all
three. `@restWatch` is optional and may only name a scope the entity declares,
so an entity can stream to backend callers and stay off the wire. `rows` needs a
primary key; a keyless table is already a diagnostic and gets no rows scope.

One generated module holds both streams:

- `packages/infra/src/db/queries/watch<Entity>.ts` — generated: `watch<Entity>`
  for `all` and `watch<Entity>Rows` for `rows`.
- `packages/infra/src/db/notifications.ts` — the hand-written subscriptions.
- `packages/infra/src/http/sse.ts` — the stream a generated route answers with.
- `packages/infra/src/postgres/schema.sql` — generated triggers.
- `packages/sdk/src/watch.ts` — the typed `EventSource` helper.

## Filtering by a field

A filter marker is a bare tag on a stored scalar field: its value is added to
that scope's change payload, so a subscriber can narrow the stream. The field
must be a plain column of the interface; a `@relation`, `@children`,
`@computed`, or array field is a lint finding.

```ts
/**
 * @pgTable invoice
 * @repository create
 * @queries query
 * @watchAll
 * @watchRows
 */
export interface Invoice {
    /** @primaryKey */
    id: InvoiceId;

    /** @watchAllFilter */
    tenantId: TenantId;

    /** @watchRowsFilter */
    customerId: CustomerId;
}
```

`@watchAllFilter` requires `@watchAll` and adds its fields to the `all` payload.
`@watchRowsFilter` requires `@watchRows` and adds its fields to the `rows`
payload. A field may carry both markers.

## The triggers

Each scope installs its own trigger and publishes on its own channel:
`<table>_all_channel` and `<table>_rows_channel`.

`@watchAll` without a filter installs a statement-level trigger that publishes
only `TG_OP`:

```sql
create function "widget_all_notify"() returns trigger as $$
begin
    perform pg_notify('widget_all_channel', TG_OP);
    return null;
end;
$$ language plpgsql;

create trigger "widget_all_notify" after insert or update or delete on "widget"
    for each statement execute function "widget_all_notify"();
```

A `@watchAllFilter` makes the `all` trigger row-level, because a statement
trigger cannot read a changed row's values. It publishes the operation and the
filter values, but no key:

```sql
create function "widget_all_notify"() returns trigger as $$
begin
    if TG_OP = 'UPDATE' and (OLD."tenantId") is distinct from (NEW."tenantId") then
        perform pg_notify('widget_all_channel', json_build_object('op', TG_OP, 'filter', json_build_object('tenantId', OLD."tenantId"::text))::text);
    end if;
    perform pg_notify('widget_all_channel', json_build_object('op', TG_OP, 'filter', json_build_object('tenantId', case when TG_OP = 'DELETE' then OLD."tenantId" else NEW."tenantId" end::text))::text);
    return null;
end;
$$ language plpgsql;

create trigger "widget_all_notify" after insert or update or delete on "widget"
    for each row execute function "widget_all_notify"();
```

`@watchRows` installs a row-level trigger that publishes the operation, the
primary key, and its filter values. Key values are canonical text, so a `Date`,
a `bigint`, and a `Uint8Array` compare deterministically:

```sql
create function "widget_rows_notify"() returns trigger as $$
begin
    if TG_OP = 'UPDATE' and (OLD."id") is distinct from (NEW."id") then
        perform pg_notify('widget_rows_channel', json_build_object('op', TG_OP, 'key', json_build_object('id', OLD."id"::text))::text);
    end if;
    perform pg_notify('widget_rows_channel', json_build_object('op', TG_OP, 'key', json_build_object('id', case when TG_OP = 'DELETE' then OLD."id" else NEW."id" end::text))::text);
    return null;
end;
$$ language plpgsql;

create trigger "widget_rows_notify" after insert or update or delete on "widget"
    for each row execute function "widget_rows_notify"();
```

A key change notifies both the old and the new identity, so a watcher of either
row sees a change. A composite key contributes one JSON field per key column. A
changed filter value likewise notifies both the old and the new value, so a
watcher of either scope sees the row leave or enter it.

Declaring both scopes installs both triggers. An unfiltered `all` still fires once
per statement while `rows` fires once per row; a filtered `all` and `rows` each
run their own row trigger, so a write publishes twice per row.

## The server-side stream

The two scopes have two functions:

```ts
watchWidget(db, { ops: ["INSERT"], signal })                  // { op } per change
watchWidget(db, { filter: { tenantId }, signal })             // { op } per matching change
watchWidgetRows(db, { pks, ops: ["UPDATE"], signal })         // { pks, op } per requested row
watchWidgetRows(db, { pks, filter: { customerId }, signal })  // { pks, op } per matching requested row
```

A scope the entity does not declare has no function: `all`-only has no
`watchWidgetRows`, and `rows`-only has no `watchWidget`. The filter fields each
function accepts come from that scope's marker.

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
does too. A field without the matching filter tag is not part of the filter type.

A driver holds one connection per channel, not one per subscriber. The first
subscription to a channel opens its connection; every later one joins it, and
`ChannelListeners` fans each payload out to the subscribers of that channel. The
last close issues `UNLISTEN` and releases the connection, so a hundred watchers
of one scope hold one connection rather than a hundred. An entity watched on
both scopes uses two connections. A subscription is still not tied to the
executor that made a request, so a write on another connection is delivered.

Both drivers implement the raw `listen` the registry opens a channel with:
PGlite uses its own listener, and `PgSqlDriver` checks out a pooled connection
for `LISTEN` and returns it after `UNLISTEN`. `SqlDriver.close` releases every
channel before it releases the pool. An executor whose driver does not listen
has no `listen` method, and the subscription refuses it.

## Operations

`ops` on a subscription filters the stream to one or more of `INSERT`, `UPDATE`,
and `DELETE`. Omitted means every operation; an empty array means none.
`ops=` on a scope tag is the publisher-side counterpart: it narrows that scope's
trigger, so an operation the entity does not publish never wakes the listener or
reaches a subscriber. The generated helpers type `ops` to the published set and
the REST route rejects one that names an omitted operation.

## Where the filters run

`ops` and `filter` run in the subscription: the trigger publishes every changed
row on the scope's channel, and the generated stream discards the events the
caller did not name. For a table with heavy traffic this still wakes the listener
for every change; per-value channels are the next step if that becomes
measurable.

## Over REST

One route serves both scopes: `GET /<table>/watch`. Its argument is
`{ pks?, filter?, ops? }`. When `pks` is present the route validates the `rows`
scope and its filter; otherwise it validates `all` and its filter. `ops` is
validated against the operations that scope publishes.

Each event is `{ op }` for the table stream, or `{ pks, op }` for the row stream:

```
data: {"op":"INSERT"}

```

The SDK generates one helper per exposed scope:

```ts
import { ApiClient } from "sdk/index.ts";
import { watchWidget, watchWidgetRows } from "sdk/api/widget.ts";

const http = new ApiClient("http://127.0.0.1:3000");

const all = watchWidget(http, {
    onChange: (event) => {
        // event.op is INSERT, UPDATE, or DELETE
    },
    filter: { tenantId },
    ops: ["DELETE"],
});

const one = watchWidgetRows(http, {
    onChange: (event) => {
        // event.pks.id is the widget; event.op is INSERT, UPDATE, or DELETE
    },
    pks: [{ id }],
    filter: { customerId },
    ops: ["UPDATE"],
});

// later
all.close();
one.close();
```

The helper uses the global `EventSource`; a host without one must install a
polyfill, and a test substitutes the global with a double. A stream never
finishes, so the group handler refuses a streaming call rather than waiting for
its result, just as it refuses any route that answers with a writable instead of
a value.
