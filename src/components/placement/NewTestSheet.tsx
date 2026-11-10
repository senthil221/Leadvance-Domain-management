"use client";

import { Dialog } from "radix-ui";
import { AlertTriangle, FlaskConical, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { createPlacementTest, loadPlacementCopy } from "@/app/actions";
import { Select } from "@/components/Select";
import { int } from "@/lib/format";
import { DEFAULTS, NEUTRAL, SEED_PER_WEEK, unknownVariables } from "@/lib/placement-tests";
import type { TestCandidate } from "@/lib/placement-tests-db";

type Copy = { sourceCampaignId: number | null; subject: string; body: string; loading: boolean; error: string | null };
const NO_CLIENT = "none";
const keyOf = (c: { clientId: string | null }) => c.clientId ?? NO_CLIENT;
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—");

/** The healthiest domain of a client to measure the others against: not on the Replace list, two inboxes, enough mail, best reply rate. */
function autoControl(candidates: TestCandidate[], clientKey: string, taken: Set<string>) {
  const pool = candidates.filter((c) => keyOf(c) === clientKey && !taken.has(c.id) && !c.inTest);
  const rate = (c: TestCandidate) => (c.sent14 ? c.replies14 / c.sent14 : 0);
  const good = pool.filter((c) => !c.call && c.inboxes >= 2 && c.sent14 >= 100).sort((a, b) => rate(b) - rate(a));
  return (good[0] ?? pool.filter((c) => !c.call).sort((a, b) => rate(b) - rate(a))[0] ?? null)?.id ?? null;
}

export function NewTestSheet({ open, onClose, candidates, readySeeds, saturday, timezone, initial }: {
  open: boolean;
  onClose: () => void;
  candidates: TestCandidate[];
  readySeeds: number;
  /** Next Saturday 09:00 in the stats timezone, ISO. */
  saturday: string;
  timezone: string;
  initial: string[];
}) {
  const byId = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);
  const [picked, setPicked] = useState<string[]>(() => initial.filter((id) => byId.get(id) && !byId.get(id)!.inTest));
  const [q, setQ] = useState("");
  const [controls, setControls] = useState<Record<string, string | null>>({});
  const [copies, setCopies] = useState<Record<string, Copy>>({});
  const [neutral, setNeutral] = useState({ ...NEUTRAL });
  const [seeds, setSeeds] = useState(DEFAULTS.seedsPerCampaign);
  const [perDomain, setPerDomain] = useState(DEFAULTS.inboxesPerDomain);
  const [start, setStart] = useState<"saturday" | "now">("saturday");
  const [pending, run] = useTransition();

  const pickedSet = new Set(picked);
  const groups = useMemo(() => {
    const m = new Map<string, TestCandidate[]>();
    for (const id of picked) {
      const c = byId.get(id);
      if (!c) continue;
      m.set(keyOf(c), [...(m.get(keyOf(c)) ?? []), c]);
    }
    return [...m].map(([key, domains]) => {
      // The campaigns these domains send in, the one most of their inboxes are in first.
      const counts = new Map<number, { id: number; name: string; inboxes: number }>();
      for (const d of domains) for (const c of d.campaigns) {
        const was = counts.get(c.id);
        counts.set(c.id, { ...c, inboxes: (was?.inboxes ?? 0) + c.inboxes });
      }
      return { key, client: domains[0].client ?? "No client", domains, campaigns: [...counts.values()].sort((a, b) => b.inboxes - a.inboxes) };
    });
  }, [picked, byId]);

  const controlOf = (key: string) => (key in controls ? controls[key] : autoControl(candidates, key, pickedSet));
  const copyOf = (key: string): Copy => copies[key] ?? { sourceCampaignId: null, subject: "", body: "", loading: false, error: null };

  // Load each client's real copy from its main campaign the first time the client shows up.
  useEffect(() => {
    for (const g of groups) {
      if (copies[g.key] || !g.campaigns[0]) continue;
      void pickSource(g.key, g.campaigns[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  async function pickSource(key: string, campaignId: number | null) {
    setCopies((c) => ({ ...c, [key]: { ...copyOf(key), sourceCampaignId: campaignId, loading: campaignId !== null, error: null } }));
    if (campaignId === null) return;
    const r = await loadPlacementCopy(campaignId);
    setCopies((c) => ({
      ...c,
      [key]: r.ok
        ? { sourceCampaignId: campaignId, subject: r.data.subject, body: r.data.body, loading: false, error: null }
        : { ...(c[key] ?? copyOf(key)), loading: false, error: r.error },
    }));
  }

  const controlIds = [...new Set(groups.map((g) => controlOf(g.key)).filter((x): x is string => !!x))];
  const campaigns = (picked.length + controlIds.length) * 2;
  const emails = campaigns * seeds;
  const missingControl = groups.filter((g) => !controlOf(g.key));
  const missingCopy = groups.filter((g) => { const c = copyOf(g.key); return c.loading || !c.subject.trim() || !c.body.trim(); });
  const tooMany = emails > readySeeds * SEED_PER_WEEK;
  const ready = picked.length > 0 && !missingControl.length && !missingCopy.length && neutral.subject.trim() && neutral.body.trim() && !pending;

  const needle = q.trim().toLowerCase();
  const list = candidates.filter((c) => !needle || c.name.includes(needle) || (c.client ?? "").toLowerCase().includes(needle));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const startLabel = new Date(saturday).toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone });

  const submit = () => run(async () => {
    const r = await createPlacementTest({
      groups: groups.map((g) => {
        const c = copyOf(g.key);
        return { domainIds: g.domains.map((d) => d.id), controlDomainId: controlOf(g.key)!, sales: { subject: c.subject, body: c.body, sourceCampaignId: c.sourceCampaignId } };
      }),
      neutral, seedsPerCampaign: seeds, inboxesPerDomain: perDomain,
      startsAt: start === "now" ? new Date().toISOString() : saturday,
    });
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Test saved: ${int(r.data.campaigns)} campaigns and ${int(r.data.emails)} emails. They're being set up in Smartlead now`);
    onClose();
  });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" style={{ width: "min(720px, calc(100vw - 16px))" }} aria-describedby={undefined}>
          <div className="sheet-head">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className="sheet-title">New placement test</Dialog.Title>
              <span className="field-hint">
                Each domain sends its client&apos;s real first email and a short neutral note to {seeds} seeds each, next to a control domain.
                Auto-replies {start === "now" ? "start coming back within hours" : "come back over the weekend"}.
              </span>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
            </Dialog.Close>
          </div>

          <div className="sheet-body">
            <section className="field">
              <span className="field-label">Domains to test {picked.length ? <span className="zero">· {picked.length} picked</span> : null}</span>
              <label className="search-input">
                <Search size={14} strokeWidth={1.5} />
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domains or clients" aria-label="Search domains" />
              </label>
              <div className="pt-pick" role="listbox" aria-multiselectable aria-label="Domains">
                {list.length ? list.map((c) => {
                  const isControl = controlIds.includes(c.id);
                  return (
                    <label key={c.id} className="pt-pick-row" data-on={pickedSet.has(c.id)} aria-disabled={c.inTest || isControl}>
                      <input type="checkbox" className="checkbox" checked={pickedSet.has(c.id)} disabled={c.inTest || isControl} onChange={() => toggle(c.id)} />
                      <span className="pt-pick-name">{c.name}</span>
                      <span className="pt-pick-meta">{c.client ?? "No client"}</span>
                      <span className="pt-pick-meta num" title="Replies in the last 14 days">{pct(c.replies14, c.sent14)}</span>
                      <span className="pt-pick-meta num">{c.inboxes} inbox{c.inboxes === 1 ? "" : "es"}</span>
                      {c.inTest ? <span className="badge">In a test</span> : isControl ? <span className="badge">Control</span>
                        : c.call ? <span className={`badge tone-${c.callTone}`}>{c.call}</span> : <span />}
                    </label>
                  );
                }) : <p className="zero" style={{ padding: 10 }}>No domain matches.</p>}
              </div>
            </section>

            {groups.map((g) => {
              const copy = copyOf(g.key);
              const control = controlOf(g.key);
              const vars = unknownVariables(`${copy.subject} ${copy.body}`);
              const controlChoices = candidates.filter((c) => !pickedSet.has(c.id) && !c.inTest && (keyOf(c) === g.key || c.id === control));
              return (
                <section key={g.key} className="pt-group">
                  <div className="pt-group-head">
                    <b>{g.client}</b>
                    <span className="zero">{g.domains.map((d) => d.name).join(", ")}</span>
                  </div>
                  <div className="pt-grid">
                    <label className="field">
                      <span className="field-label">Control</span>
                      <Select className="select" value={control ?? ""} onChange={(e) => setControls((c) => ({ ...c, [g.key]: e.target.value || null }))} aria-label={`Control for ${g.client}`}>
                        <option value="">Pick a control…</option>
                        {controlChoices.map((c) => (
                          <option key={c.id} value={c.id}>{c.name} · {pct(c.replies14, c.sent14)} replies{c.call ? ` · ${c.call}` : ""}</option>
                        ))}
                      </Select>
                      <span className="field-hint">A domain of this client that&apos;s known to land, not on the Replace list.</span>
                    </label>
                    <label className="field">
                      <span className="field-label">Real copy from</span>
                      <Select className="select" value={copy.sourceCampaignId ?? ""} onChange={(e) => void pickSource(g.key, e.target.value ? Number(e.target.value) : null)} aria-label={`Copy for ${g.client}`}>
                        <option value="">Paste my own</option>
                        {g.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                      <span className="field-hint">{copy.loading ? "Loading the first email from Smartlead…" : copy.error ?? "Step 1 of the campaign. Its tracking and unsubscribe settings are copied too."}</span>
                    </label>
                  </div>
                  <label className="field">
                    <span className="field-label">Subject</span>
                    <input className="input" value={copy.subject} disabled={copy.loading}
                      onChange={(e) => setCopies((c) => ({ ...c, [g.key]: { ...copyOf(g.key), subject: e.target.value } }))} />
                  </label>
                  <label className="field">
                    <span className="field-label">Email</span>
                    <textarea className="textarea" rows={7} value={copy.body} disabled={copy.loading}
                      onChange={(e) => setCopies((c) => ({ ...c, [g.key]: { ...copyOf(g.key), body: e.target.value } }))} />
                    {vars.length ? (
                      <span className="field-hint flex items-start gap-1.5" style={{ color: "var(--warning-ink)" }}>
                        <AlertTriangle size={13} className="mt-0.5 flex-none" />
                        Seeds have only a first name and company, so {vars.map((v) => `{{${v}}}`).join(", ")} will go out empty. Edit them out if that reads badly.
                      </span>
                    ) : null}
                  </label>
                </section>
              );
            })}

            {picked.length ? (
              <section className="pt-group">
                <div className="pt-group-head"><b>Neutral note</b><span className="zero">Sent by every domain, to show whether the domain lands when the copy isn&apos;t the issue</span></div>
                <label className="field">
                  <span className="field-label">Subject</span>
                  <input className="input" value={neutral.subject} onChange={(e) => setNeutral((n) => ({ ...n, subject: e.target.value }))} />
                </label>
                <label className="field">
                  <span className="field-label">Email</span>
                  <textarea className="textarea" rows={5} value={neutral.body} onChange={(e) => setNeutral((n) => ({ ...n, body: e.target.value }))} />
                </label>
              </section>
            ) : null}

            {picked.length ? (
              <section className="pt-grid">
                <label className="field">
                  <span className="field-label">Seeds per campaign</span>
                  <input className="input" type="number" min={6} max={25} value={seeds} onChange={(e) => setSeeds(Math.max(6, Math.min(25, Number(e.target.value) || 6)))} />
                </label>
                <label className="field">
                  <span className="field-label">Inboxes per domain</span>
                  <input className="input" type="number" min={1} max={5} value={perDomain} onChange={(e) => setPerDomain(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />
                </label>
                <div className="field">
                  <span className="field-label">Start</span>
                  <div className="seg" role="group" aria-label="Start">
                    <button type="button" aria-pressed={start === "saturday"} onClick={() => setStart("saturday")}>{startLabel}</button>
                    <button type="button" aria-pressed={start === "now"} onClick={() => setStart("now")}>Now</button>
                  </div>
                </div>
              </section>
            ) : null}
          </div>

          <div className="sheet-foot" style={{ justifyContent: "space-between" }}>
            <span className="field-hint" style={tooMany ? { color: "var(--warning-ink)" } : undefined}>
              {picked.length
                ? `${int(campaigns)} campaigns · ${int(emails)} emails · ${int(readySeeds)} ready seeds${tooMany ? ": not enough, test fewer domains" : ""}${missingControl.length ? ` · pick a control for ${missingControl.map((g) => g.client).join(", ")}` : ""}`
                : "Pick the domains to test."}
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!ready || tooMany} onClick={submit}>
                <FlaskConical size={13} /> {pending ? "Saving…" : `Create ${campaigns ? int(campaigns) : ""} campaigns`}
              </button>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
