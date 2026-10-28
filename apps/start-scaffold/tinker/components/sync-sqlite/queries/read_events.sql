select stream, revision, execution_id, payload
from sync_event
where stream = :stream and revision > :after
order by revision
