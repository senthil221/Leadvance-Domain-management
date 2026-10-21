-- Deliverability checks per domain and more inbox detail from Smartlead:
-- registration date (domain age), the app's own DNS record checks,
-- Smartlead's blacklist scan, and why an inbox is disconnected or its
-- warmup is blocked.

alter table domains
  add column registered_at          date,        -- from the registry (RDAP) when the registrar didn't say
  add column dns_spf                boolean,
  add column dns_dkim               boolean,
  add column dns_dmarc              boolean,
  add column dns_mx                 boolean,
  add column dns_checked_at         timestamptz,
  add column blacklist_domain_count integer,
  add column blacklist_ip_count     integer,
  add column blacklist_listings     jsonb,
  add column blacklist_checked_at   timestamptz;

alter table inboxes
  add column smartlead_created_at  timestamptz,
  add column warmup_blocked_reason text,
  add column connect_error         text;
