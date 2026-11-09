-- Untracked replies: emails in Smartlead's master inbox that it couldn't tie to
-- a lead in a campaign (someone wrote to an inbox directly, replied from another
-- address, forwarded a thread). Nothing else surfaces them, so the
-- untracked-replies job pulls Smartlead's list every 15 minutes and keeps every
-- reply it has seen. A reply that drops off Smartlead's list (someone dealt with
-- it there) is marked handled rather than deleted. The account managers' Google
-- Sheet reads the open ones through /api/sheet/<token>/untracked.

create table untracked_replies (
  id text primary key,            -- Smartlead's reply id
  account_id bigint,              -- the Smartlead email account it came in on
  subject text,
  sender_name text,
  sender_email text,
  recipient_name text,
  recipient_email text,
  body text,
  received_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  handled_at timestamptz          -- when it left Smartlead's untracked list
);

create index untracked_replies_open_idx on untracked_replies (received_at desc) where handled_at is null;

alter table untracked_replies enable row level security;
