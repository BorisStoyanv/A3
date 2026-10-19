alter table deployments
  add column if not exists priority text not null default 'normal',
  add column if not exists queue_enqueued_at timestamptz not null default now(),
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_deadline_at timestamptz,
  add column if not exists assigned_host_canister_id text;

alter table deployments
  drop constraint if exists deployments_priority_check;

alter table deployments
  add constraint deployments_priority_check
  check (priority in ('normal', 'pro', 'enterprise'));

update deployments
set priority = 'normal'
where priority is null
   or priority not in ('normal', 'pro', 'enterprise');

update deployments
set queue_enqueued_at = coalesce(queue_enqueued_at, created_at, now())
where queue_enqueued_at is null;

update deployments
set status = case
  when status in ('queued', 'processing', 'succeeded', 'failed') then status
  when status in ('running', 'pending') then 'processing'
  else 'failed'
end
where status not in ('queued', 'processing', 'succeeded', 'failed')
   or status in ('running', 'pending');

update deployments
set assigned_host_canister_id = nullif(btrim(coalesce(metadata->>'hostCanisterId', '')), '')
where assigned_host_canister_id is null;

update deployments
set processing_started_at = coalesce(processing_started_at, started_at, created_at, now())
where status = 'processing';

update deployments
set processing_deadline_at = coalesce(processing_deadline_at, now() + interval '10 minutes')
where status = 'processing';

drop index if exists deployments_active_project_unique_idx;
drop index if exists deployments_active_host_canister_unique_idx;

create index if not exists deployments_queue_scheduler_idx
  on deployments (status, priority, queue_enqueued_at, created_at);

create index if not exists deployments_queue_host_idx
  on deployments (status, assigned_host_canister_id, priority, queue_enqueued_at);

create unique index if not exists deployments_processing_host_unique_idx
  on deployments (assigned_host_canister_id)
  where status = 'processing'
    and assigned_host_canister_id is not null
    and nullif(btrim(assigned_host_canister_id), '') is not null;
