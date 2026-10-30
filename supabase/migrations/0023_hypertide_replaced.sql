-- Hypertide's replace-domain flow moves an order onto the new domain, so the
-- old domain drops out of the order list. Keep the names an order carried
-- before, so the weekly review can say the old domain was replaced (and by
-- what) rather than only that its inboxes are disconnected.
alter table hypertide_orders add column replaced_domains text[] not null default '{}';
create index hypertide_orders_replaced_idx on hypertide_orders using gin (replaced_domains);
