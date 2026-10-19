create table if not exists user_gitlab_identities (
  user_id uuid primary key references users(id) on delete cascade,
  gitlab_user_id bigint not null,
  username text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_gitlab_identities_gitlab_user_id_unique_idx
  on user_gitlab_identities (gitlab_user_id);

create index if not exists user_gitlab_identities_username_idx
  on user_gitlab_identities ((lower(username)));

create table if not exists gitlab_accounts (
  user_id uuid primary key references users(id) on delete cascade,
  access_token_ciphertext text not null,
  scope text,
  token_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table projects
  add column if not exists git_provider text,
  add column if not exists gitlab_project_id bigint,
  add column if not exists gitlab_path_with_namespace text,
  add column if not exists gitlab_webhook_id bigint,
  add column if not exists gitlab_webhook_secret text;

update projects
set git_provider = case
  when git_provider in ('github', 'gitlab') then git_provider
  when gitlab_project_id is not null then 'gitlab'
  else 'github'
end
where git_provider is null or git_provider not in ('github', 'gitlab');

alter table projects
  alter column git_provider set default 'github';

alter table projects
  alter column git_provider set not null;

do $$
begin
  alter table projects
    add constraint projects_git_provider_check
      check (git_provider in ('github', 'gitlab'));
exception
  when duplicate_object then null;
end
$$;

create index if not exists projects_gitlab_project_branch_idx
  on projects (git_provider, gitlab_project_id, branch);
