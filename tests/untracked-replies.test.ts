import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syncUntrackedReplies } from "../src/jobs/untracked-replies";
import { htmlToText, parseAddress, parseReply, repliesOf } from "../src/lib/untracked-replies";
import { loadMigrations } from "../scripts/migrations";

describe("reading Smartlead's untracked replies", () => {
  it("finds the replies in the shapes Smartlead answers with", () => {
    const r = [{ id: 1 }];
    expect(repliesOf({ data: { data: { replies: r } } })).toBe(r);
    expect(repliesOf({ data: { replies: r } })).toBe(r);
    expect(repliesOf({ replies: r })).toBe(r);
    expect(repliesOf(r)).toBe(r);
    expect(repliesOf({ data: { data: { replies: [] } } })).toEqual([]);
  });

  it("returns null when there's no list at all, so it isn't read as an empty inbox", () => {
    expect(repliesOf({ ok: false, message: "Unauthorized" })).toBeNull();
    expect(repliesOf(null)).toBeNull();
    expect(repliesOf("Service unavailable")).toBeNull();
  });

  it("splits a name and address", () => {
    expect(parseAddress("Jane Doe <Jane@Acme.com>")).toEqual({ name: "Jane Doe", email: "jane@acme.com" });
    expect(parseAddress('"Doe, Jane" <jane@acme.com>')).toEqual({ name: "Doe, Jane", email: "jane@acme.com" });
    expect(parseAddress("<jane@acme.com>")).toEqual({ name: null, email: "jane@acme.com" });
    expect(parseAddress("jane@acme.com")).toEqual({ name: null, email: "jane@acme.com" });
    expect(parseAddress(null)).toEqual({ name: null, email: null });
  });

  it("reads a reply, falling back to the HTML body for its text", () => {
    expect(parseReply({
      id: 991, account_id: "4412", subject: "Re: Quick question", sender_detail: "Jane Doe <jane@acme.com>",
      recipient_detail: "Sam Lee <sam@b2bdrive.net>", created_at: "2026-11-09T10:15:00.000Z", visible_text: "Yes, call me Tuesday.",
    })).toEqual({
      id: "991", accountId: 4412, subject: "Re: Quick question", senderName: "Jane Doe", senderEmail: "jane@acme.com",
      recipientName: "Sam Lee", recipientEmail: "sam@b2bdrive.net", body: "Yes, call me Tuesday.", receivedAt: "2026-11-09T10:15:00.000Z",
    });
    expect(parseReply({ id: "a1", email_body: "<p>Hi&nbsp;there</p><p>Thanks</p>" })?.body).toBe("Hi there\nThanks");
    expect(parseReply({ subject: "no id" })).toBeNull();
  });

  it("turns HTML into plain text", () => {
    expect(htmlToText("<style>p{}</style><div>One<br>Two</div>")).toBe("One\nTwo");
  });
});

const PORT = 54397;
let pg: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of loadMigrations()) await pg.exec(m.sql);
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  sql = postgres(`postgres://postgres@127.0.0.1:${PORT}/postgres`, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql.end();
  await server.stop();
  await pg.close();
});

const reply = (id: number, at = "2026-11-09T10:00:00Z") => ({ id, subject: `S${id}`, sender_detail: `P${id} <p${id}@x.com>`, created_at: at });
/** A Smartlead that serves `all` in pages, the way the endpoint does. */
const fake = (all: unknown[]) => ({
  untrackedReplies: vi.fn(async (offset: number, limit = 50) => ({ data: { data: { replies: all.slice(offset, offset + limit) } } })),
});
const open = async () => (await sql<{ id: string }[]>`select id from untracked_replies where handled_at is null order by id`).map((r) => r.id);

describe("the untracked-replies job", () => {
  beforeEach(async () => { await sql`delete from untracked_replies`; });

  it("reads every page, not just the first", async () => {
    const all = Array.from({ length: 120 }, (_, i) => reply(i + 1));
    const sl = fake(all);
    const r = await syncUntrackedReplies(sql, sl, { pageSize: 50 });
    expect(sl.untrackedReplies).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ open: 120, added: 120, handled: 0, pages: 3 });
    expect((await open()).length).toBe(120);
  });

  it("marks replies that left Smartlead's list as handled, and brings them back if they return", async () => {
    await syncUntrackedReplies(sql, fake([reply(1), reply(2), reply(3)]));
    const r = await syncUntrackedReplies(sql, fake([reply(1), reply(3)]));
    expect(r).toMatchObject({ open: 2, added: 0, handled: 1 });
    expect(await open()).toEqual(["1", "3"]);
    await syncUntrackedReplies(sql, fake([reply(1), reply(2), reply(3)]));
    expect(await open()).toEqual(["1", "2", "3"]);
  });

  it("marks nothing when the read is cut short", async () => {
    await syncUntrackedReplies(sql, fake([reply(1), reply(2), reply(3)]));
    const r = await syncUntrackedReplies(sql, fake([reply(1), reply(2), reply(3)]), { pageSize: 1, maxPages: 1 });
    expect(r).toMatchObject({ handled: 0, incomplete: "stopped after 1 pages" });
    expect((await open()).length).toBe(3);
  });

  it("fails, marking nothing, when Smartlead answers without a list", async () => {
    await syncUntrackedReplies(sql, fake([reply(1)]));
    const broken = { untrackedReplies: vi.fn(async () => ({ message: "Something went wrong" })) };
    await expect(syncUntrackedReplies(sql, broken)).rejects.toThrow(/without a list of replies/);
    expect(await open()).toEqual(["1"]);
  });

  it("an empty list means everything was dealt with", async () => {
    await syncUntrackedReplies(sql, fake([reply(1), reply(2)]));
    const r = await syncUntrackedReplies(sql, fake([]));
    expect(r).toMatchObject({ open: 0, handled: 2 });
    expect(await open()).toEqual([]);
  });
});
