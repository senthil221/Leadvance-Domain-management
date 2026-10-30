import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandMark } from "@/components/shell/BrandMark";
import { brand } from "@/lib/brand";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={16} />
          <h1 className="login-tool">{brand.name}</h1>
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
