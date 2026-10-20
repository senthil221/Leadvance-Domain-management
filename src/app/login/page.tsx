import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 12 12" fill="none"><path d="M2 6h8M6 2a6.5 6.5 0 0 1 0 8M6 2a6.5 6.5 0 0 0 0 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </span>
          <h1 className="login-tool">Domain Engine</h1>
        </div>
        <Suspense fallback={<LoginForm next="/" />}>
          <Form searchParams={searchParams} />
        </Suspense>
        <p className="text-center text-[12px] text-faint">Accounts are created by your admin.</p>
      </div>
    </main>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const next = (await searchParams).next;
  return <LoginForm next={typeof next === "string" ? next : "/"} />;
}
