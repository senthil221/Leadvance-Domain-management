-- A replaced domain keeps sending through its grace period by default: every
-- reply it still brings in counts. Stopping it (daily limit 0 once the new
-- inboxes are in Smartlead) is now something you switch on per replacement.
-- Replacements already started keep the choice they were made with.
alter table replacement_batches alter column stop_old_sending set default false;
