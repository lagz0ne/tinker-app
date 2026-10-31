-- The blob store's two tables. A blob row is written only after its file is in place.
create table blob (
  hash text primary key,
  size integer not null,
  created_at integer not null
);

create table blob_slot (
  id text primary key,
  owner text not null,
  max_bytes integer not null,
  expires_at integer not null,
  name text,
  hash text,
  size integer,
  filled_at integer
);
