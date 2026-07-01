import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Skip type checking in CI - we run it separately
  typescript: {
    ignoreBuildErrors: false,
  },
  // All pages that use Supabase need to be dynamic
  experimental: {},
  // Navigation was consolidated into section hubs (Broadcasts, Leads, Campaigns,
  // Analytics, Settings). Keep the old top-level URLs working — bookmarks, saved
  // links, and any external references 307 to their new home. Query strings
  // (e.g. ?smart_list_id=…) are preserved automatically. Temporary (not 308) so
  // the mapping can still be revised without poisoning client caches.
  async redirects() {
    return [
      { source: "/mass-sms", destination: "/broadcasts/sms", permanent: false },
      { source: "/mass-email", destination: "/broadcasts/email", permanent: false },
      { source: "/broadcast-audit", destination: "/broadcasts/audit", permanent: false },
      { source: "/smart-lists", destination: "/leads/lists", permanent: false },
      { source: "/smart-lists/:path*", destination: "/leads/lists/:path*", permanent: false },
      { source: "/funnel", destination: "/campaigns/playbook", permanent: false },
      { source: "/agent-kpi", destination: "/analytics/agents", permanent: false },
      { source: "/agent-kpi/:path*", destination: "/analytics/agents/:path*", permanent: false },
      { source: "/ai-control", destination: "/settings/ai", permanent: false },
      { source: "/team", destination: "/settings/team", permanent: false },
      { source: "/billing", destination: "/settings/billing", permanent: false },
    ];
  },
};

export default nextConfig;
