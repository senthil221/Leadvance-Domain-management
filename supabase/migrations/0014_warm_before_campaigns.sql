-- New inboxes from a replacement warm up first: by default a replacement no
-- longer adds them to campaigns. It finishes once they're in Smartlead and the
-- new domain stays Warming until someone adds it to campaigns from Replacements.
alter table replacement_batches alter column add_to_campaigns set default false;

-- When the inboxes were added to campaigns later (null while warming).
alter table replacement_items add column campaigns_added_at timestamptz;

-- Replacements waiting on a person to add campaigns they chose not to add
-- move on: the runner now skips that step for them.
update replacement_items ri set step_campaigns = 'pending', note = null
from replacement_batches rb
where rb.id = ri.batch_id and not rb.add_to_campaigns and ri.step_campaigns = 'manual' and ri.completed_at is null;
