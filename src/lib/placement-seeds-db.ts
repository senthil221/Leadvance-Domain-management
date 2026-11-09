import "server-only";
import { sql } from "@/lib/db";
import type { MxProvider } from "@/lib/placement-seeds";

export type SeedRow = {
  email: string;
  domain: string;
  name: string | null;
  source: "reply" | "untracked";
  excerpt: string | null;
  forwards: boolean;
  firstReplyAt: string;
  lastReplyAt: string;
  autoReplies: number;
  campaignName: string | null;
  client: string | null;
  personRepliedAt: string | null;
  bouncedAt: string | null;
  provider: MxProvider | null;
  providerName: string | null;
  mxHost: string | null;
  checkedAt: string | null;
};

/** Every seed, newest auto-reply first, with who receives its company's mail. */
export async function listSeeds(): Promise<SeedRow[]> {
  return sql<SeedRow[]>`
    select s.email, s.domain, s.name, s.source, s.excerpt, s.forwards, s.first_reply_at, s.last_reply_at, s.auto_replies,
      s.campaign_name, c.name as client, s.person_replied_at, s.bounced_at,
      d.provider, d.provider_name, d.mx_host, d.checked_at
    from placement_seeds s
    left join placement_seed_domains d on d.domain = s.domain
    left join clients c on c.id = s.client_id
    order by s.last_reply_at desc
    limit 20000`;
}

/** When the placement-seeds job last finished, and how. */
export async function lastSeedSync() {
  const [row] = await sql<{ finishedAt: string | null; ok: boolean | null; error: string | null }[]>`
    select last_finished_at as finished_at, last_ok as ok, last_error as error
    from job_state where job = 'placement-seeds'`;
  return row ?? null;
}
