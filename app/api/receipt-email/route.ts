import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAnalysisToken, type AnalysisClaims } from "@/lib/approval-token";
import { readDecisionRecord } from "@/lib/quote-store";
import { matchesSignedDecisionRecord, sendDecisionReceipt } from "@/lib/receipt-mail";
import type { DecisionRecord } from "@/lib/second-look";

export const maxDuration = 45;
const requestSchema = z.object({
  id: z.string().min(1).max(128),
  analysisToken: z.string().min(20).max(128_000),
  to: z.string().trim().email().max(254),
}).strict();

type ApiOutcome =
  | { status: "accepted"; messageId: string; duplicate: boolean }
  | { status: "unknown" | "pending" | "not_sent"; error: string };

const MAX_BODY_BYTES = 160 * 1024;
async function readJsonBounded(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Request too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function POST(request: Request) {
  let body: z.infer<typeof requestSchema>;
  try { body = requestSchema.parse(await readJsonBounded(request)); }
  catch { return NextResponse.json({ status: "not_sent", error: "Provide a saved record ID, valid signed review, and recipient email." } satisfies ApiOutcome, { status: 400 }); }

  let claims: AnalysisClaims;
  try { claims = verifyAnalysisToken(body.analysisToken); }
  catch { return NextResponse.json({ status: "not_sent", error: "The signed review is invalid or expired. No email was sent." } satisfies ApiOutcome, { status: 400 }); }

  let record: DecisionRecord | null;
  try { record = await readDecisionRecord(body.id); }
  catch { return NextResponse.json({ status: "not_sent", error: "The saved decision could not be read. No email was sent." } satisfies ApiOutcome, { status: 503 }); }
  if (!record) return NextResponse.json({ status: "not_sent", error: "No saved decision exists for that record ID." } satisfies ApiOutcome, { status: 404 });
  if (!matchesSignedDecisionRecord(record, body.id, claims)) {
    return NextResponse.json({ status: "not_sent", error: "The saved decision does not match this exact signed analysis and quote. No email was sent." } satisfies ApiOutcome, { status: 409 });
  }

  const outcome = await sendDecisionReceipt(record, body.to, { signal: request.signal });
  if (outcome.status === "accepted") return NextResponse.json(outcome, { status: 200 });
  if (outcome.status === "pending") return NextResponse.json({ status: outcome.status, error: outcome.error } satisfies ApiOutcome, { status: 409 });
  if (outcome.status === "unknown") return NextResponse.json({ status: outcome.status, error: outcome.error } satisfies ApiOutcome, { status: outcome.duplicate ? 409 : 503 });
  return NextResponse.json({ status: outcome.status, error: outcome.error } satisfies ApiOutcome, { status: 503 });
}
