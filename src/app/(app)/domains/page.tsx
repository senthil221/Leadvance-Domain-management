import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { DomainsView } from "@/components/domains/DomainsView";
import { PageHead, Skeleton, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { listClients, listDomains } from "@/lib/queries";

export const metadata: Metadata = { title: "Domains" };

export default function DomainsPage() {
  return (
    <>
      <PageHead title="Domains" sub="Every domain you own, its state and its health over the last 7 days">
        <Link href="/inventory?add=1" className="btn"><Plus size={14} strokeWidth={1.75} /> Add domains</Link>
      </PageHead>
      <div className="page-body">
        <Suspense fallback={<DomainsSkeleton />}>
          <DomainsData />
        </Suspense>
      </div>
    </>
  );
}

async function DomainsData() {
  await getCurrentUser();
  const [domains, clients] = await Promise.all([listDomains(), listClients()]);
  return <DomainsView domains={domains} clients={clients} />;
}

function DomainsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-9 items-center gap-6 border-b border-line">{[60, 56, 72, 60, 56, 52, 32].map((w, i) => <Skeleton key={i} w={w} h={12} />)}</div>
      <div className="flex gap-2"><Skeleton w={260} h={30} /><Skeleton w={180} h={30} /></div>
      <TableSkeleton rows={12} />
    </div>
  );
}
