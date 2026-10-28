create table start_notify (
  id integer primary key autoincrement,
  channel text not null,
  payload text not null,
  created_at integer not null
);

create index start_notify_channel_id on start_notify (channel, id);
