create index if not exists deployments_queue_rank_lookup_idx
  on deployments (
    status,
    assigned_host_canister_id,
    priority,
    queue_enqueued_at,
    created_at,
    id
  )
  where status = 'queued'
    and assigned_host_canister_id is not null
    and nullif(btrim(assigned_host_canister_id), '') is not null;
