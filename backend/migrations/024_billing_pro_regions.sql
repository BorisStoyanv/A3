alter table users
  add column if not exists plan text not null default 'free',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_subscription_status text,
  add column if not exists stripe_current_period_end timestamptz,
  add column if not exists stripe_cancel_at_period_end boolean not null default false,
  add column if not exists plan_updated_at timestamptz;

update users
set plan = 'free'
where plan is null or plan not in ('free', 'pro');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_plan_check'
  ) then
    alter table users
      add constraint users_plan_check check (plan in ('free', 'pro'));
  end if;
end
$$;

create unique index if not exists users_stripe_customer_id_unique_idx
  on users (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists users_stripe_subscription_id_unique_idx
  on users (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists stripe_events (
  id text primary key,
  type text not null,
  created_at timestamptz not null default now()
);

alter table host_canisters
  add column if not exists region text not null default 'global',
  add column if not exists visibility text not null default 'public';

update host_canisters
set region = lower(btrim(region))
where region is not null and btrim(region) <> '';

update host_canisters
set region = 'global'
where region is null or btrim(region) = '';

update host_canisters
set visibility = lower(btrim(visibility))
where visibility is not null and btrim(visibility) <> '';

update host_canisters
set visibility = 'public'
where visibility is null or visibility not in ('public', 'private');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'host_canisters_region_format_check'
  ) then
    alter table host_canisters
      add constraint host_canisters_region_format_check
      check (region ~ '^[a-z0-9](?:[a-z0-9-]{0,31}[a-z0-9])?$');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'host_canisters_visibility_check'
  ) then
    alter table host_canisters
      add constraint host_canisters_visibility_check
      check (visibility in ('public', 'private'));
  end if;
end
$$;

create index if not exists host_canisters_routing_idx
  on host_canisters (status, visibility, region);

alter table projects
  add column if not exists region text not null default 'global';

update projects
set region = lower(btrim(region))
where region is not null and btrim(region) <> '';

update projects
set region = 'global'
where region is null or btrim(region) = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_region_format_check'
  ) then
    alter table projects
      add constraint projects_region_format_check
      check (region ~ '^[a-z0-9](?:[a-z0-9-]{0,31}[a-z0-9])?$');
  end if;
end
$$;
