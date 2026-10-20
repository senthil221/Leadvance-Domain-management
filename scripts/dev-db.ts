// Local Postgres for development, no Docker needed: PGlite (Postgres in WASM)
// served over TCP on 127.0.0.1:54322 and stored in .data/pglite.
// Usage: npm run db:dev   (then npm run db:migrate && npm run db:seed)
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.DEV_DB_PORT ?? 54322);
const db = await PGlite.create("./.data/pglite");
// PGlite is single-connection; the server queues queries from several clients.
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
await server.start();
console.log(`dev database listening on postgres://postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
