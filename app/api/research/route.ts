import { handleResearchRequest } from "@/lib/research";

export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handleResearchRequest(request, { apiKey: process.env.EXA_API_KEY });
}
