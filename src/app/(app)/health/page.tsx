import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight } from "lucide-react";
import { RulesEditor } from "@/components/health/RulesEditor";
import { AttentionList } from "@/components/overview/AttentionList";
import { PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { listOpenAlerts, listRules } from "@/lib/queries";

export const metadata: Metadata = { title: "Health" };

export default function HealthPage() {
  return (
    <>
      <PageHead title="Settings" sub="Health rules: what flags a domain for replacement, and the domains they have flagged" />
      <div className="page-body">
        <Suspense fallback={<HealthSkeleton />}>
          <HealthContent />
        </Suspense>
      </div>
    </>
  );
}

async function HealthContent() {
  await getCurrentUser();
  const [rules, alerts] = await Promise.all([listRules(), listOpenAlerts()]);
  return (
    <>
      <RulesEditor rules={rules} />
      <section className="card" aria-labelledby="alerts-title">
        <div className="card-head">
          <h2 id="alerts-title" className="card-title">Open alerts</h2>
          <span className="card-sub">{alerts.length} on sending domains</span>
          <Link href="/inboxes?view=attention" className="card-link">Domains that need attention <ArrowRight size={13} strokeWidth={1.5} /></Link>
        </div>
        <AttentionList rows={alerts} />
      </section>
    </>
  );
}

function HealthSkeleton() {
  return (
    <>
      {[3, 6].map((n, k) => (
        <div key={k} className="card">
          <div className="card-head"><Skeleton w={100} h={12} /></div>
          <div className="card-body flex flex-col gap-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} h={14} />)}</div>
        </div>
      ))}
    </>
  );
}
