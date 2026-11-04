-- Problems on the fix queue that someone has put off for now. Keyed by domain
-- name and kind of problem: a new kind of problem on the same domain still shows.
create table fix_snoozes (
  domain_name text not null,
  kind        text not null,
  until       timestamptz not null,
  snoozed_by  text,
  created_at  timestamptz not null default now(),
  primary key (domain_name, kind)
);
alter table fix_snoozes enable row level security;
