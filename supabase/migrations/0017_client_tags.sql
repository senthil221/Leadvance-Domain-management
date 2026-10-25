-- Which client a Smartlead tag belongs to. Some accounts tag inboxes with a
-- person's name, several tags to one client, so the tag can't be the client.
-- Settings → "Client assignment" switches an account between the two ways:
--   tags    a tag is a client of the same name (the original behaviour)
--   mapped  only the tags listed here decide the client
create table client_tags (
  tag        text primary key,                                -- lower case, single spaces
  display    text not null,
  client_id  uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now()
);

insert into settings (key, value) values ('client_source', '"tags"') on conflict (key) do nothing;
