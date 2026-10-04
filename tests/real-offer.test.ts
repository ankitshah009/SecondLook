import assert from "node:assert/strict";
import test from "node:test";
import {
  handleRealOfferRequest,
  runRealOfferResearch,
  type RealOfferDependencies,
} from "@/lib/real-offer";
import {
  ResearchUnavailableError,
  type ResearchResult,
} from "@/lib/research";
import type { Requirements } from "@/lib/second-look";

const url = "https://orbit.example/plans/plus";
const requirements: Requirements = { maxToday: 50, billing: "monthly", annualOk: false };
const exactClause = "Orbit Studio Plus plan is USD 45 due today, billed monthly, no annual commitment.";

function researchResult(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    sources: [{
      id: "offer-1", title: "Orbit Studio Plus", url, passage: exactClause, capturedAt: "2026-10-04T12:00:00.000Z",
      subject: "Submitted offer page", status: "retrieved", sourceKind: "exa",
    }],
    limitations: [
      "Search is restricted to orbit.example and the submitted offer URL; coverage may be incomplete or stale.",
      "Domain-matched passages may refer to other products or plans; applicability to the exact offer has not been established.",
      "This is read-only research. It does not determine eligibility, recommend a plan, approve a purchase, or enable checkout.",
    ],
    mode: "research-only",
    checkoutEnabled: false,
    ...overrides,
  };
}

function deps(result: ResearchResult, extras: Partial<RealOfferDependencies> = {}): RealOfferDependencies {
  return { research: async () => result, gatewayAvailable: () => false, ...extras };
}

test("complete exact-page terms produce a deterministic preference check, not a verified quote", async () => {
  const result = await runRealOfferResearch({ url, requirements }, deps(researchResult()));
  assert.equal(result.fields.productPlan.value, "Orbit Studio Plus");
  assert.deepEqual(result.fields.amountDueToday.value, { amount: 45, currency: "USD" });
  assert.equal(result.fields.billingCadence.value, "monthly");
  assert.equal(result.fields.annualCommitment.value, false);
  assert.equal(result.assessment.status, "fits");
  assert.equal(result.assessment.eligible, true);
  assert.equal(result.assessment.checks?.length, 3);
  assert.equal(result.fields.productPlan.evidence?.sourceId, "offer-1");
  assert.equal(result.fields.cancellationPolicy.status, "unresolved");
  assert.equal(result.checkoutEnabled, false);
  assert.equal(result.verifiedDemoQuote, false);
  assert.equal(result.mode, "real-offer-research");
});

test("explicit exact-page terms that fail a preference report does-not-fit", async () => {
  const result = await runRealOfferResearch({
    url, requirements: { maxToday: 30, billing: "monthly", annualOk: false },
  }, deps(researchResult()));
  assert.equal(result.assessment.status, "does-not-fit");
  assert.equal(result.assessment.eligible, false);
  assert.equal(result.assessment.checks?.[0].pass, false);
});

test("domain search result cannot establish exact-plan price or applicability", async () => {
  const source = { ...researchResult().sources[0], url: "https://orbit.example/legal/terms", subject: "orbit.example · Pricing and plans" };
  const result = await runRealOfferResearch({ url, requirements }, deps(researchResult({ sources: [source] })));
  assert.equal(result.fields.productPlan.status, "unresolved");
  assert.equal(result.fields.amountDueToday.value, null);
  assert.equal(result.assessment.status, "unresolved");
});

test("pasted terms and non-USD or incomplete clauses never fill missing exact-page facts", async () => {
  const weak = "Orbit Studio Plus plan costs $45, billed monthly. Cancellation any time.";
  const base = researchResult({ sources: [
    { ...researchResult().sources[0], passage: "Pricing is shown below." },
    { id: "pasted-1", title: "Pasted offer text", url, passage: weak, capturedAt: "2026-10-04T12:00:00.000Z", subject: "User-provided context", status: "unresolved", sourceKind: "pasted" },
  ] });
  const result = await runRealOfferResearch({ url, pastedText: weak, requirements }, deps(base));
  assert.equal(result.fields.amountDueToday.status, "unresolved");
  assert.equal(result.fields.billingCadence.status, "unresolved");
  assert.equal(result.fields.cancellationPolicy.status, "unresolved");
  assert.equal(result.assessment.eligible, null);
});

test("missing product applicability, commitment, or a same-clause price leaves assessment unresolved", async () => {
  for (const passage of [
    "USD 45 due today, billed monthly, no annual commitment.",
    "Orbit Studio Plus plan is USD 45 due today, billed monthly.",
    "Orbit Studio Plus plan is USD 45 due today. It is billed monthly, no annual commitment.",
  ]) {
    const result = await runRealOfferResearch({ url, requirements }, deps(researchResult({ sources: [{ ...researchResult().sources[0], passage }] })));
    assert.equal(result.assessment.status, "unresolved", passage);
    assert.equal(result.fields.productPlan.status, "unresolved", passage);
  }
});

test("optional Gateway clause candidates must be literal source substrings", async () => {
  const source = { ...researchResult().sources[0], passage: "Orbit Studio Plus plan is USD 45 due today, billed monthly, no annual commitment." };
  let called = false;
  const result = await runRealOfferResearch({ url, requirements }, deps(researchResult({ sources: [source] }), {
    gatewayAvailable: () => true,
    extractClauses: async () => { called = true; return ["Orbit Studio Plus plan is USD 999 due today, billed monthly, no annual commitment."]; },
  }));
  assert.equal(called, true);
  assert.equal(result.fields.amountDueToday.value?.amount, 45);
});

test("requirements are validated before research I/O", async () => {
  let called = false;
  await assert.rejects(() => runRealOfferResearch({ url, requirements: { ...requirements, maxToday: -1 } }, {
    research: async () => { called = true; return researchResult(); },
  }));
  assert.equal(called, false);
});

test("missing Exa configuration returns an actionable 503 without a fake result", async () => {
  const request = new Request("http://localhost/api/offer-research", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, requirements }),
  });
  const response = await handleRealOfferRequest(request, {
    apiKey: "", research: async (_input, options) => {
      // The real research helper owns missing-key behavior; emulate it without network I/O.
      assert.equal(options?.apiKey, "");
      throw new ResearchUnavailableError("Offer research is unavailable because EXA_API_KEY is not configured.");
    },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /EXA_API_KEY/);
});

test("HTTP helper propagates request abort to the research edge and returns cancelled status", async () => {
  const controller = new AbortController();
  const request = new Request("http://localhost/api/offer-research", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, requirements }), signal: controller.signal,
  });
  const responsePromise = handleRealOfferRequest(request, {
    research: async (_input, options) => {
      controller.abort();
      assert.equal(options?.signal?.aborted, true);
      throw new ResearchUnavailableError();
    },
  });
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.match((await response.json()).error, /cancelled/i);
});
