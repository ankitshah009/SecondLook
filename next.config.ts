import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["@mastra/core", "@mastra/ai-sdk", "playwright-core", "@onkernel/sdk"],
};
export default nextConfig;
