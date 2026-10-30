-- Sender bounces split in two: the tenant or mailbox (sender) and the sending
-- domain's DNS (dns). The bounce_causes job reads the old ones again.
update email_events set bounce_cause = null where kind = 'bounce' and bounce_cause = 'sender';
