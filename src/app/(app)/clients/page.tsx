import type { Metadata } from "next";
import { Suspense } from "react";
import { ClientsList } from "@/components/clients/ClientsList";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getClientsSending } from "@/lib/queries";

export const metadata: Metadata = { title: "Clients" };

export default function ClientsPage() {
  return (
    <>
      <PageHead title="Clients" sub="What each client was promised against what actually went out" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={10} />}>
          <ClientsData />
        </Suspense>
      </div>
    </>
  );
}

async function ClientsData() {
  await getCurrentUser();
  return <ClientsList {...await getClientsSending()} />;
}
