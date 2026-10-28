-- The sync part's three tables. JSON columns hold JSON text, checked at the boundary.
create table sync_stream (
  id text primary key,
  revision integer not null default 0
);

create table sync_execution (
  id text primary key,
  stream text not null,
  notification text check (notification is null or json_valid(notification)),
  result text check (result is null or json_valid(result))
);

create table sync_event (
  stream text not null,
  revision integer not null,
  execution_id text not null,
  payload text not null check (json_valid(payload)),
  primary key (stream, revision)
);
