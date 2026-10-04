import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

async function run() {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const offerUrl = process.env.RESEARCH_OFFER_URL || "https://www.spotify.com/us/premium/";
  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  assert.equal(health.exa, true, "Configure EXA_API_KEY on the running server before this live test.");
  await mkdir("artifacts", { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.platform === "darwin" ? { channel: "chrome" } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseUrl);
    await page.getByLabel("Offer page URL", { exact: true }).fill(offerUrl);
    const responsePromise = page.waitForResponse(r => r.url().endsWith("/api/research") && r.request().method() === "POST");
    const started = performance.now();
    await page.getByRole("button", { name: "Search public sources" }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, "The live research request must succeed, not return fixture evidence.");
    const data = await response.json();
    assert.equal(data.mode, "research-only");
    assert.equal(data.checkoutEnabled, false);
    const retrieved = data.sources.filter((source: { status: string }) => source.status === "retrieved");
    assert.ok(retrieved.length > 0, "Exa must return at least one actual passage.");
    for (const source of retrieved) {
      assert.ok(source.passage.trim());
      assert.ok(Number.isFinite(Date.parse(source.capturedAt)));
      const host = new URL(source.url).hostname;
      const offerHost = new URL(offerUrl).hostname.replace(/^www\./, "");
      assert.ok(host === offerHost || host.endsWith(`.${offerHost}`));
    }
    await page.getByRole("heading", { name: "Evidence to review" }).waitFor();
    const first = page.locator(".research-source").first();
    await first.locator("summary").click();
    await first.getByText("Exact product or plan applicability: not established.", { exact: false }).waitFor();
    await first.locator("blockquote").waitFor();
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "artifacts/exa-live-research.png" });
    await page.locator("#offer-url").fill(offerUrl);
    const integratedResponse = page.waitForResponse(r => r.url().endsWith("/api/offer-research") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Check this offer" }).click();
    const integrated = await integratedResponse;
    assert.equal(integrated.status(), 200);
    const assessment = await integrated.json();
    assert.equal(assessment.mode, "real-offer-research");
    assert.equal(assessment.checkoutEnabled, false);
    assert.equal(assessment.verifiedDemoQuote, false);
    assert.ok(["fits", "does-not-fit", "unresolved"].includes(assessment.assessment.status));
    await page.getByRole("heading", { name: "What the evidence establishes" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Review exact demo quote" }).count(), 0);
    await page.screenshot({ path: "artifacts/real-offer-integrated.png", fullPage: true });
    await page.getByRole("spinbutton", { name: "Maximum amount due today" }).fill("30");
    await page.getByRole("heading", { name: "What the evidence establishes" }).waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(`Live Exa UI passed: ${retrieved.length} retrieved sources, ${Math.round(performance.now() - started)} ms; optional search, main-input research, no checkout authority, and stale-preference invalidation verified.`);
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
