import { sql } from "@/lib/db";
import type { SetupRow } from "@/lib/replacement-setups";

/** Replacement domains still being set up, or waiting for valid DNS to start warming, for Smartlead → Warming up. */
export async function listReplacementSetups() {
  return sql<SetupRow[]>`
    select nd.id as domain_id, nd.name as domain, nd.status, c.name as client_name, c.hue as client_hue,
      od.name as old_domain, nd.tags,
      ri.step_nameservers, ri.step_inboxes, ri.step_smartlead, ri.ht_operation, ri.last_error,
      (select count(*)::int from inboxes i where i.domain_id = nd.id and i.status = 'connected' and i.smartlead_account_id is not null) as inboxes,
      (select count(*)::int from inboxes i where i.domain_id = od.id and i.status <> 'removed') as expected,
      nd.dns_spf, nd.dns_dkim, nd.dns_dmarc, nd.dns_mx, nd.nameservers_answering as ns_answering,
      ri.created_at::text as started_at
    from replacement_items ri
    join replacement_batches rb on rb.id = ri.batch_id
    join domains nd on nd.id = ri.new_domain_id
    join domains od on od.id = ri.old_domain_id
    left join clients c on c.id = nd.client_id
    -- Open pairs, and finished ones still waiting for their warm-up (DNS not valid yet).
    where (ri.completed_at is null or ri.step_campaigns <> 'done') and rb.status <> 'cancelled'
      and nd.warmup_started_at is null and nd.status in ('provisioning', 'warming')
    order by ri.created_at desc, nd.name`;
}
