update sync_stream
set revision = revision + :count
where id = :id
returning revision
