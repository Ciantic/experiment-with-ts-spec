# Notifications

An entity can publish a change stream without a payload: the event says that
`widget` changed, and the consumer reads what it needs. The stream is backed by
Postgres `LISTEN`/`NOTIFY`, so a writer does not need to know who is listening.

- `@queries query notify` — writes `notify<Entity>` next to the entity's query.
- `@restQueries query notify` — exposes `notify<Entity>` as a server-sent event
  stream. `notify` is a read operation, so it must also appear in `@queries`.
- `packages/infra/src/db/queries/notify<Entity>.ts` — generated: subscribes to
  the table's channel.
- `packages/infra/src/db/notifications.ts` — the hand-written subscription both
  the generated function and the REST route use.
- `packages/infra/src/http/sse.ts` — the stream a generated route answers with.
- `packages/infra/src/postgres/schema.sql` — generated: one trigger and one
  `pg_notify` call per notifying table.

## The trigger

A table whose entity declares `notify` gets a statement-level trigger:

```sql
create function "widget_notify"() returns trigger as $$
begin
    perform pg_notify('widget', '');
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each statement execute function "widget_notify"();
```

The channel is the `@pgTable` name, and the payload is empty. The trigger fires
once per statement rather than once per row, because the event carries no row to
name. A statement that writes no row still fires; a consumer that needs to know
whether anything changed re-reads.

The trigger exists only while the entity names `notify` in `@queries`; dropping
the token drops the trigger and the generated module on the next generation.

## Server side

`notify<Entity>` takes the usual `SqlExecutor` and returns an async iterable:

```ts
import { notifyWidget } from "infra";

for await (const change of notifyWidget(db, { signal })) {
    const widgets = await queryWidget(db, { select: { id: true, label: true } });
    // …
}
```

Each iteration is one change notification. The iterator releases its listening
connection when it returns, throws, or is closed; the optional `signal` is the
other way out. `subscribe` listens on a connection of its own, so a subscription
is not tied to the executor that made a request, and a write on another
connection is delivered.

Both drivers implement `SqlDriver.listen`: PGlite uses its own listener, and
`PgSqlDriver` checks out a pooled connection for `LISTEN` and returns it after
`UNLISTEN`. An executor whose driver does not listen has no `listen` method, and
`subscribe` refuses it.

## Over REST

`@restQueries query notify` serves the stream at `GET /<table>/notify`. The call
takes no argument, and the response is `text/event-stream`:

```
data: 

data: 
```

Each event is one change and carries no payload. An `EventSource` client relies
on the event itself, so the SDK's generated helper only takes a callback:

```ts
import { createHttpClient } from "sdk/index.ts";
import { notifyWidget } from "sdk/api/widget.ts";

const http = createHttpClient("http://127.0.0.1:3000");
const subscription = notifyWidget(http, () => {
    // re-read, then update the view
});

// later
subscription.close();
```

`notify<Entity>` is not a `Call`: it opens a connection rather than sending one
request, so `exec` does not take it. The helper takes the `HttpClient` whose
`baseUrl` the stream hangs off, calls back once per message, and returns a
subscription whose `close()` shuts the `EventSource` down. The platform's
`EventSource` is used by default; pass `options.source` to supply another
implementation, such as a test double. A stream never finishes, so the group
handler refuses a streaming call rather than waiting for its result.
