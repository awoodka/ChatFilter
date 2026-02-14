import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fix dev-only cross-origin asset warning when you open the dev server via LAN IP
  // (e.g. http://10.x.x.x:3000). This helps ensure client JS hydrates properly.
  allowedDevOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "http://10.216.154.215:3000"],
};

export default nextConfig;
