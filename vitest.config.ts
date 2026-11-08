import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only the @/ alias from tsconfig.json, so tests can import modules that use it
// (the page queries in src/lib/queries.ts). Everything else is Vitest's default.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
