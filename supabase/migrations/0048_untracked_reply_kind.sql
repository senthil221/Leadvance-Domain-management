-- What an untracked reply is, from its subject and sender:
--   'reply'  a reply to one of our campaign emails. Every campaign subject
--            starts with "For …", so a reply's subject has "for" as the first
--            word or the first word after a "Re:", "RE:", "Fwd:", "AW:" or any
--            other "…:" prefix, in any case. Warm-up emails never do.
--   'bounce' a delivery failure notice (mailer-daemon, "Undeliverable: …"),
--            even when it quotes a "For …" subject.
--   'other'  everything else: warm-up traffic and stray mail.
-- Only replies go to the account managers' sheet; the page shows the rest apart.

create or replace function untracked_kind(subject text, sender_email text) returns text
language sql immutable as $$
  select case
    when coalesce(sender_email, '') ~* '^(mailer-daemon|mail-daemon|postmaster|mailerdaemon)@'
      or coalesce(subject, '') ~* '^\s*(undeliverable|undelivered|delivery status notification|delivery (has )?fail|mail delivery (failed|failure|system|subsystem)|returned mail|failure notice|message not delivered|non-?delivery)'
      then 'bounce'
    when coalesce(subject, '') ~* '(^|:)\s*for\M' then 'reply'
    else 'other'
  end
$$;

alter table untracked_replies add column kind text generated always as (untracked_kind(subject, sender_email)) stored;

create index untracked_replies_kind_idx on untracked_replies (kind, received_at desc) where handled_at is null;
