create table if not exists user_github_identities (
  user_id uuid primary key references users(id) on delete cascade,
  github_user_id bigint not null,
  login text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_github_identities_github_user_id_unique_idx
  on user_github_identities (github_user_id);

create index if not exists user_github_identities_login_idx
  on user_github_identities ((lower(login)));
