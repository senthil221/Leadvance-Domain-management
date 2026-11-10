import "server-only";
import { sql } from "@/lib/db";
import { SEEDS_SQL, type MxProvider } from "@/lib/placement-seeds";

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
  silentToControl: boolean;
  /** Test emails it has been sent. */
  tests: number;
};

/** Every seed, newest auto-reply first, with who receives its company's mail. */
export async function listSeeds(): Promise<SeedRow[]> {
  return sql.unsafe<SeedRow[]>(SEEDS_SQL);
}

/** When the placement-seeds job last finished, and how. */
export async function lastSeedSync() {
  const [row] = await sql<{ finishedAt: string | null; ok: boolean | null; error: string | null }[]>`
    select last_finished_at as finished_at, last_ok as ok, last_error as error
    from job_state where job = 'placement-seeds'`;
  return row ?? null;
}
