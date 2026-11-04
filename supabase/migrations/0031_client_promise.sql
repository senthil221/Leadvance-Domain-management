-- What each client was promised, so the sending can be held against it. Empty
-- until someone sets it: the number comes from the agreement, never a guess.
alter table clients add column promised_daily int check (promised_daily is null or promised_daily >= 0);
-- Promised days are Monday to Friday unless this client sends at weekends too.
alter table clients add column send_weekends boolean not null default false;

-- Bounces to read again with the corrected rules (mail loops, broken forwards,
-- relay refusals, sender domains that can't be resolved). Only those, so the job stays short.
update email_events set bounce_cause = null
where kind = 'bounce'
  and concat(payload->'bounce_message'->>'html', ' ', payload->'bounce_message'->>'text')
    ~* 'hop count exceeded|mail loop|misconfigured forwarding address|relay access denied|authentication required to relay|please turn on smtp authentication|disabled recipient address|domain of sender address|unresolvable';
