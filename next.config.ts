import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Skip type checking in CI - we run it separately
  typescript: {
    ignoreBuildErrors: false,
  },
  // All pages that use Supabase need to be dynamic
  experimental: {},
};

export default nextConfig;
