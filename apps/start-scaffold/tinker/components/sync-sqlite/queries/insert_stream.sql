insert into sync_stream (id)
values (:id)
on conflict do nothing
