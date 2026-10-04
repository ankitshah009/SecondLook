import assert from "node:assert/strict";
import type { Analysis, DecisionRecord, Requirements } from "@/lib/second-look";

const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const demoUrl = (scenario: "standard" | "missing" | "changed" = "standard") =>
  "https://demo.secondlook.local/offer" + (scenario === "standard" ? "" : "?scenario=" + scenario);

async function post<T>(path: string, body: unknown): Promise<{ response: Response; data: T }> {
  let response: Response;
  try {
    response = await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error(`Could not reach ${baseUrl}. Start the app server before running this smoke test. ${String(error)}`);
  }
  const text = await response.text();
  let data: T;
  try { data = JSON.parse(text) as T; }
  catch { throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`); }
  return { response, data };
}

function tokenFrom(analysis: Analysis): string {
  assert.ok(analysis.analysisToken, "expected an approval token");
  return analysis.analysisToken;
}

async function analyze(scenario: "standard" | "missing" | "changed", requirements: Requirements): Promise<Analysis> {
  const { response, data } = await post<Analysis | { error?: string }>("/api/analyze", {
    url: demoUrl(scenario), pastedText: "", requirements, initialPlanId: "annual",
  });
  assert.equal(response.status, 200, "analysis should succeed: " + JSON.stringify(data));
  if (process.env.REQUIRE_GATEWAY === "true" || process.env.REQUIRE_FULL_STACK === "true") {
    assert.equal((data as Analysis).extraction, "mastra-neon", "each analysis must use the actual Neon Gateway, not fixture extraction");
  }
  return data as Analysis;
}

async function approve(analysisToken: string, planId: "annual" | "monthly", expectedAmount: number) {
  return post<{
    error?: string; changed?: boolean; saved?: boolean; duplicate?: boolean; persistence?: string;
    quote?: DecisionRecord; verifiedQuote?: { amount: number };
    reevaluatedDecision?: { eligible: boolean }; analysisToken?: string | null;
  }>("/api/quote", { analysisToken, planId, expectedAmount });
}

async function run() {
  const requireStack = process.env.REQUIRE_FULL_STACK === "true";
  if (requireStack) {
    const health = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
    assert.equal(health.browser, "kernel", "Full-stack verification requires BROWSER_PROVIDER=kernel and KERNEL_API_KEY.");
    assert.equal(health.persistence, "neon", "Full-stack verification requires DATABASE_URL.");
    assert.equal(health.gateway, true, "Full-stack verification requires Neon Gateway credentials.");
    assert.equal(health.exa, true, "Full-stack verification requires EXA_API_KEY.");
  }
  const monthlyRules: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };

  const standard = await analyze("standard", monthlyRules);
  if (requireStack) {
    assert.equal(standard.mode, "kernel", "The actual inspection must use Kernel, not local Chrome.");
    assert.equal(standard.extraction, "mastra-neon", "The actual extraction must use Mastra through Neon Gateway.");
    assert.equal(standard.verifiedQuote?.provider, "kernel");
  }
  assert.equal(standard.initial.eligible, false, "annual plan should fail the $40 monthly preference");
  assert.equal(standard.alternative?.id, "monthly");
  assert.equal(standard.alternative?.payableToday, 35);
  assert.equal(standard.verifiedQuote?.amount, 35);
  const originalToken = tokenFrom(standard);

  const [payload, signature] = originalToken.split(".");
  const replacement = signature.endsWith("A") ? "B" : "A";
  const tampered = payload + "." + signature.slice(0, -1) + replacement;
  const tamperResult = await approve(tampered, "monthly", 35);
  assert.equal(tamperResult.response.status, 400, "tampered approval token should be rejected");

  const firstSave = await approve(originalToken, "monthly", 35);
  assert.equal(firstSave.response.status, 200, "first exact approval should save: " + JSON.stringify(firstSave.data));
  assert.equal(firstSave.data.duplicate, false);
  if (requireStack || process.env.REQUIRE_NEON === "true") assert.equal(firstSave.data.persistence, "neon", "The exact quote must be persisted in Neon, not memory.");
  assert.ok(firstSave.data.quote?.id);
  const recordId = firstSave.data.quote!.id;

  const read = await post<{ record: DecisionRecord }>("/api/record", { id: recordId, analysisToken: originalToken });
  assert.equal(read.response.status, 200, "saved record should be readable");
  assert.equal(read.data.record.id, recordId);
  assert.equal(read.data.record.amount, 35);
  assert.equal(read.data.record.selectedDecision.plan.id, "monthly");

  const duplicateSave = await approve(originalToken, "monthly", 35);
  assert.equal(duplicateSave.response.status, 200);
  assert.equal(duplicateSave.data.duplicate, true, "repeated exact approval should be idempotent");
  assert.equal(duplicateSave.data.quote?.id, recordId);

  const missing = await analyze("missing", monthlyRules);
  assert.equal(missing.findings.find(finding => finding.id === "cancellation")?.status, "unresolved");
  assert.equal(missing.findings.find(finding => finding.id === "cancellation")?.value, "Not established");

  const annualRules: Requirements = { maxToday: 500, billing: "annual", annualOk: true };
  const annual = await analyze("standard", annualRules);
  assert.equal(annual.initial.eligible, true, "annual preferences and $500 limit should accept annual billing");
  assert.equal(annual.initial.plan.payableToday, 348);
  assert.equal(annual.alternative?.id, "annual");
  assert.equal(annual.verifiedQuote?.amount, 348);

  const noFit = await analyze("standard", { maxToday: 30, billing: "monthly", annualOk: false });
  assert.equal(noFit.alternative, null, "no plan should fit a $30 monthly limit");
  assert.equal(noFit.verifiedQuote, null);
  assert.equal(noFit.analysisToken, null);

  const changedBlocked = await analyze("changed", monthlyRules);
  assert.equal(changedBlocked.alternative?.id, "monthly");
  const blockedResult = await approve(tokenFrom(changedBlocked), "monthly", 35);
  assert.equal(blockedResult.response.status, 409);
  assert.equal(blockedResult.data.changed, true);
  assert.equal(blockedResult.data.verifiedQuote?.amount, 45);
  assert.equal(blockedResult.data.reevaluatedDecision?.eligible, false, "$45 should exceed the $40 limit");
  assert.equal(blockedResult.data.analysisToken, null, "an ineligible changed quote must not receive approval authority");
  assert.equal(blockedResult.data.saved, false);

  const changedFits = await analyze("changed", { ...monthlyRules, maxToday: 50 });
  const changedResult = await approve(tokenFrom(changedFits), "monthly", 35);
  assert.equal(changedResult.response.status, 409);
  assert.equal(changedResult.data.changed, true);
  assert.equal(changedResult.data.verifiedQuote?.amount, 45);
  assert.equal(changedResult.data.reevaluatedDecision?.eligible, true);
  const renewedToken = changedResult.data.analysisToken;
  assert.ok(renewedToken, "eligible changed quote should require a new approval token");

  const renewedSave = await approve(renewedToken, "monthly", 45);
  assert.equal(renewedSave.response.status, 200, "new exact approval should save the $45 quote");
  assert.equal(renewedSave.data.duplicate, false);
  assert.equal(renewedSave.data.quote?.amount, 45);

  const renewedDuplicate = await approve(renewedToken, "monthly", 45);
  assert.equal(renewedDuplicate.response.status, 200);
  assert.equal(renewedDuplicate.data.duplicate, true);
  assert.equal(renewedDuplicate.data.quote?.id, renewedSave.data.quote?.id);

  const streamed = await fetch(baseUrl + "/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ url: demoUrl(), requirements: monthlyRules }), signal: AbortSignal.timeout(120_000),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") || "", /text\/event-stream/);
  const chunks = (await streamed.text()).trim().split("\n\n").map(chunk => {
    const lines = chunk.split("\n");
    return { event: lines.find(line => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith("data: "))!.slice(6)) };
  });
  const frames = chunks.filter(chunk => chunk.event === "capture");
  assert.equal(frames.length, 3, "offer, pricing and final quote captures must be streamed");
  assert.ok(frames.every(frame => /^data:image\/jpeg;base64,/.test(frame.data.image)));
  assert.match(frames[0].data.url, /\/offer/);
  assert.match(frames[1].data.url, /\/pricing/);
  assert.match(frames[2].data.url, /\/quote-summary/);
  const final = chunks.at(-1)!;
  assert.equal(final.event, "result", "decision follows actual browser captures");
  if (requireStack || process.env.REQUIRE_GATEWAY === "true") assert.equal(final.data.extraction, "mastra-neon");
  assert.equal(final.data.verifiedQuote.amount, 35);
  assert.equal(final.data.verifiedQuote.replay, false);
  assert.ok(final.data.findings.every((finding: { passage: string; url: string; capturedAt: string; subject: string }) =>
    finding.passage && finding.url && finding.subject && Number.isFinite(Date.parse(finding.capturedAt))));

  console.log(`HTTP smoke passed against ${baseUrl}: analysis, approval, record read, duplicate, unresolved evidence, changed quote reapproval, tamper rejection and live capture streaming.`);
}

run().catch(error => {
  console.error("HTTP smoke failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
