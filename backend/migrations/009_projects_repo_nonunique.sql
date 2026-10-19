drop index if exists projects_repo_unique;

create index if not exists projects_user_repo_idx
  on projects(user_id, repo_url);
