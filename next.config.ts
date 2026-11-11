import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM; load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // `next dev` only. With the dev cache kept in .next/dev between runs, the first page
    // opened after a restart was told to reload about 80 times in a row (checked twice,
    // 2026-11-11; a clean start never did it). Costs a few seconds on each dev start.
    turbopackFileSystemCacheForDev: false,
  },
  cacheComponents: true,
  partialPrefetching: true,
  typescript: {
    // Render's free build machine runs out of memory type-checking. Types are still
    // enforced: CI runs `npm run typecheck`, and Render only deploys after CI passes
    // (autoDeployTrigger: checksPass). Local and CI builds keep the full check.
    ignoreBuildErrors: process.env.RENDER === "true",
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
