import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

export type Migration = { name: string; sql: string };

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

type Exec = {
  exec: (sql: string) => Promise<unknown>;
  applied: () => Promise<string[]>;
  record: (name: string) => Promise<unknown>;
};

// Applies every migration not yet recorded in _migrations, in file order.
export async function migrate(db: Exec, log: (msg: string) => void = () => {}) {
  await db.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(await db.applied());
  for (const m of loadMigrations()) {
    if (done.has(m.name)) continue;
    await db.exec(m.sql);
    await db.record(m.name);
    log(`applied ${m.name}`);
  }
}
