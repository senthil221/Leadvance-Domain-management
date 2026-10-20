"use client";

import { Command } from "cmdk";
import { Dialog } from "radix-ui";
import { CornerDownLeft, Globe, Moon, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { loadSearchIndex } from "@/app/actions";
import { STATUS_META, type DomainStatus } from "@/lib/status";
import { toggleTheme } from "../ThemeToggle";
import { NAV_ITEMS } from "./nav";

type Entry = { id: string; name: string; status: DomainStatus; client: string | null };

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [, startTransition] = useTransition();

  // The domain list loads the first time the palette opens, then stays.
  useEffect(() => {
    if (open && index === null) {
      startTransition(async () => setIndex(await loadSearchIndex()));
    }
  }, [open, index]);

  const go = (href: string) => {
    onOpenChange(false);
    setQuery("");
    router.push(href);
  };

  const domainMatches = query.trim().length >= 2 && index
    ? index.filter((d) => d.name.includes(query.trim().toLowerCase())).slice(0, 8)
    : [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog cmdk-dialog" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" shouldFilter={true} loop>
            <div className="cmdk-input">
              <Search size={16} strokeWidth={1.5} />
              <Command.Input value={query} onValueChange={setQuery} placeholder="Search domains, pages and actions…" autoFocus />
            </div>
            <Command.List>
              <Command.Empty>{index === null && query.length >= 2 ? "Loading domains…" : "No results"}</Command.Empty>
              {domainMatches.length > 0 && (
                <Command.Group heading="Domains">
                  {domainMatches.map((d) => (
                    <Command.Item key={d.id} value={`domain ${d.name}`} onSelect={() => go(`/domains?d=${d.id}`)}>
                      <Globe size={16} strokeWidth={1.5} />
                      <span>{d.name}</span>
                      <span className="cmdk-meta">{d.client ? `${d.client} · ` : ""}{STATUS_META[d.status].label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Go to">
                {NAV_ITEMS.map(({ href, label, icon: Icon, key }) => (
                  <Command.Item key={href} value={`go ${label}`} onSelect={() => go(href)}>
                    <Icon size={16} strokeWidth={1.5} />
                    <span>{label}</span>
                    <span className="cmdk-meta"><kbd className="kbd">G</kbd> <kbd className="kbd">{key.toUpperCase()}</kbd></span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Actions">
                <Command.Item value="add domains to inventory" onSelect={() => go("/inventory?add=1")}>
                  <Plus size={16} strokeWidth={1.5} />
                  <span>Add domains to inventory</span>
                </Command.Item>
                <Command.Item value="replace flagged domains" onSelect={() => go("/domains?view=flagged")}>
                  <Globe size={16} strokeWidth={1.5} />
                  <span>Review flagged domains</span>
                </Command.Item>
                <Command.Item value="toggle dark light theme" onSelect={() => { toggleTheme(); onOpenChange(false); }}>
                  <Moon size={16} strokeWidth={1.5} />
                  <span>Switch light / dark</span>
                </Command.Item>
              </Command.Group>
            </Command.List>
            <div className="cmdk-foot">
              <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
              <span><kbd className="kbd"><CornerDownLeft size={10} /></kbd> open</span>
              <span><kbd className="kbd">esc</kbd> close</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
