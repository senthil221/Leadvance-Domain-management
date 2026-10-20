-- Health rule evaluation. Runs on a schedule (and after each stats rollup):
-- opens an alert for every sending domain that breaks an enabled rule, keeps
-- the value on existing alerts current, wakes snoozed alerts whose snooze is
-- over, and resolves alerts whose domain has recovered or stopped sending.

create or replace function evaluate_health_rules()
returns table (opened integer, resolved integer)
language plpgsql as $$
declare
  r          health_rules;
  v_opened   integer := 0;
  v_resolved integer := 0;
  n          integer;
begin
  update alerts set status = 'open', snoozed_until = null
  where status = 'snoozed' and snoozed_until <= now();

  for r in select * from health_rules where enabled loop
    create temp table if not exists _hits (domain_id uuid primary key, value numeric) on commit drop;
    truncate _hits;

    insert into _hits (domain_id, value)
    select domain_id, value from (
      select
        d.id as domain_id,
        coalesce(sum(s.sent), 0) as sent,
        case r.metric
          when 'bounce_rate'       then case when sum(s.sent) > 0 then 100.0 * sum(s.bounces) / sum(s.sent) end
          when 'reply_rate'        then case when sum(s.sent) > 0 then 100.0 * sum(s.replies) / sum(s.sent) end
          when 'human_reply_rate'  then case when sum(s.sent) > 0 then 100.0 * sum(s.human_replies) / sum(s.sent) end
          when 'human_replies'     then coalesce(sum(s.human_replies), 0)
          when 'bounces'           then coalesce(sum(s.bounces), 0)
          when 'warmup_reputation' then (
            select ds.warmup_reputation from domain_daily_stats ds
            where ds.domain_id = d.id and ds.warmup_reputation is not null
            order by ds.day desc limit 1)
        end as value
      from domains d
      left join domain_daily_stats s on s.domain_id = d.id and s.day > current_date - r.window_days
      where d.status in ('active', 'warming')
      group by d.id
    ) m
    where m.sent >= r.min_sent
      and m.value is not null
      and case r.comparison
            when 'gt'  then m.value >  r.threshold
            when 'gte' then m.value >= r.threshold
            when 'lt'  then m.value <  r.threshold
            when 'lte' then m.value <= r.threshold
            else            m.value =  r.threshold
          end;

    update alerts a set value = round(h.value, 2)
    from _hits h
    where a.rule_id = r.id and a.domain_id = h.domain_id and a.status <> 'resolved';

    insert into alerts (domain_id, rule_id, value)
    select h.domain_id, r.id, round(h.value, 2) from _hits h
    where not exists (
      select 1 from alerts a where a.rule_id = r.id and a.domain_id = h.domain_id and a.status <> 'resolved');
    get diagnostics n = row_count;
    v_opened := v_opened + n;

    update alerts a set status = 'resolved', resolved_at = now(), note = coalesce(a.note, 'recovered')
    where a.rule_id = r.id and a.status <> 'resolved'
      and not exists (select 1 from _hits h where h.domain_id = a.domain_id);
    get diagnostics n = row_count;
    v_resolved := v_resolved + n;
  end loop;

  -- Alerts on domains that are no longer sending (replaced, burned) close too.
  update alerts a set status = 'resolved', resolved_at = now(), note = coalesce(a.note, 'domain no longer sending')
  from domains d
  where d.id = a.domain_id and a.status <> 'resolved' and d.status not in ('active', 'warming');
  get diagnostics n = row_count;
  v_resolved := v_resolved + n;

  return query select v_opened, v_resolved;
end $$;

insert into health_rules (name, metric, comparison, threshold, min_sent, window_days, severity) values
  ('High bounce rate',      'bounce_rate',       'gt', 3,  100, 7,  'critical'),
  ('No human replies',      'human_replies',     'eq', 0,  500, 14, 'warning'),
  ('Low warmup reputation', 'warmup_reputation', 'lt', 90, 0,   7,  'warning');
