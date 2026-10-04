import assert from "node:assert/strict";
import test from "node:test";
import { idempotencyKey } from "@/lib/quote-store";
import type { VerifiedQuote } from "@/lib/second-look";

const verifiedQuote: VerifiedQuote = {
  planId: "monthly", amount: 35, cadence: "monthly", commitment: false,
  url: "https://demo.secondlook.local/demo-storefront/quote-summary?plan=monthly",
  capturedAt: "2026-10-04T12:00:00.000Z", passage: "$35 payable today.",
  replay: false, provider: "local-browser",
};
const record = { analysisId: "analysis-one", planId: "monthly" as const, amount: 35, verifiedQuote };

test("repeated approval of an exact quote keeps the same idempotency identity", () => {
  assert.equal(idempotencyKey(record), idempotencyKey({ ...record, verifiedQuote: {
    ...verifiedQuote, capturedAt: "2026-10-04T12:01:00.000Z",
  } }));
});

test("a changed amount, plan, analysis or quote URL gets a distinct identity", () => {
  const original = idempotencyKey(record);
  for (const changed of [
    { ...record, amount: 45 },
    { ...record, planId: "annual" as const },
    { ...record, analysisId: "analysis-two" },
    { ...record, verifiedQuote: { ...verifiedQuote, url: `${verifiedQuote.url}&revision=final` } },
  ]) assert.notEqual(idempotencyKey(changed), original);
});
