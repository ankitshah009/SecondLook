import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { analyzeOffer } from "@/lib/workflow";
import { recheckQuote } from "@/lib/browser-inspection";
import { verifyAnalysisToken } from "@/lib/approval-token";
import { evaluateQuote, type DecisionRecord } from "@/lib/second-look";
import { readDecisionRecord, saveDecisionRecord } from "@/lib/quote-store";

let stage = "environment setup";
async function run() {
  stage = "Next environment loader";
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  stage = "required DATABASE_URL configuration";
  assert.ok(process.env.DATABASE_URL, "Configure DATABASE_URL before verifying persistence.");
  stage = "required signing-secret configuration";
  assert.ok(process.env.SECOND_LOOK_SIGNING_SECRET, "Configure the stable signing secret.");
  stage = "base URL configuration";
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  stage = "process-isolated environment configuration";
  console.log("Database-isolation test: real local browser + Neon; Gateway is deliberately excluded in this test process only.");
  const names = ["NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN", "BROWSER_PROVIDER", "APP_URL"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.NEON_AI_GATEWAY_BASE_URL;
    delete process.env.NEON_AI_GATEWAY_TOKEN;
    process.env.BROWSER_PROVIDER = "local";
    process.env.APP_URL = baseUrl;
    const signal = AbortSignal.timeout(90_000);
    const requirements = { maxToday: 40, billing: "monthly" as const, annualOk: false };
    stage = "browser inspection";
    const analysis = await analyzeOffer({ url: "https://demo.secondlook.local/offer", requirements, pastedText: "" }, baseUrl, undefined, signal);
    assert.equal(analysis.extraction, "deterministic-fixture");
    assert.ok(analysis.analysisToken);
    const claims = verifyAnalysisToken(analysis.analysisToken);
    const { verifiedQuote } = await recheckQuote(claims.quoteUrl, baseUrl, signal);
    const checked = evaluateQuote(requirements, claims.selectedPlan, verifiedQuote);
    assert.equal(checked.verifiedIdentity, true);
    assert.equal(checked.decision.eligible, true);
    assert.equal(verifiedQuote.amount, 35);
    const record: DecisionRecord = {
      id: "SL-" + randomUUID().slice(0, 8).toUpperCase(), analysisId: analysis.id,
      planId: verifiedQuote.planId, amount: verifiedQuote.amount, createdAt: new Date().toISOString(),
      requirements, originalDecision: analysis.initial, selectedDecision: checked.decision,
      findings: analysis.findings, verifiedQuote,
    };
    stage = "Neon save";
    const saved = await saveDecisionRecord(record);
    assert.equal(saved.persistence, "neon");
    assert.equal(saved.duplicate, false);
    stage = "Neon read-back";
    const readBack = await readDecisionRecord(saved.record.id);
    assert.deepEqual(readBack, saved.record);
    stage = "duplicate protection";
    const repeated = await saveDecisionRecord({ ...record, id: "SL-" + randomUUID().slice(0, 8).toUpperCase() });
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.record.id, saved.record.id);
    console.log(`Neon persistence passed: ${saved.record.id}, verified $35 demo quote, exact read-back and duplicate protection. This does not certify Gateway or Kernel.`);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
}
run().catch(error => {
  const name = error instanceof Error ? error.name : "unknown error";
  const rawMessage = error instanceof Error ? error.message : "unexpected failure";
  const message = rawMessage.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"']+/gi, "[redacted address]").replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted credential]").slice(0, 180);
  console.error(`Neon persistence verification failed at ${stage} (${name}: ${message}). No full-stack success is claimed.`);
  process.exitCode = 1;
});
