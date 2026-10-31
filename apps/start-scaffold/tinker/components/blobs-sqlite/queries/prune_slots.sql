delete from blob_slot
where expires_at <= :now
