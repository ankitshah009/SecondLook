import Kernel from "@onkernel/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BrowserCapture, BrowserMode, Finding, Plan, VerifiedQuote } from "@/lib/second-look";

export function storefrontUrl(inputUrl: string, requestOrigin: string) {
  const input = new URL(inputUrl);
  const origin = new URL(process.env.APP_URL || requestOrigin).origin;
  const isAlias = input.hostname === "demo.secondlook.local";
  if (!isAlias && (input.origin !== origin || !input.pathname.startsWith("/demo-storefront/"))) {
    throw new Error("This milestone supports the synthetic Streamly storefront. Use the demo URL; arbitrary merchant automation is not enabled.");
  }
  const scenario = input.searchParams.get("scenario") || "standard";
  if (!["standard", "missing", "changed"].includes(scenario)) throw new Error("Choose a supported demo scenario.");
  return origin + "/demo-storefront/offer?scenario=" + scenario;
}

type LocalPool = { browser: Promise<Browser>; users: number; idle?: ReturnType<typeof setTimeout> };
declare global { var secondLookLocalBrowserPool: LocalPool | undefined; }
function leaseLocalBrowser() {
  let pool = globalThis.secondLookLocalBrowserPool;
  if (!pool) {
    pool = { users: 0, browser: chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : process.platform === "darwin" ? { channel: "chrome" } : {}),
    }) };
    globalThis.secondLookLocalBrowserPool = pool;
    const current = pool;
    pool.browser.then(browser => browser.on("disconnected", () => {
      if (globalThis.secondLookLocalBrowserPool === current) globalThis.secondLookLocalBrowserPool = undefined;
    })).catch(() => { if (globalThis.secondLookLocalBrowserPool === current) globalThis.secondLookLocalBrowserPool = undefined; });
  }
  clearTimeout(pool.idle);
  pool.users++;
  return pool;
}
function releaseLocalBrowser(pool: LocalPool) {
  pool.users--;
  if (pool.users === 0) {
    pool.idle = setTimeout(() => {
      if (pool.users !== 0) return;
      if (globalThis.secondLookLocalBrowserPool === pool) globalThis.secondLookLocalBrowserPool = undefined;
      void pool.browser.then(browser => browser.close()).catch(() => undefined);
    }, 30_000);
    pool.idle.unref();
  }
}

export async function withInspectionBrowser<T>(origin: string, work: (page: Page, provider: BrowserMode, context: BrowserContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const remote = process.env.BROWSER_PROVIDER !== "local" && Boolean(process.env.KERNEL_API_KEY);
  if (!remote && process.env.VERCEL) throw new Error("Connect KERNEL_API_KEY and set APP_URL to this deployment to enable browser inspection.");
  if (remote && ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname)) {
    throw new Error("Kernel needs a publicly reachable storefront. Set APP_URL to your deployed app, or use BROWSER_PROVIDER=local for local development.");
  }
  const kernel = remote ? new Kernel({ apiKey: process.env.KERNEL_API_KEY, timeout: 20_000, maxRetries: 0 }) : null;
  const session = kernel ? await kernel.browsers.create({ timeout_seconds: 120 }) : null;
  const pool = remote ? null : leaseLocalBrowser();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stop: (() => void) | undefined;
  try {
    browser = session
      ? await chromium.connectOverCDP(session.cdp_ws_url, { timeout: 20_000 })
      : await pool!.browser;
    context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    signal?.throwIfAborted();
    const ownedContext = context;
    stop = () => { void ownedContext.close().catch(() => undefined); };
    signal?.addEventListener("abort", stop, { once: true });
    const allowedOrigin = new URL(origin).origin;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === allowedOrigin || ["data:", "about:", "blob:"].includes(url.protocol)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    return await work(page, remote ? "kernel" : "local-browser", context);
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist|Failed to launch|browserType.launch/.test(error.message)) {
      throw new Error("Local browser could not start. Install Chrome or set PLAYWRIGHT_EXECUTABLE_PATH. For deployed inspection, configure Kernel.");
    }
    throw error;
  } finally {
    if (stop) signal?.removeEventListener("abort", stop);
    await context?.close().catch(() => undefined);
    if (pool) releaseLocalBrowser(pool);
    else await browser?.close().catch(() => undefined);
    if (session && kernel) await kernel.browsers.deleteByID(session.session_id).catch(() => undefined);
  }
}

export async function navigate(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new Error("The source page could not be retrieved. Its terms are not established.");
}
export async function capture(page: Page, provider: BrowserMode): Promise<BrowserCapture> {
  const image = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false, animations: "disabled", timeout: 8_000 });
  return { url: page.url(), capturedAt: new Date().toISOString(), provider, image: "data:image/jpeg;base64," + image.toString("base64") };
}
export async function readEvidence(page: Page, id: string, field: string, subject: string, value: string): Promise<Finding> {
  const locator = page.locator('[data-evidence="' + id + '"]');
  const passage = await locator.innerText();
  return { id, field, subject, value, passage: passage.trim(), url: page.url(), capturedAt: new Date().toISOString(), status: "established", sourceKind: "browser" };
}
export function parseObservedPlan(id: Plan["id"], total: Finding, term: Finding): Plan {
  const amount = total.passage.match(/\$([\d,.]+)\s+payable today/i);
  const equivalent = total.passage.match(/\$([\d,.]+)\s+monthly equivalent/i);
  const cadence = term.passage.match(/\b(monthly|annual) billing/i)?.[1]?.toLowerCase();
  if (!amount || !equivalent || !cadence) throw new Error("Payment, billing cadence, or commitment evidence is incomplete. No plan can be approved.");
  if (!/no annual commitment|one-year commitment/i.test(term.passage)) throw new Error("Commitment terms are not established.");
  return {
    id, name: id === "annual" ? "Annual" : "Monthly",
    payableToday: Number(amount[1].replace(/,/g, "")), monthlyEquivalent: Number(equivalent[1].replace(/,/g, "")),
    cadence: cadence as Plan["cadence"], commitment: !/no annual commitment/i.test(term.passage),
    url: total.url, evidenceIds: [total.id, term.id, id + "-billing"],
  };
}
export async function readQuote(page: Page, provider: BrowserMode): Promise<VerifiedQuote> {
  const planText = (await page.locator("[data-quote-plan]").innerText()).trim();
  const amount = (await page.locator("[data-quote-total]").innerText()).match(/\$([\d,.]+)/)?.[1];
  const cadenceText = await page.locator("[data-quote-cadence]").innerText();
  const commitmentText = await page.locator("[data-quote-commitment]").innerText();
  const planId = /^Monthly plan$/i.test(planText) ? "monthly" : /^Annual plan$/i.test(planText) ? "annual" : null;
  if (!planId || !amount || !/monthly billing|annual billing/i.test(cadenceText) || !/no annual commitment|one-year commitment/i.test(commitmentText)) {
    throw new Error("The selected plan and final quote could not be verified. Nothing was saved.");
  }
  return {
    planId, amount: Number(amount.replace(/,/g, "")), cadence: /monthly/i.test(cadenceText) ? "monthly" : "annual",
    commitment: !/no annual commitment/i.test(commitmentText), url: page.url(), capturedAt: new Date().toISOString(),
    passage: (await page.locator('[data-evidence="quote-summary"]').innerText()).trim(),
    replay: false, provider,
  };
}
export async function recheckQuote(quoteUrl: string, requestOrigin: string, signal?: AbortSignal) {
  const parsed = new URL(quoteUrl);
  const expectedOrigin = new URL(process.env.APP_URL || requestOrigin).origin;
  if (parsed.origin !== expectedOrigin || parsed.pathname !== "/demo-storefront/quote-summary") throw new Error("The reviewed quote source is invalid.");
  return withInspectionBrowser(expectedOrigin, async (page, provider) => {
    if (parsed.searchParams.get("scenario") === "changed") {
      parsed.searchParams.set("revision", "final");
    }
    await navigate(page, parsed.href);
    return { verifiedQuote: await readQuote(page, provider), browserCapture: await capture(page, provider) };
  }, signal);
}
