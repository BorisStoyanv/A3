alter table if exists notifications
  add column if not exists event_key text;

create unique index if not exists notifications_event_key_unique_idx
  on notifications (event_key)
  where event_key is not null;

with ranked as (
  select
    user_id,
    row_number() over (
      partition by github_id
      order by updated_at desc nulls last, user_id
    ) as rn
  from github_accounts
  where github_id is not null
)
delete from github_accounts g
using ranked r
where g.user_id = r.user_id
  and r.rn > 1;

create unique index if not exists github_accounts_github_id_unique_idx
  on github_accounts (github_id)
  where github_id is not null;

create table if not exists user_github_access_settings (
  user_id uuid primary key references users(id) on delete cascade,
  access_mode text not null default 'full',
  updated_at timestamptz not null default now(),
  constraint user_github_access_mode_check
    check (access_mode in ('full', 'allowlist'))
);

create table if not exists user_github_repo_allowlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  repo_key text not null,
  repo_full_name text not null,
  repo_owner text,
  repo_name text,
  created_at timestamptz not null default now()
);

create unique index if not exists user_github_repo_allowlist_user_repo_key_idx
  on user_github_repo_allowlist (user_id, repo_key);

create index if not exists user_github_repo_allowlist_user_created_idx
  on user_github_repo_allowlist (user_id, created_at desc);
