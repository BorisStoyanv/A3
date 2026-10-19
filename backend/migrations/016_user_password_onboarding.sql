alter table users
  add column if not exists password_set_by_user boolean not null default true;
