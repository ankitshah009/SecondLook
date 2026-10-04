import assert from "node:assert/strict";
import test from "node:test";
import { handleResearchRequest, type ResearchDependencies } from "@/lib/research";

const offerUrl = "https://merchant-example.com/offer";
const publicLookup: NonNullable<ResearchDependencies["resolveHost"]> = async () => [{ address: "93.184.216.34", family: 4 }];

function request(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/research", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeExaFetch(calls: Array<{ url: string; body: Record<string, unknown>; key: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body, key: new Headers(init?.headers).get("x-api-key") ?? "" });
    if (url.endsWith("/contents")) return jsonResponse({ results: [{
      title: "Current offer", url: offerUrl,
      text: "Membership plans start at $12 per month. Monthly billing renews each month. Cancel your subscription before renewal.",
    }] });
    const query = String(body.query);
    const details = query.includes("pricing") ? {
      title: "Plans and pricing", url: "https://merchant-example.com/pricing", text: "Choose a subscription plan. Pricing is $12 per month or $100 per year.",
    } : query.includes("billing") ? {
      title: "Billing information", url: "https://merchant-example.com/help/billing", text: "Billing renews monthly. Payment is charged on the renewal date.",
    } : {
      title: "Cancel a subscription", url: "https://merchant-example.com/help/cancel", text: "Cancel your subscription at any time before renewal. Refunds are available within 30 days.",
    };
    return jsonResponse({ results: [details] });
  }) as typeof fetch;
}

test("research returns source-domain passages from contents and topic searches", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; key: string }> = [];
  const response = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key", fetchImpl: fakeExaFetch(calls), resolveHost: publicLookup,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.mode, "research-only");
  assert.equal(data.checkoutEnabled, false);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.key === "unit-test-key"));
  assert.deepEqual(calls.filter(call => call.url.endsWith("/search")).map(call => call.body.includeDomains), [
    ["merchant-example.com"], ["merchant-example.com"], ["merchant-example.com"],
  ]);
  const sources = data.sources as Array<{ title: string; url: string; passage: string; capturedAt: string; subject: string; status: string; sourceKind: string }>;
  assert.equal(sources.length, 4);
  assert.ok(sources.every(source => source.status === "retrieved" && source.sourceKind === "exa"));
  assert.ok(sources.some(source => source.subject === "Submitted offer page" && source.passage.includes("$12 per month")), JSON.stringify(sources));
  assert.ok(sources.some(source => source.subject === "merchant-example.com · Pricing and plans" && source.passage.includes("$100 per year")));
  assert.ok(sources.some(source => source.subject === "merchant-example.com · Billing and renewals" && source.passage.includes("renews monthly")));
  assert.ok(sources.some(source => source.subject === "merchant-example.com · Cancellation and refunds" && source.passage.includes("Cancel your subscription")));
  assert.ok(sources.every(source => new URL(source.url).hostname === "merchant-example.com"));
  assert.ok(sources.every(source => source.capturedAt === "2026-10-04T12:00:00.000Z"));
  assert.ok(data.limitations.some((item: string) => item.includes("does not determine eligibility")));
  assert.ok(data.limitations.some((item: string) => item.includes("applicability to the exact offer has not been established")));
});

test("decimal prices and adjacent plan context survive excerpt selection", async () => {
  const response = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key", resolveHost: publicLookup,
    fetchImpl: (async () => jsonResponse({ results: [{ title: "Premium", url: offerUrl,
      text: "Premium Individual. $0 for 1 month, then $12.99 per month. Cancel before monthly renewal.",
    }] })) as typeof fetch,
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.sources.every((source: { passage: string }) => source.passage.includes("$12.99")));
  assert.ok(data.sources[0].passage.includes("Premium Individual"));
});

test("pasted text is preserved as unverified context and not sent to Exa", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; key: string }> = [];
  const pastedText = "I was quoted $8/month by a sales representative.";
  const response = await handleResearchRequest(request({ url: offerUrl, pastedText }), {
    apiKey: "unit-test-key", fetchImpl: fakeExaFetch(calls), resolveHost: publicLookup,
  });
  const data = await response.json();
  const pasted = data.sources.find((source: { sourceKind: string }) => source.sourceKind === "pasted");

  assert.equal(pasted.passage, pastedText);
  assert.equal(pasted.status, "unresolved");
  assert.equal(pasted.subject, "User-provided context");
  assert.ok(data.limitations.some((item: string) => item.includes("not been independently verified")));
  assert.ok(calls.every(call => !JSON.stringify(call.body).includes(pastedText)));
});

test("missing Exa credentials return 503 without DNS or provider calls", async () => {
  let resolveCalls = 0;
  let fetchCalls = 0;
  const response = await handleResearchRequest(request({ url: offerUrl }), {
    resolveHost: async () => { resolveCalls++; return [{ address: "93.184.216.34", family: 4 }]; },
    fetchImpl: (async () => { fetchCalls++; return jsonResponse({ results: [] }); }) as typeof fetch,
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /EXA_API_KEY/);
  assert.equal(resolveCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("rejects non-web, credentialed, local, and literal-IP URLs before I/O", async () => {
  const invalidUrls = [
    "ftp://merchant.example/offer",
    "https://user:pass@merchant.example/offer",
    "http://localhost/offer",
    "http://printer.local/offer",
    "http://192.168.1.20/offer",
    "http://[::1]/offer",
    "https://merchant-example.com/" + "x".repeat(2_049),
  ];
  for (const url of invalidUrls) {
    let calls = 0;
    const response = await handleResearchRequest(request({ url }), {
      apiKey: "unit-test-key", resolveHost: publicLookup,
      fetchImpl: (async () => { calls++; return jsonResponse({ results: [] }); }) as typeof fetch,
    });
    assert.equal(response.status, 400, url);
    assert.equal(calls, 0, url);
  }
});

test("rejects hostnames that resolve to any private address", async () => {
  let calls = 0;
  const response = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key",
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }],
    fetchImpl: (async () => { calls++; return jsonResponse({ results: [] }); }) as typeof fetch,
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("ignores off-domain results and marks missing topic evidence unresolved", async () => {
  let searchIndex = 0;
  const response = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key", resolveHost: publicLookup,
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/contents")) return jsonResponse({ results: [{ title: "Offer", url: offerUrl, text: "A subscription offer page with a monthly plan." }] });
      searchIndex++;
      const result = searchIndex === 1
        ? { title: "Generic pricing advice", url: "https://unrelated-site.com/pricing", text: "Subscription pricing is important." }
        : { title: "No matching source", url: "https://merchant-example.com/article", text: "Welcome to our company. Read our latest news." };
      return jsonResponse({ results: [result] });
    }) as typeof fetch,
  });
  const data = await response.json();
  const topicSources = data.sources.filter((source: { subject: string }) => source.subject !== "Submitted offer page");

  assert.equal(response.status, 200);
  assert.ok(topicSources.every((source: { status: string }) => source.status === "unresolved"));
  assert.ok(topicSources.every((source: { url: string }) => new URL(source.url).hostname === "merchant-example.com"));
  assert.ok(data.limitations.some((item: string) => item.toLowerCase().includes("pricing and plans")));
});

test("provider failures are sanitized and timeouts do not return fabricated evidence", async () => {
  const unavailable = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key", resolveHost: publicLookup,
    fetchImpl: (async () => jsonResponse({ error: "private-provider-detail" }, 401)) as typeof fetch,
  });
  const unavailableBody = await unavailable.text();
  assert.equal(unavailable.status, 503);
  assert.ok(!unavailableBody.includes("private-provider-detail"));

  const timedOut = await handleResearchRequest(request({ url: offerUrl }), {
    apiKey: "unit-test-key", resolveHost: publicLookup, timeoutMs: 10,
    fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  });
  assert.equal(timedOut.status, 503);
  assert.match((await timedOut.json()).error, /timed out/i);
});

test("client request abort cancels the Exa requests", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const responsePromise = handleResearchRequest(request({ url: offerUrl }, controller.signal), {
    apiKey: "unit-test-key", resolveHost: publicLookup,
    fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch,
  });
  await requestStarted;
  controller.abort();
  const response = await responsePromise;

  assert.equal(response.status, 499);
});

test("rejects oversized pasted text and request bodies", async () => {
  const oversizedText = await handleResearchRequest(request({ url: offerUrl, pastedText: "x".repeat(12_001) }), {
    apiKey: "unit-test-key", resolveHost: publicLookup,
  });
  assert.equal(oversizedText.status, 400);

  const hugeRequest = new Request("http://localhost/api/research", {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(70 * 1_024) }, body: JSON.stringify({ url: offerUrl }),
  });
  const oversizedBody = await handleResearchRequest(hugeRequest, { apiKey: "unit-test-key" });
  assert.equal(oversizedBody.status, 413);
});
