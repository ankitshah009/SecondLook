import assert from "node:assert/strict";
import test from "node:test";
import { issueAnalysisToken, verifyAnalysisToken } from "@/lib/approval-token";
import { createEvidenceTools, eligibilityInputSchema } from "@/mastra/tools";
import { POST as postChat } from "@/app/api/chat/route";
import type { Requirements, Plan } from "@/lib/second-look";

const requirements: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };
const annual: Plan = { id: "annual", name: "Annual", cadence: "annual", payableToday: 348, monthlyEquivalent: 29, commitment: true, url: "https://store.example/demo-storefront/pricing", evidenceIds: ["annual-price", "annual-term"] };
const monthly: Plan = { id: "monthly", name: "Monthly", cadence: "monthly", payableToday: 35, monthlyEquivalent: 35, commitment: false, url: "https://store.example/demo-storefront/pricing", evidenceIds: ["monthly-price", "monthly-term"] };
function signedClaims(overrides: Partial<Parameters<typeof issueAnalysisToken>[0]> = {}) {
  return verifyAnalysisToken(issueAnalysisToken({
    analysisId: "123e4567-e89b-42d3-a456-426614174000", requirements,
    sourceUrl: "https://store.example/demo-storefront/offer",
    findings: [
      { id: "monthly-price", field: "Payment today", value: "$35", passage: "Monthly is $35 due today.", url: monthly.url, capturedAt: new Date().toISOString(), subject: "Monthly plan", status: "established", sourceKind: "browser" },
      { id: "monthly-term", field: "Billing", value: "Monthly", passage: "Billed monthly.", url: monthly.url, capturedAt: new Date().toISOString(), subject: "Monthly plan", status: "established", sourceKind: "browser" },
      { id: "annual-price", field: "Payment today", value: "$348", passage: "Annual is $348 due today.", url: annual.url, capturedAt: new Date().toISOString(), subject: "Annual plan", status: "established", sourceKind: "browser" },
      { id: "unresolved", field: "Cancellation", value: "Not established", passage: "Retrieval failed.", url: annual.url, capturedAt: new Date().toISOString(), subject: "Plans", status: "unresolved", sourceKind: "browser" },
    ], selectedPlan: monthly, originalPlan: annual,
    quoteUrl: "https://store.example/demo-storefront/quote-summary", quoteAmount: 35,
    ...overrides,
  }));
}

test("agent tools evaluate signed requirements and return only established signed passages", async () => {
  const tools = createEvidenceTools(signedClaims());
  type DecisionResult = { eligible: boolean; plan: Plan };
  type ExtractResult = { plans: { plan: Plan; evidence: { id: string }[] }[] };
  const invoke = async <T>(tool: unknown, input: unknown): Promise<T> => {
    const execute = (tool as { execute?: unknown }).execute;
    if (typeof execute !== "function") throw new Error("Tool does not expose an execute function.");
    return await execute.call(tool, input, {}) as T;
  };
  const monthlyDecision = await invoke<DecisionResult>(tools.checkEligibility, { planId: "monthly" });
  const annualDecision = await invoke<DecisionResult>(tools.checkEligibility, { planId: "annual" });
  const extracted = await invoke<ExtractResult>(tools.extractPlans, {});

  assert.equal(monthlyDecision.eligible, true);
  assert.equal(monthlyDecision.plan.payableToday, 35);
  assert.equal(annualDecision.eligible, false);
  assert.equal(extracted.plans.length, 2);
  assert.deepEqual(extracted.plans[0].evidence.map(item => item.id), ["annual-price"]);
  assert.ok(extracted.plans.every(item => !item.evidence.some(evidence => evidence.id === "unresolved")));
});

test("same-storefront search excludes signed plans from another origin", async () => {
  const claims = signedClaims({ selectedPlan: { ...monthly, url: "https://other.example/pricing" } });
  const result = await createEvidenceTools(claims).searchAlternatives.execute!({}, {} as never) as { candidates: { plan: Plan; eligible: boolean }[] };

  assert.deepEqual(result.candidates.map(candidate => candidate.plan.id), ["annual"]);
  assert.equal(result.candidates[0].eligible, false);
});

test("eligibility tool cannot accept model-supplied price or preference claims", async () => {
  assert.equal(eligibilityInputSchema.safeParse({ planId: "monthly", payableToday: 0, maxToday: 10000 }).success, false);
});

test("chat reports missing gateway setup without claiming provider availability", async () => {
  const oldBaseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  const oldToken = process.env.NEON_AI_GATEWAY_TOKEN;
  delete process.env.NEON_AI_GATEWAY_BASE_URL;
  delete process.env.NEON_AI_GATEWAY_TOKEN;
  try {
    const response = await postChat(new Request("http://localhost/api/chat", { method: "POST", body: "not-json" }));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Connect the Neon AI Gateway/);
  } finally {
    if (oldBaseUrl === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL;
    else process.env.NEON_AI_GATEWAY_BASE_URL = oldBaseUrl;
    if (oldToken === undefined) delete process.env.NEON_AI_GATEWAY_TOKEN;
    else process.env.NEON_AI_GATEWAY_TOKEN = oldToken;
  }
});
