-- Domains a registrar account now lists with an expiry date while the registry
-- last said it had no record of them (registered after the registry was asked,
-- as Unstoppable did for 68 on 10 and 11 Nov 2026): ask the registry again on
-- its next run instead of in up to a week. From now on the registrar sync does
-- this itself whenever a domain's expiry date changes.
update domains set registry_checked_at = null
where archived_at is null and registry_found = false
  and registrar_account_id is not null and expires_at is not null;
