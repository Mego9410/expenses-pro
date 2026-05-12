import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Avoid Next.js inferring an ancestor directory as the workspace root
  // (there's a package-lock.json higher up in C:\Users\olive).
  turbopack: {
    root: path.resolve(__dirname),
  },
  // exceljs has some optional deps that don't need bundling.
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
