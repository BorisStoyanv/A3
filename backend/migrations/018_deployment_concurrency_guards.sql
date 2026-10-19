with ranked_project as (
  select
    id,
    row_number() over (
      partition by project_id
      order by created_at desc, id desc
    ) as rn
  from deployments
  where status in ('queued', 'pending', 'running')
),
ranked_host as (
  select
    id,
    row_number() over (
      partition by metadata->>'hostCanisterId'
      order by created_at desc, id desc
    ) as rn
  from deployments
  where status in ('queued', 'pending', 'running')
    and metadata is not null
    and nullif(btrim(metadata->>'hostCanisterId'), '') is not null
),
active_conflicts as (
  select id from ranked_project where rn > 1
  union
  select id from ranked_host where rn > 1
)
update deployments
set status = 'failed',
    finished_at = coalesce(finished_at, now()),
    duration_ms = coalesce(
      duration_ms,
      greatest(
        0,
        floor(
          extract(
            epoch from (coalesce(finished_at, now()) - coalesce(started_at, created_at))
          ) * 1000
        )::int
      )
    )
where id in (select id from active_conflicts);

create unique index if not exists deployments_active_project_unique_idx
  on deployments (project_id)
  where status in ('queued', 'pending', 'running');

create unique index if not exists deployments_active_host_canister_unique_idx
  on deployments ((metadata->>'hostCanisterId'))
  where status in ('queued', 'pending', 'running')
    and metadata is not null
    and nullif(btrim(metadata->>'hostCanisterId'), '') is not null;
