"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span className="field-label">Email</span>
        <input className="input" name="email" type="email" autoComplete="email" required autoFocus />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input className="input" name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? <p className="text-[12.5px] text-danger-ink" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn-primary mt-1 h-9" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
