import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations";

describe("dead_domains", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await PGlite.create();
    for (const m of loadMigrations()) await db.exec(m.sql);
  });
  afterAll(async () => db.close());

  // One active domain per case; inboxes as [status, connect_error].
  const domain = async (name: string, inboxes: [string, string | null][], opts: { status?: string; answering?: boolean | null } = {}) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into domains (name, status, nameservers_answering) values ($1, $2, $3) returning id",
      [name, opts.status ?? "active", opts.answering ?? true]);
    for (const [i, [status, error]] of inboxes.entries()) {
      await db.query("insert into inboxes (domain_id, email, status, connect_error, provider_type) values ($1, $2, $3, $4, 'OUTLOOK')",
        [rows[0].id, `u${i}@${name}`, status, error]);
    }
  };

  it("names what killed each active domain, and leaves live ones alone", async () => {
    await domain("live.com", [["connected", null], ["connected", null]]);
    await domain("partly.com", [["connected", null], ["disconnected", "SMTP login failed"]]);
    await domain("tenant.com", [["removed", "AADSTS500341: The user account {EUII Hidden} has been deleted from the x directory."], ["removed", null]]);
    await domain("expired.com", [["removed", "Message not sent - accessToken expired! Please reconnect"]]);
    await domain("gmailoff.com", [["disconnected", "RTPS-CE:- Mail service not enabled"]]);
    await domain("dropped.com", [["disconnected", "IMAP login failed"]]);
    await domain("deleted.com", [["removed", null]]);
    await domain("nodns.com", [["connected", null]], { answering: false });
    await domain("tenant1.onmicrosoft.com", [["connected", null]], { answering: false });
    await domain("never.com", []);
    await domain("retired.com", [["removed", "AADSTS500341"]], { status: "burned" });

    const { rows } = await db.query<{ name: string; cause: string }>(
      "select d.name, x.cause from dead_domains x join domains d on d.id = x.domain_id order by d.name");
    expect(rows.map((r) => [r.name, r.cause])).toEqual([
      ["deleted.com", "deleted"],
      ["dropped.com", "disconnected"],
      ["expired.com", "signin_expired"],
      ["gmailoff.com", "mail_off"],
      ["nodns.com", "dns_gone"],
      ["tenant.com", "tenant_deleted"],
    ]);
  });
});
