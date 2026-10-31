insert into blob (hash, size, created_at)
values (:hash, :size, :created_at)
on conflict do nothing
