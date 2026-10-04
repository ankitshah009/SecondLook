import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { approvalRequestSchema, evaluate, evaluateQuote, moneyCents, type DecisionRecord } from "@/lib/second-look";
import { issueAnalysisToken, verifyAnalysisToken, type AnalysisClaims } from "@/lib/approval-token";
import { recheckQuote } from "@/lib/browser-inspection";
import { saveDecisionRecord } from "@/lib/quote-store";

export const maxDuration = 60;
export async function POST(request: Request) {
  let body;
  try { body = approvalRequestSchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Approval details are incomplete. Check the offer again.", saved: false }, { status: 400 }); }
  let claims: AnalysisClaims;
  try { claims = verifyAnalysisToken(body.analysisToken); }
  catch { return NextResponse.json({ error: "This review is invalid or expired. Check the offer again.", saved: false }, { status: 400 }); }
  if (body.planId !== claims.selectedPlan.id || moneyCents(body.expectedAmount) !== moneyCents(claims.quoteAmount)) {
    return NextResponse.json({ error: "The approval doesn’t match the exact reviewed plan and amount. Nothing was saved.", saved: false }, { status: 409 });
  }
  let inspection;
  try { inspection = await recheckQuote(claims.quoteUrl, new URL(request.url).origin, request.signal); }
  catch {
    return NextResponse.json({ error: "The final quote could not be retrieved. Nothing was saved. Retry the source inspection.", saved: false }, { status: 503 });
  }
  const { verifiedQuote, browserCapture } = inspection;
  const checked = evaluateQuote(claims.requirements, claims.selectedPlan, verifiedQuote);
  if (!checked.verifiedIdentity) return NextResponse.json({ error: "The selected plan, billing, or commitment changed. Approval is blocked; check the offer again.", saved: false }, { status: 409 });
  if (moneyCents(verifiedQuote.amount) !== moneyCents(claims.quoteAmount)) {
    return NextResponse.json({
      error: "The final quote changed. Review the new total and decision before approving again.",
      changed: true, saved: false, verifiedQuote, browserCapture, reevaluatedDecision: checked.decision,
      analysisToken: checked.decision.eligible ? issueAnalysisToken({ ...claims, selectedPlan: checked.decision.plan, quoteUrl: verifiedQuote.url, quoteAmount: verifiedQuote.amount }) : null,
    }, { status: 409 });
  }
  if (!checked.decision.eligible) return NextResponse.json({ error: checked.decision.reason, reevaluatedDecision: checked.decision, saved: false }, { status: 422 });
  const record: DecisionRecord = {
    id: "SL-" + randomUUID().slice(0, 8).toUpperCase(), analysisId: claims.analysisId,
    planId: claims.selectedPlan.id, amount: verifiedQuote.amount, createdAt: new Date().toISOString(),
    requirements: claims.requirements, originalDecision: evaluate(claims.requirements, claims.originalPlan),
    selectedDecision: checked.decision, findings: claims.findings, verifiedQuote,
  };
  try {
    const saved = await saveDecisionRecord(record);
    return NextResponse.json({ quote: saved.record, duplicate: saved.duplicate, persistence: saved.persistence });
  } catch {
    return NextResponse.json({ error: "Neon storage is unavailable. Nothing was confirmed as saved. Check DATABASE_URL and retry.", saved: false }, { status: 503 });
  }
}
