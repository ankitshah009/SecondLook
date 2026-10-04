import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
async function run() {
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : process.platform === "darwin" ? { channel: "chrome" } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  let emailRequests = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/api/receipt-email") && request.method() === "POST") emailRequests += 1; });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.frameLocator("iframe").getByRole("heading", { name: "A little more entertainment." }).waitFor();
  await page.screenshot({ path: "artifacts/ready-desktop.png" });
  const started = performance.now();
  await page.getByRole("button", { name: "Check this offer" }).click();
  const review = page.getByRole("button", { name: "Review exact demo quote" });
  await review.waitFor({ timeout: 110_000 });
  assert.equal(await review.isEnabled(), true);
  const verdict = page.getByRole("region", { name: "Current quote verdict" });
  assert.match(await verdict.innerText(), /\$348\.00 upfront/);
  assert.match(await verdict.innerText(), /\$35\.00/);
  const stickyReview = verdict.getByRole("button", { name: "Review quote", exact: true });
  assert.equal(await stickyReview.isEnabled(), true);
  console.log("UI inspection latency ms:", Math.round(performance.now() - started));
  await page.locator(".browser-viewport img").waitFor();
  await page.screenshot({ path: "artifacts/workspace-desktop.png", fullPage: true });
  await stickyReview.click();
  const approval = page.locator("dialog.approval-sheet[open]");
  await approval.waitFor();
  assert.match(await approval.innerText(), /\$35\.00/);
  assert.match(await approval.innerText(), /Streamly Monthly/);
  await page.keyboard.press("Escape");
  assert.equal(await approval.count(), 0, "Escape should close review without saving");
  await review.click();
  await page.getByRole("button", { name: "Approve this demo quote", exact: true }).click();
  const receipt = page.locator("dialog.record-drawer[open]");
  await Promise.race([
    receipt.waitFor({ timeout: 75_000 }),
    page.locator(".error-alert").waitFor({ timeout: 75_000 }).then(async () => {
      throw new Error("Receipt creation failed: " + await page.locator(".error-alert p").innerText());
    }),
  ]);
  assert.match(await receipt.innerText(), /\$35\.00/);
  assert.match(await receipt.innerText(), /SL-[A-F0-9]{8}/);
  const durableReceipt = (await receipt.innerText()).includes("Persisted in Neon and read back");
  assert.equal(await receipt.locator(".kicker").innerText(), durableReceipt ? "Verified and persisted" : "Verified · temporary record");
  await receipt.getByRole("heading", { name: "Email this saved receipt" }).waitFor();
  const sendReceipt = receipt.getByRole("button", { name: "Send receipt email", exact: true });
  if (await sendReceipt.count()) assert.equal(await sendReceipt.isEnabled(), false, "receipt approval must not automatically authorize email");
  assert.equal(emailRequests, 0, "saving a quote must never send an email automatically");
  await page.screenshot({ path: "artifacts/decision-receipt.png" });
  await page.getByRole("button", { name: "Close decision record", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Maximum amount due today" }).fill("30");
  assert.equal(await review.count(), 0, "changed preferences must hide the stale recommendation and approval");
  assert.equal(await stickyReview.count(), 0, "sticky verdict must replace stale review with recheck");
  assert.equal(await verdict.getByRole("button", { name: "Recheck", exact: true }).isEnabled(), true);
  assert.match(await verdict.innerText(), /Recheck needed/);
  assert.doesNotMatch(await verdict.innerText(), /\$35\.00/);
  assert.match(await verdict.innerText(), /Preferences changed/);
  assert.match(await page.locator(".stale-note").innerText(), /inputs changed/);
  assert.equal(await page.locator(".agent-status").innerText(), "Recheck needed");
  assert.match(await page.locator(".browser-caption").innerText(), /Previous capture · recheck needed/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "artifacts/workspace-mobile.png", fullPage: true });
  assert.deepEqual(errors, [], "browser runtime should have no uncaught errors");
  console.log("UI smoke passed: real inspection, exact review, Escape, approval, receipt, stale preferences, mobile overflow and runtime errors.");
  await context.close();
} finally { await browser.close(); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : "UI smoke failed"); process.exitCode = 1; });
