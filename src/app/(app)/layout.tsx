import { Suspense } from "react";
import { DomainPanel } from "@/components/domains/DomainPanel";
import { AppShell } from "@/components/shell/AppShell";
import { NavLinks } from "@/components/shell/NavLinks";
import { Monogram } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { getNavCounts } from "@/lib/queries";

// The frame renders straight away; the counts and the signed-in user stream in.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      nav={
        <Suspense fallback={<NavLinks />}>
          <NavWithCounts />
        </Suspense>
      }
      user={
        <Suspense fallback={<span className="sidebar-user" />}>
          <UserBadge />
        </Suspense>
      }
    >
      {children}
      <Suspense fallback={null}>
        <DomainPanel />
      </Suspense>
    </AppShell>
  );
}

async function NavWithCounts() {
  await getCurrentUser();
  const c = await getNavCounts();
  return (
    <NavLinks
      badges={{
        "/inventory": { value: c.byStatus.active ?? 0 },
        "/replacements": { value: c.runningBatches, warning: true },
        "/inboxes": { value: c.attention, warning: true },
      }}
    />
  );
}

async function UserBadge() {
  const user = await getCurrentUser();
  const name = user.email.split("@")[0].replace(/[._-]+/g, " ");
  return (
    <span className="sidebar-user" title={user.email}>
      <Monogram name={name} />
      <span>{user.email}</span>
    </span>
  );
}
