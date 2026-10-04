import { randomUUID } from "node:crypto";
import { analyzeRequestSchema, evaluate, evaluateQuote, findAlternative, moneyCents, type Analysis, type BrowserCapture, type Finding, type ProgressItem } from "@/lib/second-look";
import { capture, navigate, parseObservedPlan, readEvidence, readQuote, storefrontUrl, withInspectionBrowser } from "@/lib/browser-inspection";
import { issueAnalysisToken } from "@/lib/approval-token";
import { extractPlans, gatewayConfigured } from "@/mastra";

export async function analyzeOffer(input: unknown, origin: string, notify: (item: ProgressItem) => void = () => undefined, signal?: AbortSignal, onCapture?: (frame: BrowserCapture) => void): Promise<Analysis> {
  const body = analyzeRequestSchema.parse(input);
  const sourceUrl = storefrontUrl(body.url, origin);
  const id = randomUUID();
  const progress: ProgressItem[] = [];
  function step(id: string, label: string, state: ProgressItem["state"]) {
    const item = { id, label, state };
    const index = progress.findIndex(item => item.id === id);
    if (index >= 0) progress[index] = item; else progress.push(item);
    notify(item);
  }
  step("source", "Opening the storefront", "active");
  return withInspectionBrowser(new URL(sourceUrl).origin, async (page, provider) => {
    await navigate(page, sourceUrl);
    if (onCapture) onCapture(await capture(page, provider));
    step("source", "Offer opened in " + (provider === "kernel" ? "Kernel" : "a local browser"), "complete");
    const base = new URL(sourceUrl);
    const pageUrl = (path: string) => new URL("/demo-storefront/" + path + base.search, base.origin).href;
    step("evidence", "Reading pricing, billing, and cancellation", "active");
    await navigate(page, pageUrl("pricing"));
    if (onCapture) onCapture(await capture(page, provider));
    const findings: Finding[] = [];
    const observed = [];
    for (const planId of ["annual", "monthly"] as const) {
      const subject = "Streamly " + planId + " plan";
      const total = await readEvidence(page, planId + "-total", subject + " payment today", subject, "");
      const term = await readEvidence(page, planId + "-term", subject + " billing and commitment", subject, "");
      const plan = parseObservedPlan(planId, total, term);
      total.value = "$" + plan.payableToday + " due today";
      term.value = plan.cadence + (plan.commitment ? " · annual commitment" : " · no annual commitment");
      findings.push(total, term);
      observed.push(plan);
    }
    await navigate(page, pageUrl("billing"));
    for (const plan of observed) {
      const finding = await readEvidence(page, plan.id + "-billing", plan.name + " renewal and prepayment", "Streamly " + plan.name + " plan", plan.cadence + " billing");
      const billed = finding.passage.match(/\$([\d,.]+)\s+(?:billed upfront|payable today)/i)?.[1];
      if (!billed || moneyCents(Number(billed.replace(/,/g, ""))) !== moneyCents(plan.payableToday)) {
        throw new Error("Pricing and billing disagree. Payment today is not established; no plan can be approved.");
      }
      findings.push(finding);
    }
    try {
      await navigate(page, pageUrl("cancellation"));
      const finding = await readEvidence(page, "cancellation", "Cancellation timing", "Streamly Monthly plan; Annual policy also stated", "Cancel before next billing date");
      if (!/cancel any time before the next billing date/i.test(finding.passage)) {
        finding.status = "unresolved"; finding.value = "Not established";
      }
      findings.push(finding);
    } catch {
      findings.push({ id: "cancellation", field: "Cancellation timing", subject: "Streamly subscription plans", value: "Not established",
        passage: "Retrieval failed. No cancellation passage was captured.", url: pageUrl("cancellation"), capturedAt: new Date().toISOString(), status: "unresolved", sourceKind: "browser" });
    }
    if (body.pastedText.trim()) findings.push({
      id: "pasted-offer", field: "Pasted offer text", value: "User supplied; not independently verified",
      subject: "User-provided offer context", passage: body.pastedText.trim(), url: sourceUrl, capturedAt: new Date().toISOString(),
      status: "unresolved", sourceKind: "pasted",
    });
    step("evidence", "Source passages captured; " + findings.filter(item => item.status === "unresolved").length + " unresolved", "complete");
    step("rules", gatewayConfigured() ? "Extracting with Mastra, then applying your rules" : "Extracting fixture fields and applying your rules", "active");
    const candidates = await extractPlans(findings, observed, signal);
    const initialPlan = candidates.find(plan => plan.id === body.initialPlanId)!;
    const initial = evaluate(body.requirements, initialPlan);
    const alternative = findAlternative(body.requirements, candidates) ?? null;
    step("rules", "Payment, billing, and commitment checked in code", "complete");
    let alternativeDecision = alternative ? evaluate(body.requirements, alternative) : null;
    let verifiedQuote = null;
    let analysisToken = null;
    if (alternative) {
      step("alternative", "Selecting " + alternative.name.toLowerCase() + " on the same storefront", "active");
      await navigate(page, pageUrl("pricing"));
      const select = page.locator('[data-select-plan="' + alternative.id + '"]');
      const target = new URL((await select.getAttribute("href"))!, page.url());
      if (target.origin !== base.origin || target.pathname !== "/demo-storefront/quote-summary") throw new Error("Plan selection left the approved storefront.");
      await Promise.all([page.waitForURL(url => url.pathname === "/demo-storefront/quote-summary"), select.click()]);
      step("quote", "Reading the resulting quote again", "active");
      const quote = await readQuote(page, provider);
      const checked = evaluateQuote(body.requirements, alternative, quote);
      step("alternative", checked.verifiedIdentity ? alternative.name + " plan selection verified" : "Selected plan identity could not be verified",
        checked.verifiedIdentity ? "complete" : "unresolved");
      alternativeDecision = checked.decision;
      if (checked.verifiedIdentity && checked.decision.eligible) {
        verifiedQuote = quote;
        analysisToken = issueAnalysisToken({ analysisId: id, requirements: body.requirements, sourceUrl,
          findings, selectedPlan: checked.decision.plan, originalPlan: initial.plan, quoteUrl: quote.url, quoteAmount: quote.amount });
        step("quote", "Selected plan and final total verified", "complete");
      } else step("quote", "Quote requires another review; approval blocked", "unresolved");
    } else {
      step("alternative", "No eligible option; no plan selected", "unresolved");
      step("quote", "No quote created or approved", "unresolved");
      await navigate(page, pageUrl("pricing"));
    }
    const browserCapture = await capture(page, provider);
    onCapture?.(browserCapture);
    return { id, findings, initial, alternative, alternativeDecision, verifiedQuote, analysisToken, mode: provider, progress, browserCapture,
      extraction: gatewayConfigured() ? "mastra-neon" : "deterministic-fixture" };
  }, signal);
}
