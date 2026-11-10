"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { seedStatus } from "@/lib/placement-seeds";
import type { BatchRow, TestCandidate } from "@/lib/placement-tests-db";
import { NewTestSheet } from "./NewTestSheet";
import { SeedsView, type SeedItem } from "./SeedsView";
import { TestsView } from "./TestsView";

type Sync = { finishedAt: string | null; ok: boolean | null; error: string | null } | null;

export function PlacementView({ seeds, seedSync, batches, candidates, testRun, saturday, timezone }: {
  seeds: SeedItem[]; seedSync: Sync; batches: BatchRow[]; candidates: TestCandidate[]; testRun: Sync; saturday: string; timezone: string;
}) {
  const params = useSearchParams();
  // ?test=<domain ids> opens a new test with those domains ticked (from the Replace list).
  const initial = useMemo(() => (params.get("test") ?? "").split(",").filter(Boolean), [params]);
  const [view, setView] = useState<"tests" | "seeds">(() => (params.get("view") === "seeds" ? "seeds" : "tests"));
  const [sheet, setSheet] = useState(initial.length > 0);
  const [now] = useState(() => Date.now());
  const ready = useMemo(() => seeds.filter((s) => seedStatus(s, now) === "ready").length, [seeds, now]);

  const pickView = (v: "tests" | "seeds") => {
    setView(v);
    const p = new URLSearchParams(window.location.search);
    p.delete("test");
    if (v === "seeds") p.set("view", "seeds"); else p.delete("view");
    window.history.replaceState(null, "", p.toString() ? `?${p}` : window.location.pathname);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="tabs-list pt-tabs" role="tablist" aria-label="Placement">
        <button type="button" role="tab" data-state={view === "tests" ? "active" : "inactive"} aria-selected={view === "tests"} onClick={() => pickView("tests")}>
          Tests <span className="zero num">{batches.length}</span>
        </button>
        <button type="button" role="tab" data-state={view === "seeds" ? "active" : "inactive"} aria-selected={view === "seeds"} onClick={() => pickView("seeds")}>
          Seeds <span className="zero num">{ready}</span>
        </button>
      </div>
      {view === "tests"
        ? <TestsView batches={batches} readySeeds={ready} onNew={() => setSheet(true)} lastRun={testRun} />
        : <SeedsView seeds={seeds} lastSync={seedSync} />}
      {sheet ? (
        <NewTestSheet open onClose={() => setSheet(false)} candidates={candidates} readySeeds={ready} saturday={saturday} timezone={timezone} initial={initial} />
      ) : null}
    </div>
  );
}
