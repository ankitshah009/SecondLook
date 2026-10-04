import { NextResponse } from "next/server";
import { gatewayConfigured } from "@/mastra";
export async function GET() {
  return NextResponse.json({
    browser: process.env.KERNEL_API_KEY && process.env.BROWSER_PROVIDER !== "local" ? "kernel" : "local-browser",
    persistence: process.env.DATABASE_URL ? "neon" : "memory",
    gateway: gatewayConfigured(), exa: Boolean(process.env.EXA_API_KEY),
    agentmail: Boolean(process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID),
    synthetic: true, configurationOnly: true,
  });
}
