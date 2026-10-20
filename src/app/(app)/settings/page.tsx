import type { Metadata } from "next";
import { Suspense } from "react";
import { ClientsList, LifecycleForm } from "@/components/settings/SettingsForms";
import { Badge, PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getSettings, listClients } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

const INTEGRATIONS = [
  { name: "Smartlead", env: ["SMARTLEAD_API_KEY"], use: "Inbox sync, warmup and limits, campaigns" },
  { name: "Porkbun", env: ["PORKBUN_API_KEY", "PORKBUN_SECRET_KEY"], use: "Domain list and nameserver updates" },
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
  const [settings, clients] = await Promise.all([getSettings(), listClients()]);
  const dryRun = process.env.INTEGRATIONS_DRY_RUN !== "false";
  const webhookReady = Boolean(process.env.SMARTLEAD_WEBHOOK_TOKEN);

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
                <span className="list-meta">{ok ? "Connected" : `Set ${i.env.join(" and ")} on the server`}</span>
              </div>
            );
          })}
          <div className="list-row">
            <span className={`dot tone-${webhookReady ? "success" : "faint"}`} />
            <div className="list-main">
              <span className="list-title">Smartlead webhook</span>
              <span className="list-meta">Point EMAIL_SENT, EMAIL_REPLY and EMAIL_BOUNCE here</span>
            </div>
            <code className="mono text-muted">/api/webhooks/smartlead/{webhookReady ? "••••••••" : "<token>"}</code>
          </div>
        </div>
        <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-faint">
          API keys live only in the server&apos;s environment file and are never sent to the browser.
        </p>
      </section>

      <section className="card" aria-labelledby="life-title">
        <div className="card-head"><h2 id="life-title" className="card-title">Lifecycle</h2></div>
        <LifecycleForm drainDays={settings.drainDays} storageLowThreshold={settings.storageLowThreshold} />
      </section>

      <section className="card" aria-labelledby="clients-title">
        <div className="card-head"><h2 id="clients-title" className="card-title">Clients</h2><span className="card-sub">{clients.length}</span></div>
        <ClientsList clients={clients} />
      </section>
    </>
  );
}
