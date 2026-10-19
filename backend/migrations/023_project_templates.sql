alter table projects
  add column if not exists template_id text,
  add column if not exists template_name text;

create unique index if not exists projects_user_template_unique_idx
  on projects (user_id, template_id)
  where template_id is not null;
