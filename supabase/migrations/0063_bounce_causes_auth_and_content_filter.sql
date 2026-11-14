-- Bounces are classified once, when they arrive. Two kinds were filed wrong:
-- Outlook's "Message lacks SPF/DKIM/DMARC Auth Records" (and "rejected per DMARC
-- policy") read as Policy instead of Sender DNS, and SpamAssassin content-filter
-- rejects read as Blocklist when a rule name such as URIBL_BLOCKED was listed.
-- Clearing their cause lets the bounce-causes job read them again with the new rules.
update email_events set bounce_cause = null
where kind = 'bounce'
  and bounce_cause in ('policy', 'blocklist')
  and (payload::text ilike '%lacks spf%' or payload::text ilike '%lacks dkim%' or payload::text ilike '%lacks dmarc%'
    or payload::text ilike '%spf/dkim/dmarc%' or payload::text ilike '%dmarc polic%'
    or payload::text ilike '%spamassassin%' or payload::text ilike '%content filter reject%');
