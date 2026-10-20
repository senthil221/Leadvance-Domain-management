import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { ClientsList, LifecycleForm } from "@/components/settings/SettingsForms";
import { CopyUrl, SyncPanel, type SyncJob } from "@/components/settings/SyncPanel";
import { Badge, PageHead, Skeleton } from "@/components/ui";
import { JOBS } from "@/jobs";
import { getCurrentUser } from "@/lib/auth";
import { summarize } from "@/lib/format";
import { getSettings, listClients, listJobState } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

const INTEGRATIONS = [
  { name: "Smartlead", env: ["SMARTLEAD_API_KEY"], use: "Inbox sync, warmup and limits, campaigns" },
  { name: "Porkbun", env: ["PORKBUN_API_KEY", "PORKBUN_SECRET_KEY"], use: "Imports your domains; reads and updates nameservers" },
  { name: "Unstoppable Domains", env: ["UNSTOPPABLE_API_KEY"], use: "Nameserver updates (reseller API)" },
  { name: "Hypertide", env: ["HYPERTIDE_API_KEY"], use: "Ordering inboxes, nameserver targets" },
];

export default function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" sub="Connections, lifecycle rules and clients" />
      <div className="page-body" style={{ maxWidth: 920 }}>
        <Suspense fallback={<div className="card"><div className="card-body flex flex-col gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={14} />)}</div></div>}>
          <SettingsContent />
        </Suspense>
      </div>
    </>
  );
}

async function SettingsContent() {
  await getCurrentUser();
  const [settings, clients, jobState] = await Promise.all([getSettings(), listClients(), listJobState()]);
  const dryRun = process.env.INTEGRATIONS_DRY_RUN !== "false";
  const token = process.env.SMARTLEAD_WEBHOOK_TOKEN;
  const webhookReady = Boolean(token);
  const host = process.env.APP_HOST ?? (await headers()).get("host") ?? "localhost:3000";
  const webhookUrl = `${host.startsWith("localhost") ? "http" : "https"}://${host}/api/webhooks/smartlead/${token ?? ""}`;
  const jobs: SyncJob[] = JOBS.map((j) => {
    const s = jobState.find((x) => x.job === j.name);
    return {
      name: j.name, label: j.label, everyMinutes: j.everyMinutes,
      lastFinishedAt: s?.lastFinishedAt ?? null, lastOk: s?.lastOk ?? null, lastError: s?.lastError ?? null,
      summary: summarize(s?.lastDetail),
    };
  });

  return (
    <>
      <section className="card" aria-labelledby="int-title">
        <div className="card-head">
          <h2 id="int-title" className="card-title">Connections</h2>
          {dryRun ? <Badge tone="warning">Dry run: calls are logged, not sent</Badge> : <Badge tone="success">Live</Badge>}
        </div>
        <div className="list">
          {INTEGRATIONS.map((i) => {
            const ok = i.env.every((k) => Boolean(process.env[k]));
            return (
              <div key={i.name} className="list-row">
                <span className={`dot tone-${ok ? "success" : "faint"}`} />
                <div className="list-main">
                  <span className="list-title">{i.name}</span>
                  <span className="list-meta">{i.use}</span>
                </div>
                <span className="list-meta max-w-[45%] text-right" style={{ whiteSpace: "normal" }}>{ok ? "Connected" : `Set ${i.env.join(" and ")} on the server`}</span>
              </div>
            );
          })}
          <div className="list-row">
            <span className={`dot tone-${webhookReady ? "success" : "faint"}`} />
            <div className="list-main">
              <span className="list-title">Smartlead webhook</span>
              <span className="list-meta">Point EMAIL_SENT, EMAIL_REPLY and EMAIL_BOUNCE here</span>
            </div>
            {webhookReady ? (
              <span className="flex items-center gap-2">
                <code className="mono hidden text-muted md:inline">/api/webhooks/smartlead/••••••••</code>
                <CopyUrl url={webhookUrl} />
              </span>
            ) : (
              <span className="list-meta max-w-[45%] text-right" style={{ whiteSpace: "normal" }}>Set SMARTLEAD_WEBHOOK_TOKEN on the server</span>
            )}
          </div>
        </div>
        <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-faint">
          API keys live only in the server&apos;s environment file and are never sent to the browser.
        </p>
      </section>

      <section className="card" aria-labelledby="sync-title">
        <div className="card-head">
          <h2 id="sync-title" className="card-title">Background sync</h2>
          <span className="card-sub">runs on the server every few minutes</span>
        </div>
        <SyncPanel jobs={jobs} />
      </section>

      <section className="card" aria-labelledby="life-title">
        <div className="card-head"><h2 id="life-title" className="card-title">Lifecycle</h2></div>
        <LifecycleForm drainDays={settings.drainDays} storageLowThreshold={settings.storageLowThreshold} hypertideNameservers={settings.hypertideNameservers} />
      </section>

      <section className="card" aria-labelledby="clients-title">
        <div className="card-head"><h2 id="clients-title" className="card-title">Clients</h2><span className="card-sub">{clients.length}</span></div>
        <ClientsList clients={clients} />
      </section>
    </>
  );
}
