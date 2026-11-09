"use client";

import { ArrowRightLeft, Plus, Search, Tags as TagsIcon, Target, Wand2, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { addDomainsToTag, removeDomainsFromTag, saveTagTarget } from "@/app/actions";
import { Empty, Rep, StatusDot } from "@/components/ui";
import { int } from "@/lib/format";
import {
  buildTags, clientTagsOf, fillPick, freeState, sameSender, warmupOf,
  type BoardCampaign, type BoardDomain, type BoardTag,
} from "@/lib/tag-board";
import { normTag } from "@/lib/tag-map";

type Pane = "on" | "free";

/** Volume against the target: a thin bar, full at the target. */
function VolumeBar({ volume, target }: { volume: number; target: number | null }) {
  if (!target) return null;
  const pct = Math.min(100, (100 * volume) / target);
  return (
    <span className={`tg-bar${volume >= target ? " is-met" : ""}`} title={`${int(volume)} of ${int(target)} a day (${Math.round((100 * volume) / target)}%)`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Status, with the grace days left for a replaced domain and the expiry when it's close. */
function DomainState({ d, now }: { d: BoardDomain; now: number }) {
  const days = d.expiresAt ? Math.floor((new Date(d.expiresAt).getTime() - now) / 86_400_000) : null;
  return (
    <span className="flex items-center gap-1.5">
      {d.status === "draining" && d.graceDaysLeft != null
        ? <span className="status-dot tone-warning" title="Replaced: still sending through its grace period">Replaced · {d.graceDaysLeft}d left</span>
        : <StatusDot status={d.status} />}
      {d.beingReplaced && d.status !== "draining" ? <span className="badge" title="A replacement for this domain is under way">Replacing</span> : null}
      {days != null && days <= 30 ? <span className={`badge ${days < 0 ? "tone-danger" : "tone-warning"}`} title={`Registration ends ${d.expiresAt}`}>{days < 0 ? "Expired" : `Expires in ${days}d`}</span> : null}
    </span>
  );
}

function Sender({ d, tagSender }: { d: BoardDomain; tagSender: string | null }) {
  const main = d.senders[0]?.name ?? null;
  if (!main) return <span className="zero">—</span>;
  const off = tagSender != null && !sameSender(d, tagSender);
  return (
    <span className={off ? "tg-sender is-off" : "tg-sender"} title={d.senders.map((s) => `${s.name} ×${s.count}`).join(", ") + (off ? ` · the tag's sender is ${tagSender}` : "")}>
      {main}{d.senders.length > 1 ? <em> +{d.senders.length - 1}</em> : null}
    </span>
  );
}

export function TagsView({ domains, campaigns, targets, dryRun, appProblem }: {
  domains: BoardDomain[]; campaigns: BoardCampaign[]; targets: Record<string, number>;
  dryRun: boolean; appProblem: string | null;
}) {
  const tags = useMemo(() => buildTags(domains, targets), [domains, targets]);
  const free = useMemo(() => domains.filter((d) => freeState(d).free), [domains]);
  const campaignName = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns]);
  const [q, setQ] = useState("");
  const params = useSearchParams();
  const [picked, setPicked] = useState<string | null>(() => params.get("tag"));
  const tag = tags.find((t) => t.key === picked) ?? null;
  const [newTag, setNewTag] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const blocked = Boolean(appProblem);

  const pick = (key: string | null) => {
    setPicked(key);
    const p = new URLSearchParams(window.location.search);
    if (key) p.set("tag", key); else p.delete("tag");
    window.history.replaceState(null, "", p.toString() ? `?${p}` : window.location.pathname);
  };

  const needle = normTag(q);
  const shown = tags.filter((t) => !needle || t.key.includes(needle) || normTag(t.sender ?? "").includes(needle)
    || t.domains.some((d) => d.name.includes(needle)));
  const total = tags.reduce((a, t) => a + t.volume, 0);
  const freeReady = free.filter((d) => freeState(d).ready);

  const createTag = () => {
    const name = (newTag ?? "").trim();
    if (!name) return;
    start(async () => {
      const r = await saveTagTarget(name, 1);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${name} added. Set its target, then add free domains`);
      setNewTag(null);
      pick(normTag(name));
    });
  };

  return (
    <div className="tg">
      <div className="toolbar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tags, senders or domains" aria-label="Search tags" />
        </label>
        <span className="tg-total">{int(tags.length)} tags · {int(total)} a day · <b>{int(freeReady.length)}</b> free domains ready ({int(freeReady.reduce((a, d) => a + d.volume, 0))} a day)</span>
        <span className="spacer-auto" />
        {newTag == null ? (
          <button type="button" className="btn btn-sm" onClick={() => setNewTag("")}><Plus size={14} /> New tag</button>
        ) : (
          <span className="flex items-center gap-1.5">
            <input className="input" autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag name, as in Smartlead"
              onKeyDown={(e) => { if (e.key === "Enter") createTag(); if (e.key === "Escape") setNewTag(null); }} aria-label="New tag name" />
            <button type="button" className="btn btn-sm btn-primary" disabled={pending || !newTag.trim()} onClick={createTag}>Add</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNewTag(null)} aria-label="Cancel"><X size={14} /></button>
          </span>
        )}
      </div>
      {dryRun ? <p className="tg-note">Dry run is on: tag changes are made in the app only, Smartlead isn&apos;t changed.</p> : null}
      {appProblem ? <p className="tg-note is-warn">{appProblem}</p> : null}

      <div className={`tg-layout${tag ? " has-detail" : ""}`}>
        <div className="table-wrap">
          <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 210px)" }}>
            <table className="data-table is-main tg-table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Sender</th>
                  <th className="is-num">Domains</th>
                  <th className="is-num" title="Connected inboxes, and disconnected ones in red">Inboxes</th>
                  <th className="is-num" title="Campaign emails a day: the daily limits of the connected inboxes, added up">Volume / day</th>
                  <th className="is-num" title="The volume you want this tag to reach">Target</th>
                  {tag ? null : <th className="is-num">Sent today</th>}
                  {tag ? null : <th className="is-num">Reputation</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.key} className="is-clickable" data-selected={t.key === picked} onClick={() => pick(t.key === picked ? null : t.key)}>
                    <td className="col-first"><span className="strong">{t.name}</span></td>
                    <td className="tg-ellipsis">{t.sender ?? <span className="zero">—</span>}</td>
                    <td className="is-num">{int(t.domains.length)}</td>
                    <td className="is-num">{int(t.connected)}{t.disconnected ? <span className="tg-disc"> +{int(t.disconnected)}</span> : null}</td>
                    <td className="is-num">
                      <span className="tg-vol">{int(t.volume)}<VolumeBar volume={t.volume} target={t.target} /></span>
                    </td>
                    <td className="is-num">{t.target ? <span className={t.volume >= t.target ? "tg-met" : "tg-gap"}>{int(t.target)}</span> : <span className="zero">—</span>}</td>
                    {tag ? null : <td className="is-num">{int(t.sentToday)}</td>}
                    {tag ? null : <td className="is-num"><Rep value={t.rep} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 ? <Empty icon={TagsIcon} title={tags.length ? "No tag matches" : "No tags yet"}>Tags come from Smartlead. Inboxes tagged there show up here after the next sync.</Empty> : null}
          </div>
        </div>
        {tag ? (
          <TagDetail key={tag.key} tag={tag} tags={tags} free={free} campaignName={campaignName} blocked={blocked} onClose={() => pick(null)} />
        ) : null}
      </div>
    </div>
  );
}

function TagDetail({ tag, tags, free, campaignName, blocked, onClose }: {
  tag: BoardTag; tags: BoardTag[]; free: BoardDomain[]; campaignName: Map<number, string>; blocked: boolean; onClose: () => void;
}) {
  const [pane, setPane] = useState<Pane>(tag.domains.length ? "on" : "free");
  const [now] = useState(() => Date.now());
  const [target, setTarget] = useState(tag.target ? String(tag.target) : "");
  const [pending, start] = useTransition();
  const [onSel, setOnSel] = useState<Set<string>>(new Set());
  const [freeSel, setFreeSel] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [onlyReady, setOnlyReady] = useState(true);
  // The tag's campaigns, ticked when at least half its domains are in them.
  const [camps, setCamps] = useState<Set<number>>(() => new Set(tag.campaigns.filter((c) => c.domains * 2 >= tag.domains.length).map((c) => c.id)));

  const need = tag.target ? Math.max(0, tag.target - tag.volume) : 0;
  const freeList = useMemo(() => [...free].filter((d) => !onlyReady || freeState(d).ready).sort((a, b) =>
    Number(sameSender(b, tag.sender)) - Number(sameSender(a, tag.sender)) || (b.rep ?? 0) - (a.rep ?? 0) || b.volume - a.volume || a.name.localeCompare(b.name)), [free, onlyReady, tag.sender]);
  const adding = freeList.filter((d) => freeSel.has(d.id));
  const addVolume = adding.reduce((a, d) => a + d.volume, 0);
  const after = tag.volume + addVolume;

  const run = (fn: () => Promise<{ ok: true; data: { message: string } } | { ok: false; error: string }>, done?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.message);
      done?.();
    });

  const saveTarget = () => {
    const n = target.trim() ? Math.round(Number(target.replace(/[, ]/g, ""))) : 0;
    if (!Number.isFinite(n) || n < 0) return void toast.error("Enter a number of emails a day");
    if ((tag.target ?? 0) === n) return;
    run(() => saveTagTarget(tag.name, n || null));
  };

  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const others = tags.filter((t) => t.key !== tag.key);

  return (
    <aside className="card tg-detail" aria-label={`Tag ${tag.name}`}>
      <div className="card-head">
        <span className="card-title">{tag.name}</span>
        <span className="card-sub">{tag.sender ? `Sender ${tag.sender}` : "No sender name yet"}</span>
        <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div className="tg-sum">
        <div className="tg-sum-vol">
          <span className="tg-big">{int(tag.volume)}</span><span className="tg-of">{tag.target ? ` of ${int(tag.target)} a day` : " a day"}</span>
          <VolumeBar volume={tag.volume} target={tag.target} />
          <span className="tg-sub">{int(tag.domains.length)} domains · {int(tag.connected)} inboxes{tag.disconnected ? ` · ${int(tag.disconnected)} disconnected` : ""}{need ? ` · ${int(need)} a day short` : tag.target ? " · target met" : ""}</span>
        </div>
        <label className="tg-target">
          <Target size={13} aria-hidden /> Target a day
          <input className="input num" inputMode="numeric" value={target} placeholder="None" onChange={(e) => setTarget(e.target.value)}
            onBlur={saveTarget} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} aria-label={`Volume target for ${tag.name}`} />
        </label>
      </div>

      <div className="tg-panes seg" role="group" aria-label="Domains on this tag or free to add">
        <button type="button" aria-pressed={pane === "on"} onClick={() => setPane("on")}>On this tag ({int(tag.domains.length)})</button>
        <button type="button" aria-pressed={pane === "free"} onClick={() => setPane("free")}>Add free domains ({int(free.filter((d) => freeState(d).ready).length)})</button>
      </div>

      {pane === "on" ? (
        <>
          <div className="tg-actions">
            <span className="tg-sel">{onSel.size ? `${onSel.size} selected` : "Select domains to move or untag them"}</span>
            <span className="spacer-auto" />
            <span className="tg-move">
              <input className="input" list={`tg-tags-${tag.key}`} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="Move to tag…" aria-label="Tag to move to" />
              <datalist id={`tg-tags-${tag.key}`}>{others.map((t) => <option key={t.key} value={t.name} />)}</datalist>
              <button type="button" className="btn btn-sm" disabled={pending || blocked || !onSel.size || !moveTo.trim()}
                title="Puts them on that tag instead, with its sending limits"
                onClick={() => run(() => addDomainsToTag({ domainIds: [...onSel], tag: moveTo.trim(), campaignIds: [] }), () => { setOnSel(new Set()); setMoveTo(""); })}>
                <ArrowRightLeft size={13} /> Move
              </button>
            </span>
            <button type="button" className="btn btn-sm" disabled={pending || blocked || !onSel.size}
              title={`Takes ${tag.name} off their inboxes. Their campaigns stay as they are.`}
              onClick={() => run(() => removeDomainsFromTag({ domainIds: [...onSel], tag: tag.name }), () => setOnSel(new Set()))}>
              <X size={13} /> Remove from tag
            </button>
          </div>
          <div className="table-scroll tg-sub-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select every domain on this tag" checked={tag.domains.length > 0 && onSel.size === tag.domains.length}
                      onChange={() => setOnSel(onSel.size === tag.domains.length ? new Set() : new Set(tag.domains.map((d) => d.id)))} />
                  </th>
                  <th>Domain</th><th>Status</th><th className="is-num">Inboxes</th><th className="is-num">Volume</th><th className="is-num">Rep.</th><th>Sender</th><th className="is-num">Campaigns</th>
                </tr>
              </thead>
              <tbody>
                {[...tag.domains].sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name)).map((d) => {
                  const also = clientTagsOf(d).filter(([k]) => k !== tag.key).map(([, n]) => n);
                  return (
                    <tr key={d.id} className="is-clickable" data-selected={onSel.has(d.id)} onClick={() => setOnSel((s) => toggle(s, d.id))}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={onSel.has(d.id)} onChange={() => {}} tabIndex={-1} aria-label={`Select ${d.name}`} /></td>
                      <td className="col-first"><span className="strong">{d.name}</span>{also.length ? <span className="badge" title={`Also tagged ${also.join(", ")}`}>+{also.length} tag</span> : null}</td>
                      <td><DomainState d={d} now={now} /></td>
                      <td className="is-num">{int(d.connected)}{d.disconnected ? <span className="tg-disc"> +{d.disconnected}</span> : null}</td>
                      <td className="is-num">{int(d.volume)}</td>
                      <td className="is-num"><Rep value={d.rep} /></td>
                      <td><Sender d={d} tagSender={tag.sender} /></td>
                      <td className="is-num" title={d.campaigns.map((c) => campaignName.get(c) ?? `#${c}`).join("\n")}>{d.campaigns.length || <span className="zero">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tag.domains.length === 0 ? <Empty icon={TagsIcon} title="No domains on this tag">Add free domains to start it.</Empty> : null}
          </div>
        </>
      ) : (
        <>
          <div className="tg-actions">
            <span className="tg-sel">
              {adding.length
                ? <>Adds <b>{int(addVolume)}</b> a day → <b>{int(after)}</b>{tag.target ? ` of ${int(tag.target)}` : ""}</>
                : need ? `${int(need)} a day short of the target` : "Pick free domains to add"}
            </span>
            <label className="tg-check"><input type="checkbox" className="checkbox" checked={onlyReady} onChange={() => setOnlyReady((x) => !x)} /> Warmed up only</label>
            <span className="spacer-auto" />
            <button type="button" className="btn btn-sm" disabled={!need}
              title="Ticks free, warmed-up domains until the target is reached: the tag's sender first, then the best reputation"
              onClick={() => setFreeSel(new Set(fillPick(free, tag.sender, need)))}>
              <Wand2 size={13} /> Fill to target
            </button>
            {freeSel.size ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFreeSel(new Set())}>Clear</button> : null}
            <button type="button" className="btn btn-sm btn-primary" disabled={pending || blocked || !adding.length}
              title={`Puts them on ${tag.name}: its sending limits are copied, New comes off and they go Active${camps.size ? `, then their inboxes join ${camps.size} campaign${camps.size === 1 ? "" : "s"}` : ""}`}
              onClick={() => run(() => addDomainsToTag({ domainIds: adding.map((d) => d.id), tag: tag.name, campaignIds: [...camps] }), () => setFreeSel(new Set()))}>
              <Plus size={13} /> Add {adding.length || ""} to {tag.name}
            </button>
          </div>
          {tag.campaigns.length ? (
            <div className="tg-camps">
              <span className="tg-camps-label">Also add their inboxes to:</span>
              {tag.campaigns.slice(0, 12).map((c) => (
                <label key={c.id} className="tg-camp" title={`${c.domains} of this tag's ${tag.domains.length} domains are in it`}>
                  <input type="checkbox" className="checkbox" checked={camps.has(c.id)} onChange={() => setCamps((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                  {campaignName.get(c.id) ?? `Campaign ${c.id}`} <em>{c.domains}</em>
                </label>
              ))}
            </div>
          ) : <p className="tg-note">This tag&apos;s inboxes aren&apos;t in any campaign yet, so added domains only get the tag.</p>}
          <div className="table-scroll tg-sub-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-check" />
                  <th>Domain</th><th>Warm-up</th><th className="is-num">Inboxes</th><th className="is-num">Volume</th><th className="is-num">Rep.</th><th>Sender</th><th>Client</th>
                </tr>
              </thead>
              <tbody>
                {freeList.map((d) => {
                  const w = warmupOf(d);
                  return (
                    <tr key={d.id} className="is-clickable" data-selected={freeSel.has(d.id)} onClick={() => setFreeSel((s) => toggle(s, d.id))}>
                      <td className="col-check"><input type="checkbox" className="checkbox" checked={freeSel.has(d.id)} onChange={() => {}} tabIndex={-1} aria-label={`Select ${d.name}`} /></td>
                      <td className="col-first"><span className="strong">{d.name}</span>{sameSender(d, tag.sender) ? <span className="badge tone-success" title="Same sender name as this tag">Same sender</span> : null}</td>
                      <td>{w ? (w.ready ? <span className="tg-ready">Done</span> : <span className="tg-warm">Day {w.day} of {w.days}</span>) : <span className="tg-ready">Ready</span>}</td>
                      <td className="is-num">{int(d.connected)}{d.disconnected ? <span className="tg-disc"> +{d.disconnected}</span> : null}</td>
                      <td className="is-num">{int(d.volume)}</td>
                      <td className="is-num"><Rep value={d.rep} /></td>
                      <td><Sender d={d} tagSender={tag.sender} /></td>
                      <td className="tg-ellipsis">{d.clientName ?? <span className="zero">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {freeList.length === 0 ? <Empty icon={TagsIcon} title="No free domains">{onlyReady ? "Every free domain is still warming up. Untick Warmed up only to see them." : "Every connected domain is on a tag."}</Empty> : null}
          </div>
        </>
      )}
    </aside>
  );
}

