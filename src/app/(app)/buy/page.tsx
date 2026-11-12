import type { Metadata } from "next";
import { Suspense } from "react";
import { BuyDomainsView } from "@/components/buy/BuyDomainsView";
import { PageHead, TableSkeleton } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getPurchases } from "@/lib/queries";

export const metadata: Metadata = { title: "Buy domains" };

export default function BuyPage() {
  return (
    <>
      <PageHead title="Domains" sub="Buy a list of domains a few at a time, spread over days and accounts, the way a person would" />
      <div className="page-body">
        <Suspense fallback={<TableSkeleton rows={8} />}>
          <Buy />
        </Suspense>
      </div>
    </>
  );
}

async function Buy() {
  await getCurrentUser();
  const [{ accounts, orders }, [tz]] = await Promise.all([
    getPurchases(),
    sql`select value #>> '{}' as tz from settings where key = 'stats_timezone'`,
  ]);
  return <BuyDomainsView accounts={accounts} orders={orders} timezone={(tz?.tz as string) || "UTC"} dryRun={process.env.INTEGRATIONS_DRY_RUN !== "false"} />;
}
