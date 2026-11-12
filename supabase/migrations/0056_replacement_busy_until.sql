-- Only one caller moves a replacement pair at a time: the worker, or a person
-- pressing Retry, Done, Skip, Approve payment, Add to campaigns, Swap or Cancel.
-- Each claims the pair by setting busy_until, and clears it when done. Two at
-- once could place a second Hypertide order or replacement request. A claim
-- left by a crash runs out on its own.
alter table replacement_items add column if not exists busy_until timestamptz;
