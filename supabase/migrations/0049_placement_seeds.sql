-- Placement seeds: addresses whose auto-reply says the person has left ("no
-- longer with the company", "this mailbox is not monitored"). Nobody reads them
-- and they answer every email automatically, so they can tell whether an email
-- reached the inbox: Google sends the auto-reply only when the mail did not go to
-- spam. The placement-seeds job collects them from campaign replies
-- (email_events) and Smartlead's untracked replies, drops any a person has since
-- answered from or that bounced, and looks up who handles each company's mail.

create table placement_seeds (
  email text primary key,           -- lowercase
  domain text not null,             -- the company's domain, the part after @
  name text,                        -- the sender name on the auto-reply, when Smartlead gave one
  source text not null,             -- 'reply' (campaign reply webhook) or 'untracked'
  excerpt text,                     -- the auto-reply's own words, shortened
  forwards boolean not null default false, -- says the mail is forwarded or read by someone else
  first_reply_at timestamptz not null,
  last_reply_at timestamptz not null,
  auto_replies integer not null default 1,
  campaign_name text,               -- the campaign the latest auto-reply answered
  client_id uuid references clients(id) on delete set null,
  person_replied_at timestamptz,    -- a reply a person wrote, after the first auto-reply
  bounced_at timestamptz,           -- the latest bounce to this address
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index placement_seeds_domain_idx on placement_seeds (domain);

-- Who receives mail for each seed's company, from its MX records.
create table placement_seed_domains (
  domain text primary key,
  provider text,                    -- 'google', 'outlook', 'gateway', 'other' or 'none' (no MX)
  provider_name text,               -- "Google", "Microsoft 365", "Mimecast", "Zoho"…
  mx_host text,                     -- the preferred MX host
  checked_at timestamptz,
  error text                        -- the last lookup that failed (it is tried again)
);

alter table placement_seeds enable row level security;
alter table placement_seed_domains enable row level security;
