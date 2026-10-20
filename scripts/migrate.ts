// Applies pending migrations to DATABASE_URL. Usage: npm run db:migrate
import postgres from "postgres";
import { migrate } from "./migrations";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 1, onnotice: () => {} });

await migrate(
  {
    exec: (text) => sql.unsafe(text).simple(),
    applied: async () => (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
    record: (name) => sql`insert into _migrations (name) values (${name})`,
  },
  console.log,
);
console.log("database is up to date");
await sql.end();
