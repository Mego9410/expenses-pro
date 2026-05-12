import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Parent repo (npm workspaces) has its own package-lock — without this,
  // Turbopack can infer the wrong root and fail to resolve `next`.
  turbopack: {
    root: path.join(__dirname),
  },
  // exceljs has some optional deps that don't need bundling.
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
