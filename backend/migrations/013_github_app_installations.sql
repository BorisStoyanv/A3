create table if not exists github_app_installations (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  installation_id bigint not null,
  account_id bigint,
  account_login text,
  account_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists github_app_installations_user_installation_unique_idx
  on github_app_installations (user_id, installation_id);

create index if not exists github_app_installations_user_updated_idx
  on github_app_installations (user_id, updated_at desc);

alter table projects
  add column if not exists github_installation_id bigint,
  add column if not exists github_repo_id bigint;

create index if not exists projects_github_installation_repo_branch_idx
  on projects (github_installation_id, github_full_name, branch);
