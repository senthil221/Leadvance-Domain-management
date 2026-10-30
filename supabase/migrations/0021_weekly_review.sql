-- Weekly review: why each bounce happened, stored once, and clients that are
-- really another client under a different name.

-- A Smartlead client (often a sender's name, like "Gia") merged into the
-- client it belongs to. It stays, hidden, so Smartlead syncs keep finding it
-- by its Smartlead id and send everything to the client it was merged into.
alter table clients add column merged_into uuid references clients(id) on delete set null;

-- Why the bounce happened, read from the bounce notice (src/lib/bounces.ts):
-- sender, blocklist, spam, missing, restricted, policy, full, temporary, other.
-- Set when the event arrives; the bounce_causes job fills in older ones.
alter table email_events add column bounce_cause text;
create index email_events_bounce_todo_idx on email_events (id) where kind = 'bounce' and bounce_cause is null;

-- Replies and bounces belong to their sending domain's client.
update email_events e set client_id = d.client_id
from domains d
where d.id = e.domain_id and d.client_id is not null and e.client_id is distinct from d.client_id;
