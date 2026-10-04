import { NextResponse } from "next/server";
import { verifyAnalysisToken } from "@/lib/approval-token";
import { readDecisionRecord } from "@/lib/quote-store";
import { z } from "zod";

const requestSchema = z.object({ id: z.string().regex(/^SL-[A-F0-9]{8}$/), analysisToken: z.string().min(20).max(128_000) });

export async function POST(request: Request) {
  let body, claims;
  try { body = requestSchema.parse(await request.json()); claims = verifyAnalysisToken(body.analysisToken); }
  catch { return NextResponse.json({ error: "A valid record review is required." }, { status: 400 }); }
  try {
    const record = await readDecisionRecord(body.id);
    if (!record || record.analysisId !== claims.analysisId) return NextResponse.json({ error: "This record was not found for your review." }, { status: 404 });
    return NextResponse.json({ record });
  } catch { return NextResponse.json({ error: "The decision record could not be retrieved." }, { status: 503 }); }
}
