import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftRight, ArrowRight, Check, CircleAlert, Loader } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ApprovePayment } from "@/components/replacements/ApprovePayment";
import { StepActions } from "@/components/replacements/StepActions";
import { Badge, ClientCell, Empty, PageHead, Skeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ago, shortDate } from "@/lib/format";
import { listBatches, type Batch, type BatchItem } from "@/lib/queries";
import { REPLACEMENT_REASONS, STEP_LABELS, type StepKey, type StepStatus } from "@/lib/status";

export const metadata: Metadata = { title: "Replacements" };

export default function ReplacementsPage() {
  return (
    <>
      <PageHead title="Domains" sub="Every swap: which domain replaced which, when, why and how far setup has got" />
      <div className="page-body">
        <Suspense fallback={<BatchesSkeleton />}>
          <Batches />
        </Suspense>
      </div>
    </>
  );
}

const STEPS = Object.keys(STEP_LABELS) as StepKey[];
const isDone = (s: StepStatus) => s === "done" || s === "skipped";

async function Batches() {
  await getCurrentUser();
  const batches = await listBatches();
  if (batches.length === 0) {
    return (
      <div className="card">
        <Empty icon={ArrowLeftRight} title="No replacements yet" action={<Link href="/domains?view=flagged" className="btn">Review flagged domains</Link>}>
          Select domains in Domains and press Replace. Each swap is recorded here with its reason and progress.
        </Empty>
      </div>
    );
  }
  const running = batches.some((b) => b.status === "running");
  return (
    <>
      {running ? <AutoRefresh seconds={5} /> : null}
      {batches.map((b) => <BatchCard key={b.id} batch={b} />)}
    </>
  );
}

function BatchCard({ batch: b }: { batch: Batch }) {
  const doneItems = b.items.filter((i) => STEPS.every((s) => isDone(i[s]))).length;
  const failed = b.items.filter((i) => STEPS.some((s) => i[s] === "failed")).length;
  const unpaid = b.items.filter((i) => i.htOrderId && !i.htPaidAt && !i.completedAt && isDone(i.stepNameservers) && !isDone(i.stepInboxes));
  const pct = b.items.length ? Math.round((100 * b.items.reduce((a, i) => a + STEPS.filter((s) => isDone(i[s])).length, 0)) / (b.items.length * STEPS.length)) : 0;

  return (
    <section className="card" aria-label={`Replacement batch from ${shortDate(b.createdAt)}`}>
      <div className="card-head flex-wrap py-2.5" style={{ minHeight: 52 }}>
        <div className="flex min-w-0 flex-col">
          <span className="card-title">
            {REPLACEMENT_REASONS[b.reason]} · {b.items.length} domain{b.items.length === 1 ? "" : "s"}
            {b.hypertideReplace ? <span className="ml-2 align-middle"><Badge tone="info">via Hypertide</Badge></span> : null}
          </span>
          <span className="card-sub truncate">
            {b.actor} · {shortDate(b.createdAt)} · {ago(b.createdAt)}{b.note ? ` · ${b.note}` : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {unpaid.length > 1 ? <ApprovePayment itemIds={unpaid.map((i) => i.id)} domains={unpaid.map((i) => i.newDomain)} /> : null}
          {failed > 0 ? <Badge tone="danger">{failed} need attention</Badge> : null}
          {b.status === "running" ? (
            <span className="flex items-center gap-2 text-muted">
              <span className="progress w-24"><span style={{ width: `${pct}%` }} /></span>
              <span className="num text-[12px]">{doneItems}/{b.items.length}</span>
            </span>
          ) : (
            <Badge tone={b.status === "completed" ? "success" : b.status === "cancelled" ? undefined : "warning"}>
              {b.status === "completed" ? "Completed" : b.status === "cancelled" ? "Cancelled" : "Partly done"}
            </Badge>
          )}
        </div>
      </div>
      <div className="list">
        {b.items.map((i) => <ItemRow key={i.id} item={i} />)}
      </div>
    </section>
  );
}

const STEP_KEY = { nameservers: "stepNameservers", inboxes: "stepInboxes", smartlead: "stepSmartlead", campaigns: "stepCampaigns" } as const;

function ItemRow({ item: i }: { item: BatchItem }) {
  const current = (Object.keys(STEP_KEY) as (keyof typeof STEP_KEY)[]).find((s) => !isDone(i[STEP_KEY[s]])) ?? null;
  return (
    <div className="list-row flex-wrap" style={{ alignItems: "center" }}>
      <div className="flex min-w-0 flex-1 items-center gap-2" style={{ minWidth: 260 }}>
        <Link href={`/domains?d=${i.oldDomainId}`} className="truncate text-muted line-through decoration-line-strong hover:text-ink">{i.oldDomain}</Link>
        <ArrowRight size={13} className="flex-none text-faint" />
        <Link href={`/domains?d=${i.newDomainId}`} className="list-title hover:underline">{i.newDomain}</Link>
      </div>
      <span className="hidden w-32 md:block"><ClientCell name={i.clientName} hue={i.clientHue} /></span>
      {i.htOperation && !i.completedAt ? (
        <span className="text-[12px] text-muted" title="Status of the replacement on Hypertide">Hypertide: {i.htOperation.replace(/_/g, " ")}</span>
      ) : null}
      <div className="steps">
        {STEPS.map((s, idx) => (
          <span key={s} className="contents">
            {idx > 0 ? <span className="step-line" /> : null}
            <span className={`step is-${i[s]}`} title={`${STEP_LABELS[s]}: ${i[s]}`}>
              {i[s] === "done" ? <Check size={11} strokeWidth={2.25} /> : i[s] === "running" ? <Loader size={11} className="animate-spin" /> : i[s] === "failed" ? <CircleAlert size={11} /> : null}
              {STEP_LABELS[s]}
            </span>
          </span>
        ))}
      </div>
      {!i.completedAt && (i.note || i.lastError || current) ? (
        <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <p className={`min-w-0 flex-1 text-[12.5px] ${i.lastError ? "text-danger-ink" : "text-muted"}`} style={{ minWidth: 240 }}>
            {i.lastError ?? i.note}
          </p>
          {current === "inboxes" && i.htOrderId && !i.htPaidAt ? <ApprovePayment itemIds={[i.id]} domains={[i.newDomain]} /> : null}
          {current ? <StepActions itemId={i.id} step={current} status={i[STEP_KEY[current]]} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function BatchesSkeleton() {
  return (
    <>
      {[3, 2].map((n, k) => (
        <div key={k} className="card">
          <div className="card-head"><Skeleton w={220} h={12} /></div>
          <div className="card-body flex flex-col gap-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} h={14} />)}</div>
        </div>
      ))}
    </>
  );
}
