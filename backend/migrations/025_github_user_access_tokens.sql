-- User-scoped credentials are required to authorize App installations with GitHub.
-- Existing accounts reconnect GitHub before installation/repository access resumes.
create table if not exists user_github_oauth_accounts (
  user_id uuid primary key references users(id) on delete cascade,
  access_token_ciphertext text not null,
  updated_at timestamptz not null default now()
);
