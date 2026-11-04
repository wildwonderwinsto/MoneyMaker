import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM; load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
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
