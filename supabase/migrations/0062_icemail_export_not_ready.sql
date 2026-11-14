-- Exports Icemail refused because their inboxes weren't ACTIVE yet (Icemail's
-- `active` flag is true while an inbox is still IN_PROGRESS) are put back, so
-- the worker exports the domain again once its inboxes really are ACTIVE.
update icemail_exports set status = 'cancelled',
  message = 'Not every inbox was ACTIVE at Icemail yet; exported once they are'
where status = 'failed' and icemail_export_id is null and message ~* 'not active';
