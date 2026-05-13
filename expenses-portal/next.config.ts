import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Monorepo root must match Vercel’s `outputFileTracingRoot` (/vercel/path0) or
  // Next warns and Turbopack can mis-resolve deps.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  // exceljs has some optional deps that don't need bundling.
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
