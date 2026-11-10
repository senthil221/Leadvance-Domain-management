import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ClientSending } from "@/components/clients/ClientSending";
import { TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getClientSending, lastDays } from "@/lib/queries";

export const metadata: Metadata = { title: "Client sending" };

// Everything here is per request and behind sign-in, including the shell around it, so there is nothing to prerender.
export const instant = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="page-body"><TableSkeleton rows={10} /></div>}>
      <ClientData params={params} />
    </Suspense>
  );
}

async function ClientData({ params }: { params: Promise<{ id: string }> }) {
  await getCurrentUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { from, to } = await lastDays(1); // Today; the date picker changes it
  const data = await getClientSending(id, from, to);
  if (!data) notFound();
  return <ClientSending initial={data} />;
}
