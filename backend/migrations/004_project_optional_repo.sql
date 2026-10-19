alter table projects
  alter column repo_url drop not null,
  alter column branch drop not null;
