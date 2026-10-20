"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";

export type SortState<K extends string> = { key: K; dir: 1 | -1 };

/** A sortable column head: click to sort, click again to flip. */
export function SortTh<K extends string>({ k, sort, onSort, num, title, children }: {
  k: K; sort: SortState<K>; onSort: (k: K) => void; num?: boolean; title?: string; children: ReactNode;
}) {
  return (
    <th className={num ? "is-num" : undefined} title={title} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="sort-head" onClick={() => onSort(k)}>
        {children}
        {sort.key === k ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
      </button>
    </th>
  );
}
