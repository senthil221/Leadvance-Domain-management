-- Tags the Replace list counts as weak on spam, policy and block list bounces.
-- A tag becomes weak at 2x every other live domain and stays weak until it
-- falls under 1.5x, so a tag sitting near 2x doesn't flip its domains between
-- Replace and Watch from one sync to the next. The list rewrites this when the
-- set changes. tag_key is "client id|tags", as the list keys them.

create table replace_weak_tags (
  tag_key text primary key,
  since timestamptz not null default now()
);
