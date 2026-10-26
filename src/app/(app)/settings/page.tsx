import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { ClientSourcePicker, SenderMap, TagMap } from "@/components/settings/ClientAssignment";
import { ClientsList, HypertideOrderForm, LifecycleForm, WarmupProgramForm } from "@/components/settings/SettingsForms";
import { Panel, SettingsShell } from "@/components/settings/SettingsShell";
import { CopyUrl, SyncPanel, type SyncJob } from "@/components/settings/SyncPanel";
import { Badge, PageHead, Skeleton } from "@/components/ui";
import { JOBS } from "@/jobs";
import { getCurrentUser } from "@/lib/auth";
import { summarize } from "@/lib/format";
import { getSettings, listClients, listJobState, listSenders, listTags } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

const INTEGRATIONS = [
  { name: "Smartlead", env: ["SMARTLEAD_API_KEY"], use: "Inbox sync, warmup and limits, campaigns" },
  { name: "Porkbun", env: ["PORKBUN_API_KEY", "PORKBUN_SECRET_KEY"], use: "Imports your domains; reads and updates nameservers" },
  { name: "Unstoppable Domains", env: ["UNSTOPPABLE_API_KEY"], use: "Nameserver updates (reseller API)" },
  { name: "Hypertide", env: ["HYPERTIDE_API_KEY"], use: "Nameserver pairs, ordering inboxes, order status" },
  { name: "Smartlead login for Hypertide", env: ["HYPERTIDE_SMARTLEAD_USERNAME", "HYPERTIDE_SMARTLEAD_PASSWORD"], use: "Hypertide uses it to connect new inboxes to Smartlead" },
  { name: "Smartlead Microsoft OAuth link", env: ["HYPERTIDE_SMARTLEAD_OAUTH_LINK"], use: "Needed for Microsoft (Entra) orders" },
];

export default function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" sub="Connections, warm-up, clients and lifecycle rules" />
      <div className="page-body" style={{ maxWidth: 1180 }}>
        <Suspense fallback={<div className="card"><div className="card-body flex flex-col gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={14} />)}</div></div>}>
          <SettingsContent />
        </Suspense>
      </div>
    </>
  );
}

async function SettingsContent() {
  await getCurrentUser();
  const [settings, clients, jobState, tags, senders] = await Promise.all([getSettings(), listClients(), listJobState(), listTags(), listSenders()]);
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

  const unmappedSenders = senders.filter((x) => !x.clientId).length;

  return (
    <SettingsShell sections={[
      {
        key: "connections", label: "Connections", title: "Connections", sub: "The services this app talks to. Keys live only in the server's environment file and never reach the browser.",
        badge: dryRun ? <span className="st-dot tone-warning" title="Dry run" /> : null,
        content: (
          <>
            <div className={`st-banner ${dryRun ? "tone-warning" : "tone-success"}`}>
              <span className="st-banner-dot" />
              <span className="flex flex-col"><span className="strong">{dryRun ? "Dry run" : "Live"}</span>
                <span className="st-panel-sub">{dryRun ? "Calls to Smartlead, Porkbun and Hypertide are logged, not sent." : "Changes are sent to Smartlead, Porkbun and Hypertide."}</span></span>
            </div>
            <Panel title="Services" flush>
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
                      {ok ? <Badge tone="success">Connected</Badge> : <span className="list-meta max-w-[45%] text-right" style={{ whiteSpace: "normal" }}>Set {i.env.join(" and ")} on the server</span>}
                    </div>
                  );
                })}
              </div>
            </Panel>
            <Panel title="Smartlead webhook" sub="Point EMAIL_SENT, EMAIL_REPLY and EMAIL_BOUNCE here so sends, replies and bounces are counted."
              aside={webhookReady ? <span className="flex items-center gap-2"><code className="mono hidden text-muted md:inline">/api/webhooks/smartlead/••••••••</code><CopyUrl url={webhookUrl} /></span> : <Badge tone="warning">Set SMARTLEAD_WEBHOOK_TOKEN</Badge>}>
              <span className="field-hint">The address carries a secret token, so copy it from here instead of typing it.</span>
            </Panel>
          </>
        ),
      },
      {
        key: "sync", label: "Background sync", title: "Background sync", sub: "Jobs that run on the server every few minutes. Run one now to pick up a change straight away.",
        badge: jobs.some((j) => j.lastOk === false) ? <span className="st-dot tone-danger" title="A job failed" /> : null,
        content: <Panel title="Jobs" flush><SyncPanel jobs={jobs} /></Panel>,
      },
      {
        key: "warmup", label: "Warming up", title: "Warming up", sub: "New domains that connect to Smartlead show under Smartlead → Warming up and warm up for the days set here.",
        badge: settings.warmupProgram.enabled ? <span className="st-dot tone-success" title="Automatic" /> : null,
        content: <Panel title="Warm-up programme" flush><WarmupProgramForm program={settings.warmupProgram} /></Panel>,
      },
      {
        key: "clients", label: "Clients", title: "Clients", sub: "Which client each domain belongs to. Smartlead tags decide first; sender names fill in every domain no tag decides.",
        badge: unmappedSenders ? <span className="st-nav-count">{unmappedSenders}</span> : null,
        content: (
          <>
            <Panel title="How tags decide the client"><ClientSourcePicker source={settings.clientSource} /></Panel>
            <Panel title="Sender names" sub="The From name on each inbox. Pick a client per name, or copy the list, fill in the clients and paste it back." flush>
              <SenderMap senders={senders} clients={clients} />
            </Panel>
            <Panel title="Smartlead tags" sub={settings.clientSource === "mapped" ? "Only these tags decide the client. Several tags can belong to one client." : undefined} flush={settings.clientSource === "mapped"}>
              <TagMap source={settings.clientSource} clients={clients} tags={tags} savedList={settings.clientTagList} />
            </Panel>
            <Panel title="Clients" sub={`${clients.length} active`} flush><ClientsList clients={clients} /></Panel>
          </>
        ),
      },
      {
        key: "lifecycle", label: "Lifecycle & orders", title: "Lifecycle and orders", sub: "How long replaced domains drain, when storage runs low, and how Hypertide orders replacement inboxes.",
        content: (
          <>
            <Panel title="Lifecycle" flush><LifecycleForm drainDays={settings.drainDays} storageLowThreshold={settings.storageLowThreshold} hypertideNameservers={settings.hypertideNameservers} /></Panel>
            <Panel title="Hypertide orders" sub="Used when a replacement orders inboxes" flush><HypertideOrderForm template={settings.hypertideTemplate} /></Panel>
          </>
        ),
      },
    ]} />
  );
}
