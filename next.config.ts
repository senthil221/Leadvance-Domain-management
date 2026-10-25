import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // The old domain list is gone: domains live in Domains (inventory) and the
  // flagged ones in Smartlead. Old links and bookmarks keep working.
  async redirects() {
    return [
      { source: "/domains", has: [{ type: "query" as const, key: "view", value: "flagged" }], destination: "/inboxes?view=attention", permanent: false },
      { source: "/domains", destination: "/inventory", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
