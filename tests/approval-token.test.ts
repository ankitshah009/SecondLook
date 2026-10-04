import assert from "node:assert/strict";
import test from "node:test";
import { verifyAnalysisToken, issueAnalysisToken } from "@/lib/approval-token";
import { approvalRequestSchema, plans, type Requirements } from "@/lib/second-look";

const requirements: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };
const absolutePlans = plans.map(plan => ({ ...plan, url: "https://demo.secondlook.local/demo-storefront/pricing" }));

test("analysis token round-trips its signed approval claims", () => {
  const monthly = absolutePlans.find(plan => plan.id === "monthly")!;
  const token = issueAnalysisToken({
    analysisId: "123e4567-e89b-42d3-a456-426614174000",
    requirements,
    sourceUrl: "https://demo.secondlook.local/demo-storefront/offer",
    findings: [],
    selectedPlan: monthly,
    originalPlan: absolutePlans.find(plan => plan.id === "annual")!,
    quoteUrl: "https://demo.secondlook.local/demo-storefront/quote-summary?plan=monthly",
    quoteAmount: 35,
  });

  const claims = verifyAnalysisToken(token);
  assert.equal(claims.analysisId, "123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(claims.requirements, requirements);
  assert.equal(claims.selectedPlan.id, "monthly");
  assert.equal(claims.quoteAmount, 35);
  assert.ok(claims.expiresAt > Date.now());
});

test("modified token signatures are rejected", () => {
  const monthly = absolutePlans.find(plan => plan.id === "monthly")!;
  const token = issueAnalysisToken({
    analysisId: "123e4567-e89b-42d3-a456-426614174000",
    requirements,
    sourceUrl: "https://demo.secondlook.local/demo-storefront/offer",
    findings: [],
    selectedPlan: monthly,
    originalPlan: absolutePlans.find(plan => plan.id === "annual")!,
    quoteUrl: "https://demo.secondlook.local/demo-storefront/quote-summary?plan=monthly",
    quoteAmount: 35,
  });
  const [payload, signature] = token.split(".");
  const replacement = signature.endsWith("A") ? "B" : "A";

  assert.throws(() => verifyAnalysisToken(payload + "." + signature.slice(0, -1) + replacement), /could not be verified/);
});

test("a maximum-length Unicode pasted offer remains approvable without losing its passage", () => {
  const passage = "价".repeat(20_000);
  const token = issueAnalysisToken({
    analysisId: "123e4567-e89b-42d3-a456-426614174000", requirements,
    sourceUrl: "https://demo.secondlook.local/offer",
    findings: [{ id: "pasted", field: "Pasted text", value: "Unverified", passage,
      url: "https://demo.secondlook.local/offer", capturedAt: new Date().toISOString(), subject: "User-provided context", status: "unresolved", sourceKind: "pasted" }],
    selectedPlan: absolutePlans.find(plan => plan.id === "monthly")!, originalPlan: absolutePlans.find(plan => plan.id === "annual")!,
    quoteUrl: "https://demo.secondlook.local/demo-storefront/quote-summary?plan=monthly", quoteAmount: 35,
  });
  assert.ok(approvalRequestSchema.safeParse({ analysisToken: token, planId: "monthly", expectedAmount: 35 }).success);
  assert.equal(verifyAnalysisToken(token).findings[0].passage, passage);
});
