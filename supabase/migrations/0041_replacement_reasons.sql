-- A replacement can have more than one reason (high bounces and low replies, say).
-- `reason` stays: it holds the first reason picked, so everything that reads it
-- keeps working. `reasons` holds every reason picked, in the order picked.

alter table replacement_batches add column if not exists reasons replacement_reason[] not null default '{}';

update replacement_batches set reasons = array[reason] where reasons = '{}';

comment on column replacement_batches.reasons is 'Every reason picked for the replacement; reason is the first of them.';
