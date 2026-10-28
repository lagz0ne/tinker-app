select id, payload
from start_notify
where channel = :channel and id > :after
order by id
