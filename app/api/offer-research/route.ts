import { handleRealOfferRequest } from "@/lib/real-offer";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleRealOfferRequest(request, { apiKey: process.env.EXA_API_KEY });
}
