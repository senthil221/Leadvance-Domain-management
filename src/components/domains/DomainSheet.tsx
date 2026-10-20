"use client";

import { Dialog, Tabs } from "radix-ui";
import { ArrowLeftRight, ArrowRight, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { loadDomainDetail } from "@/app/actions";
import { Badge, ClientCell, Dot, Metric, Skeleton, StatusDot } from "@/components/ui";
import { ago, daysSince, int, shortDate } from "@/lib/format";
import type { DomainDetail } from "@/lib/queries";
import { REPLACEMENT_REASONS, STATUS_META } from "@/lib/status";

export function DomainSheet({
  domainId,
  onClose,
  onOpenDomain,
  onReplace,
  reloadKey,
}: {
  domainId: string | null;
  onClose: () => void;
  onOpenDomain: (id: string) => void;
  onReplace: (d: DomainDetail["domain"]) => void;
  reloadKey: number;
}) {
  const [detail, setDetail] = useState<{ id: string; data: DomainDetail | null } | null>(null);

  useEffect(() => {
    if (!domainId) return;
    let live = true;
    loadDomainDetail(domainId).then((data) => live && setDetail({ id: domainId, data }));
    return () => { live = false; };
  }, [domainId, reloadKey]);

  const loading = !detail || detail.id !== domainId;
  const d = loading ? null : detail.data;

  return (
    <Dialog.Root open={domainId !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" style={{ background: "transparent", backdropFilter: "none" }} />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <div className="sheet-head">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Dialog.Title className="sheet-title truncate">{d?.domain.name ?? (loading ? <Skeleton w={200} h={18} /> : "Not found")}</Dialog.Title>
              {d ? (
                <div className="flex flex-wrap items-center gap-3">
                  <StatusDot status={d.domain.status} />
                  <ClientCell name={d.domain.clientName} hue={d.domain.clientHue} />
                  {d.domain.openAlerts > 0 ? <Badge tone="warning">{d.domain.openAlerts} alert{d.domain.openAlerts === 1 ? "" : "s"}</Badge> : null}
                </div>
              ) : null}
            </div>
            {d && (d.domain.status === "active" || d.domain.status === "warming") && !d.lineage.replacedBy ? (
              <button type="button" className="btn btn-sm" onClick={() => onReplace(d.domain)}>
                <ArrowLeftRight size={14} strokeWidth={1.5} /> Replace
              </button>
            ) : null}
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
            </Dialog.Close>
          </div>

          {loading ? (
            <div className="sheet-body">
              {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={14} w={`${60 + ((i * 13) % 40)}%`} />)}
            </div>
          ) : !d ? (
            <div className="sheet-body"><p className="zero">This domain no longer exists.</p></div>
          ) : (
            <Tabs.Root defaultValue="overview" className="sheet-body" style={{ paddingTop: 0 }}>
              <Tabs.List className="tabs-list" aria-label="Domain details">
                <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
                <Tabs.Trigger value="inboxes">Inboxes <span className="zero num">{d.inboxes.length}</span></Tabs.Trigger>
                <Tabs.Trigger value="stats">Stats</Tabs.Trigger>
                <Tabs.Trigger value="history">History</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="overview" className="flex flex-col gap-5">
                <div className="stats" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
                  <div className="stat"><span className="stat-label">Sent · 7d</span><span className="stat-value" style={{ fontSize: 20 }}>{int(d.domain.sent)}</span></div>
                  <div className="stat"><span className="stat-label">Human replies</span><span className="stat-value" style={{ fontSize: 20 }}><Metric value={d.domain.humanReplyRate} digits={2} /></span><span className="stat-foot">{int(d.domain.humanReplies)} replies</span></div>
                  <div className="stat"><span className="stat-label">Bounce rate</span><span className="stat-value" style={{ fontSize: 20 }}><Metric value={d.domain.bounceRate} warn={2} bad={3} /></span><span className="stat-foot">{int(d.domain.bounces)} bounces</span></div>
                </div>

                {d.domain.sl7Sent != null ? (
                  <p className="text-[12.5px] text-muted">
                    Smartlead reports <span className="num text-ink">{int(d.domain.sl7Sent)}</span> sent,{" "}
                    <span className="num text-ink">{int(d.domain.sl7Replies)}</span> replies and{" "}
                    <span className="num text-ink">{int(d.domain.sl7Bounces)}</span> bounces over the last 7 days
                    {d.domain.sent ? (Math.abs(d.domain.sent - d.domain.sl7Sent) > Math.max(20, d.domain.sl7Sent * 0.1)
                      ? <span className="text-warning-ink">; that differs from the app&apos;s {int(d.domain.sent)} sent</span>
                      : "; it matches the app's count") : "."}
                  </p>
                ) : null}

                {d.alerts.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {d.alerts.map((a) => (
                      <div key={a.id} className={`callout tone-${a.severity === "critical" ? "danger" : "warning"}`}>
                        <Dot tone={a.severity === "critical" ? "danger" : "warning"} />
                        <span>{a.ruleName}{a.value != null ? ` · ${a.metric.endsWith("_rate") ? `${a.value.toFixed(1)}%` : a.value}` : ""} · since {ago(a.openedAt)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {d.lineage.replaced || d.lineage.replacedBy ? (
                  <div className="card">
                    <div className="card-head"><span className="card-title">Lineage</span></div>
                    <div className="card-body flex flex-col gap-3">
                      {d.lineage.replaced ? (
                        <LineageRow label="Replaced" link={d.lineage.replaced} self={d.domain.name} direction="in" onOpen={onOpenDomain} />
                      ) : null}
                      {d.lineage.replacedBy ? (
                        <LineageRow label="Replaced by" link={d.lineage.replacedBy} self={d.domain.name} direction="out" onOpen={onOpenDomain} />
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <dl className="kv">
                  <dt>Registrar</dt><dd>{d.domain.registrar ?? "—"}</dd>
                  <dt>Inbox provider</dt><dd>{d.domain.inboxProvider ?? "—"}</dd>
                  <dt>Nameservers</dt>
                  <dd className="flex flex-col">
                    {d.domain.nameservers.length ? d.domain.nameservers.map((ns) => <span key={ns} className="mono">{ns}</span>) : "—"}
                    {d.domain.nameserversCheckedAt ? <span className="text-[12px] text-faint">checked {ago(d.domain.nameserversCheckedAt)}</span> : null}
                  </dd>
                  <dt>Active since</dt>
                  <dd>{d.domain.activeSince ? `${shortDate(d.domain.activeSince)} · ${daysSince(d.domain.activeSince)} days` : "—"}</dd>
                  {d.domain.drainingSince ? (<><dt>Draining since</dt><dd>{shortDate(d.domain.drainingSince)}</dd></>) : null}
                  {d.domain.burnedAt ? (<><dt>Retired</dt><dd>{shortDate(d.domain.burnedAt)}</dd></>) : null}
                  <dt>Purchased</dt><dd>{shortDate(d.domain.purchasedAt)}</dd>
                  <dt>Renews</dt>
                  <dd>
                    {shortDate(d.domain.expiresAt)}
                    {d.domain.autoRenew != null ? <span className="text-muted"> · auto-renew {d.domain.autoRenew ? "on" : "off"}</span> : null}
                  </dd>
                  {d.domain.registrar === "Porkbun" && d.domain.registrarApiAccess != null ? (
                    <>
                      <dt>Porkbun API access</dt>
                      <dd>
                        {d.domain.registrarApiAccess ? "On" : <span className="text-warning-ink">Off: turn it on at Porkbun so nameservers can be changed from here</span>}
                      </dd>
                    </>
                  ) : null}
                  <dt>Cost</dt><dd>{d.domain.costCents != null ? `$${(d.domain.costCents / 100).toFixed(2)} / yr` : "—"}</dd>
                  {d.domain.notes ? (<><dt>Notes</dt><dd>{d.domain.notes}</dd></>) : null}
                </dl>
              </Tabs.Content>

              <Tabs.Content value="inboxes">
                {d.inboxes.length === 0 ? (
                  <p className="zero">No inboxes yet. They are created during setup.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr><th>Inbox</th><th className="is-num">Warmup / day</th><th className="is-num">Daily limit</th><th className="is-num">Reputation</th></tr>
                      </thead>
                      <tbody>
                        {d.inboxes.map((i) => (
                          <tr key={i.id}>
                            <td>
                              <div className="flex flex-col py-1.5 leading-tight">
                                <button type="button" className="strong flex items-center gap-1.5 text-left hover:underline" title="Copy address"
                                  onClick={() => { navigator.clipboard?.writeText(i.email); toast("Copied", { description: i.email }); }}>
                                  {i.email} <Copy size={11} className="text-faint" />
                                </button>
                                <span className="text-[12px] text-faint">{i.senderName ?? "—"} · {i.status}{i.lastSyncedAt ? ` · synced ${ago(i.lastSyncedAt)}` : ""}</span>
                              </div>
                            </td>
                            <td className="is-num">{i.warmupEnabled ? int(i.warmupPerDay) : <span className="zero">off</span>}</td>
                            <td className="is-num">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td>
                            <td className="is-num"><Metric value={i.warmupReputation} warn={95} bad={90} invert digits={0} suffix="" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Tabs.Content>

              <Tabs.Content value="stats" className="flex flex-col gap-4">
                <DailyChart daily={d.daily} />
                <div className="fleet-legend">
                  <span><span className="dot" style={{ background: "var(--surface-4)" }} />Sent</span>
                  <span><span className="dot tone-success" />Human replies</span>
                  <span><span className="dot tone-danger" />Bounces</span>
                </div>
                <dl className="kv">
                  <dt>30-day sent</dt><dd className="num">{int(d.daily.reduce((a, x) => a + x.sent, 0))}</dd>
                  <dt>30-day human replies</dt><dd className="num">{int(d.daily.reduce((a, x) => a + x.humanReplies, 0))}</dd>
                  <dt>30-day out of office</dt><dd className="num">{int(d.daily.reduce((a, x) => a + x.ooo, 0))}</dd>
                  <dt>30-day bounces</dt><dd className="num">{int(d.daily.reduce((a, x) => a + x.bounces, 0))}</dd>
                  <dt>Warmup reputation</dt><dd className="num">{d.domain.warmupReputation ?? "—"}</dd>
                </dl>
              </Tabs.Content>

              <Tabs.Content value="history">
                <div className="timeline">
                  {d.history.map((h) => (
                    <div key={h.id} className="timeline-item">
                      <Dot tone={STATUS_META[h.toStatus].tone} />
                      <div className="timeline-main">
                        <p className="timeline-title">
                          {h.fromStatus ? <>Moved to <b className="font-medium">{STATUS_META[h.toStatus].label}</b></> : "Added to inventory"}
                          {h.forced ? <> <Badge tone="warning">override</Badge></> : null}
                        </p>
                        {h.reason && h.fromStatus ? <p className="text-muted">{h.reason}</p> : null}
                        <p className="timeline-meta">{h.actor} · {shortDate(h.at)} · {ago(h.at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Tabs.Content>
            </Tabs.Root>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LineageRow({ label, link, self, direction, onOpen }: {
  label: string;
  link: NonNullable<DomainDetail["lineage"]["replaced"]>;
  self: string;
  direction: "in" | "out";
  onOpen: (id: string) => void;
}) {
  const other = (
    <button type="button" className="strong text-ink hover:underline" onClick={() => onOpen(link.domainId)}>{link.name}</button>
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="w-20 text-muted">{label}</span>
        {direction === "in" ? <>{other}<ArrowRight size={13} className="text-faint" /><span>{self}</span></> : <><span>{self}</span><ArrowRight size={13} className="text-faint" />{other}</>}
      </div>
      <p className="pl-[88px] text-[12px] text-faint">
        {REPLACEMENT_REASONS[link.reason]}{link.note ? ` · ${link.note}` : ""} · {shortDate(link.at)}
      </p>
    </div>
  );
}

function DailyChart({ daily }: { daily: DomainDetail["daily"] }) {
  const W = 500, H = 140, pad = 18;
  const max = Math.max(10, ...daily.map((d) => d.sent));
  const bw = (W - pad) / daily.length;
  const y = (v: number) => H - pad - (v / max) * (H - pad - 6);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily sent, human replies and bounces, last 30 days">
      {[0.5, 1].map((t) => (
        <g key={t}>
          <line className="grid" x1={pad} x2={W} y1={y(max * t)} y2={y(max * t)} />
          <text className="axis" x={0} y={y(max * t) + 3}>{Math.round(max * t)}</text>
        </g>
      ))}
      {daily.map((d, i) => {
        const x = pad + i * bw + 1;
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${d.sent} sent, ${d.humanReplies} human, ${d.bounces} bounced`}</title>
            <rect className="bar" x={x} y={y(d.sent)} width={bw - 2} height={H - pad - y(d.sent)} rx={1.5} />
            {d.bounces > 0 ? <rect className="bar-bounce" x={x} y={y(d.bounces)} width={bw - 2} height={H - pad - y(d.bounces)} rx={1.5} /> : null}
            {d.humanReplies > 0 ? <circle className="bar-human" cx={x + (bw - 2) / 2} cy={y(d.sent) - 5} r={2.5} /> : null}
          </g>
        );
      })}
      <text className="axis" x={pad} y={H - 3}>{daily[0]?.day.slice(5)}</text>
      <text className="axis" x={W} y={H - 3} textAnchor="end">today</text>
    </svg>
  );
}
