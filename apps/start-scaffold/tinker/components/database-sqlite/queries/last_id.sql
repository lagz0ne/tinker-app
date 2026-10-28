select coalesce(max(id), 0) as id
from start_notify
where channel = :channel
