-- The public stream every app's sync reads, as the Postgres set seeds it (account_streams migration).
insert into sync_stream (id) values ('public') on conflict do nothing;
