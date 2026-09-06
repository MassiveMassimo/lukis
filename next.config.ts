import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the development indicator clear of the bottom-left theme button.
  devIndicators: { position: "top-left" },
};

export default nextConfig;
