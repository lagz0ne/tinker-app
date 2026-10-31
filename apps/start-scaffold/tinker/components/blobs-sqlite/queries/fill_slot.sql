update blob_slot
set hash = :hash, size = :size, name = :name, filled_at = :filled_at
where id = :id and hash is null and expires_at > :now
returning id
