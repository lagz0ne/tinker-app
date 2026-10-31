select owner, max_bytes, expires_at, name, hash, size
from blob_slot
where id = :id
