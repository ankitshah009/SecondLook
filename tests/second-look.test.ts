import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, evaluateQuote, findAlternative, plans, type Requirements, type VerifiedQuote } from "@/lib/second-look";

const standard: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };

test("alternative selection respects all requirements and does not mutate candidates", () => {
  const candidates = [...plans];
  assert.equal(findAlternative(standard, candidates)?.id, "monthly");
  assert.equal(findAlternative({ ...standard, maxToday: 30 }, candidates), undefined);
  assert.equal(findAlternative({ maxToday: 500, billing: "annual", annualOk: true }, candidates)?.id, "annual");
  assert.deepEqual(candidates, plans);
});

test("annual prepayment fails while the $35 monthly plan fits a $40 monthly budget", () => {
  const annual = evaluate(standard, plans.find(plan => plan.id === "annual")!);
  const monthly = evaluate(standard, plans.find(plan => plan.id === "monthly")!);

  assert.equal(annual.eligible, false);
  assert.deepEqual(annual.checks.map(check => check.pass), [false, false, false]);
  assert.equal(monthly.eligible, true);
  assert.equal(monthly.plan.payableToday, 35);
  assert.deepEqual(monthly.checks.map(check => check.pass), [true, true, true]);
});

test("annual billing and commitment preferences accept the $348 annual plan under a $500 limit", () => {
  const requirements: Requirements = { maxToday: 500, billing: "annual", annualOk: true };
  const decision = evaluate(requirements, plans.find(plan => plan.id === "annual")!);

  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.payableToday, 348);
  assert.ok(decision.checks.every(check => check.pass));
});

test("no plan fits when the monthly limit is below both plans", () => {
  const requirements: Requirements = { maxToday: 30, billing: "monthly", annualOk: false };

  assert.equal(evaluate(requirements, plans.find(plan => plan.id === "annual")!).eligible, false);
  assert.equal(evaluate(requirements, plans.find(plan => plan.id === "monthly")!).eligible, false);
});

test("a rechecked quote is reevaluated against the amount due today", () => {
  const monthly = plans.find(plan => plan.id === "monthly")!;
  const quote: VerifiedQuote = {
    planId: "monthly", amount: 45, cadence: "monthly", commitment: false,
    capturedAt: new Date().toISOString(), url: "https://demo.secondlook.local/demo-storefront/quote-summary",
    passage: "Monthly plan: $45 payable today.", replay: false, provider: "local-browser",
  };

  const blocked = evaluateQuote(standard, monthly, quote);
  assert.equal(blocked.verifiedIdentity, true);
  assert.equal(blocked.decision.eligible, false);
  assert.equal(blocked.decision.checks[0].pass, false);

  const fits = evaluateQuote({ ...standard, maxToday: 50 }, monthly, quote);
  assert.equal(fits.verifiedIdentity, true);
  assert.equal(fits.decision.eligible, true);
  assert.equal(fits.decision.plan.payableToday, 45);
});

test("a changed plan identity cannot be treated as the reviewed quote", () => {
  const monthly = plans.find(plan => plan.id === "monthly")!;
  const quote: VerifiedQuote = {
    planId: "annual", amount: 45, cadence: "monthly", commitment: false,
    capturedAt: new Date().toISOString(), url: "https://demo.secondlook.local/demo-storefront/quote-summary",
    passage: "Annual plan: $45 payable today.", replay: false, provider: "local-browser",
  };

  assert.equal(evaluateQuote({ ...standard, maxToday: 50 }, monthly, quote).verifiedIdentity, false);
});
