select stream, revision, execution_id, payload
from sync_event
where (stream = 'public' and revision > :public)
   or (stream = :account and revision > :after)
order by stream, revision
limit 100
