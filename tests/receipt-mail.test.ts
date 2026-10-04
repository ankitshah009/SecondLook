import assert from "node:assert/strict";
import test from "node:test";
import { issueAnalysisToken, verifyAnalysisToken } from "@/lib/approval-token";
import { buildDecisionReceipt, matchesSignedDecisionRecord, sendDecisionReceipt, type ReceiptOutbox } from "@/lib/receipt-mail";
import { evaluate, type DecisionRecord, type Plan, type Requirements } from "@/lib/second-look";

const requirements: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };
const monthly: Plan = { id: "monthly", name: "Monthly", cadence: "monthly", payableToday: 35, monthlyEquivalent: 35, commitment: false, url: "https://store.example/demo-storefront/pricing", evidenceIds: ["monthly-price"] };
const annual: Plan = { id: "annual", name: "Annual", cadence: "annual", payableToday: 348, monthlyEquivalent: 29, commitment: true, url: "https://store.example/demo-storefront/pricing", evidenceIds: ["annual-price"] };
const analysisId = "123e4567-e89b-42d3-a456-426614174000";
function makeDecision() {
  const quote = { planId: "monthly" as const, amount: 35, cadence: "monthly" as const, commitment: false, capturedAt: "2026-10-04T12:00:00.000Z", url: "https://store.example/demo-storefront/quote-summary?plan=monthly", passage: "Monthly plan: $35 due today.", replay: false, provider: "local-browser" as const };
  const record: DecisionRecord = {
    id: "SL-ABC12345", analysisId, planId: "monthly", amount: 35, createdAt: "2026-10-04T12:00:00.000Z",
    requirements, originalDecision: evaluate(requirements, annual), selectedDecision: evaluate(requirements, monthly),
    findings: [{ id: "monthly-price", field: "Payment today", value: "$35", passage: "Monthly plan: $35 due today.", url: monthly.url, capturedAt: quote.capturedAt, subject: "Monthly plan", status: "established", sourceKind: "browser" }],
    verifiedQuote: quote,
  };
  const token = issueAnalysisToken({ analysisId, requirements, sourceUrl: "https://store.example/demo-storefront/offer", findings: record.findings,
    selectedPlan: monthly, originalPlan: annual, quoteUrl: quote.url, quoteAmount: quote.amount });
  return { record, token, claims: verifyAnalysisToken(token) };
}

function fakeOutbox() {
  const rows = new Map<string, { state: "pending" | "accepted" | "unknown"; messageId?: string }>();
  const key = (id: string, recipientKey: string) => id + ":" + recipientKey;
  let reservations = 0;
  const outbox: ReceiptOutbox = {
    async reserve(id, recipientKey) {
      reservations++;
      const rowKey = key(id, recipientKey);
      const existing = rows.get(rowKey);
      if (existing) return { kind: "existing", ...existing };
      rows.set(rowKey, { state: "pending" });
      return { kind: "reserved" };
    },
    async accepted(id, recipientKey, messageId) { rows.set(key(id, recipientKey), { state: "accepted", messageId }); },
    async unknown(id, recipientKey) { rows.set(key(id, recipientKey), { state: "unknown" }); },
  };
  return { outbox, rows, get reservations() { return reservations; } };
}

const config = { apiKey: "test-only-key", inboxId: "test-inbox" };

test("production without Neon blocks receipt sending before provider I/O", async () => {
  const { record } = makeDecision();
  const previousDatabase = process.env.DATABASE_URL;
  const previousMode = process.env.NODE_ENV;
  delete process.env.DATABASE_URL;
  Reflect.set(process.env, "NODE_ENV", "production");
  let calls = 0;
  try {
    const outcome = await sendDecisionReceipt(record, "person@example.com", {
      ...config, fetcher: async () => { calls++; throw new Error("Provider must never be contacted."); },
    });
    assert.equal(outcome.status, "not_sent");
    assert.equal(calls, 0);
    if (outcome.status === "not_sent") assert.match(outcome.error, /DATABASE_URL/);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", previousMode);
  }
});

test("receipt authorization binds saved record, analysis, plan, and exact quote amount", () => {
  const { record, claims } = makeDecision();
  assert.equal(matchesSignedDecisionRecord(record, record.id, claims), true);
  assert.equal(matchesSignedDecisionRecord({ ...record, amount: 35.01 }, record.id, claims), false);
  assert.equal(matchesSignedDecisionRecord(record, "SL-OTHER", claims), false);
  assert.equal(matchesSignedDecisionRecord({ ...record, analysisId: "123e4567-e89b-42d3-a456-426614174001" }, record.id, claims), false);
  assert.equal(matchesSignedDecisionRecord({ ...record, planId: "annual" }, record.id, claims), false);
});

test("receipt is built only from saved decision facts and clearly says no payment occurred", () => {
  const { record } = makeDecision();
  const receipt = buildDecisionReceipt(record);
  assert.match(receipt.text, /synthetic receipt/);
  assert.match(receipt.text, /No payment was made/);
  assert.match(receipt.text, /not charged/);
  assert.match(receipt.text, /SL-ABC12345/);
  assert.doesNotMatch(receipt.text, /https:\/\//);
  assert.doesNotMatch(receipt.text, /Monthly plan: \$35 due today/);
});

test("provider success requires message_id and repeated recipient returns accepted without resending", async () => {
  const { record } = makeDecision();
  const stored = fakeOutbox();
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, "https://api.agentmail.to/v0/inboxes/test-inbox/messages/send");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.to, "person@example.com");
    assert.equal(body.subject, "Your Second Look demo decision record");
    assert.match(body.text, /not a payment receipt/);
    assert.doesNotMatch(body.text, /https:\/\//);
    return Response.json({ message_id: "provider-msg-1", thread_id: "provider-thread-1" });
  };

  const first = await sendDecisionReceipt(record, "Person@example.com", { ...config, fetcher, outbox: stored.outbox });
  const repeated = await sendDecisionReceipt(record, "person@example.com", { ...config, fetcher, outbox: stored.outbox });
  assert.deepEqual(first, { status: "accepted", messageId: "provider-msg-1", duplicate: false });
  assert.deepEqual(repeated, { status: "accepted", messageId: "provider-msg-1", duplicate: true });
  assert.equal(calls, 1);
});

test("concurrent sends for one saved record and recipient reserve only one provider call", async () => {
  const { record } = makeDecision();
  const stored = fakeOutbox();
  let calls = 0;
  let announceFetch!: () => void;
  let finishFetch!: () => void;
  const fetchStarted = new Promise<void>(resolve => { announceFetch = resolve; });
  const allowFetchToFinish = new Promise<void>(resolve => { finishFetch = resolve; });
  const fetcher: typeof fetch = async () => {
    calls++;
    announceFetch();
    await allowFetchToFinish;
    return Response.json({ message_id: "provider-msg-concurrent" });
  };
  const firstSend = sendDecisionReceipt(record, "person@example.com", { ...config, fetcher, outbox: stored.outbox });
  await fetchStarted;
  const second = await sendDecisionReceipt(record, "person@example.com", { ...config, fetcher, outbox: stored.outbox });
  finishFetch();
  const first = await firstSend;
  assert.equal(calls, 1);
  assert.deepEqual([first.status, second.status].sort(), ["accepted", "pending"]);
});

test("missing provider message_id and timeout become unknown and permanently block automatic resend", async () => {
  const { record } = makeDecision();
  for (const [label, fetcher] of [
    ["missing id", (async () => Response.json({ thread_id: "thread-only" })) as typeof fetch],
    ["timeout", (async () => { throw new DOMException("timeout", "AbortError"); }) as typeof fetch],
  ] as const) {
    const stored = fakeOutbox();
    let calls = 0;
    const counted: typeof fetch = async (...args) => { calls++; return fetcher(...args); };
    const first = await sendDecisionReceipt(record, "person@example.com", { ...config, fetcher: counted, outbox: stored.outbox });
    const repeated = await sendDecisionReceipt(record, "person@example.com", { ...config, fetcher: counted, outbox: stored.outbox });
    assert.equal(first.status, "unknown", label);
    assert.equal(repeated.status, "unknown", label);
    assert.equal(repeated.duplicate, true, label);
    assert.equal(calls, 1, label);
  }
});

test("an in-flight reservation and missing credentials never call the provider", async () => {
  const { record } = makeDecision();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ message_id: "unused" }); };
  const pendingOutbox: ReceiptOutbox = {
    async reserve() { return { kind: "existing", state: "pending" }; },
    async accepted() {}, async unknown() {},
  };
  const pending = await sendDecisionReceipt(record, "person@example.com", { ...config, fetcher, outbox: pendingOutbox });
  assert.equal(pending.status, "pending");
  assert.equal(calls, 0);

  const missing = await sendDecisionReceipt(record, "other@example.com", { fetcher, outbox: fakeOutbox().outbox });
  assert.equal(missing.status, "not_sent");
  assert.equal(calls, 0);
});
