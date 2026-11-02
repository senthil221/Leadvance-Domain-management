-- Dead domains: active or warming, but nothing on them can send. Either no
-- inbox is connected in Smartlead any more (all disconnected or deleted), or
-- inboxes still show connected while the domain's DNS no longer answers (the
-- zone or the registration is gone, so mail to and from it fails). The cause
-- comes from the last Smartlead sign-in errors: a deleted Microsoft tenant, an
-- expired Microsoft sign-in, Google mail switched off. Tenant default domains
-- (*.onmicrosoft.com) have no zone of their own, so DNS doesn't count there.

create or replace view dead_domains as
select d.id as domain_id,
  case
    when x.connected > 0 then 'dns_gone'
    when x.tenant_deleted > 0 then 'tenant_deleted'
    when x.signin_expired > 0 then 'signin_expired'
    when x.mail_off > 0 then 'mail_off'
    when x.disconnected > 0 then 'disconnected'
    else 'deleted'
  end as cause,
  x.connected, x.disconnected, x.removed, x.provider_type,
  (select max(s.day) from smartlead_domain_daily s where s.domain_name = d.name and s.sent > 0) as last_send_day
from domains d
join lateral (
  select count(*) filter (where i.status = 'connected')::int as connected,
    count(*) filter (where i.status = 'disconnected')::int as disconnected,
    count(*) filter (where i.status = 'removed')::int as removed,
    count(*) filter (where i.status <> 'connected' and i.connect_error ~ 'AADSTS500341')::int as tenant_deleted,
    count(*) filter (where i.status <> 'connected' and i.connect_error ~* 'access ?token expired|token is expired|AADSTS700082|invalid_grant')::int as signin_expired,
    count(*) filter (where i.status <> 'connected' and i.connect_error ~* 'mail service not enabled')::int as mail_off,
    max(i.provider_type) as provider_type
  from inboxes i where i.domain_id = d.id) x on true
where d.status in ('active', 'warming')
  and ((x.connected = 0 and x.disconnected + x.removed > 0)
    or (x.connected > 0 and d.nameservers_answering = false and d.name !~ '\.onmicrosoft\.com$'));
