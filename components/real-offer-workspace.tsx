"use client";

import { useEffect, useRef, useState } from "react";
import type { Requirements } from "@/lib/second-look";
import type { EstablishedField, RealOfferResult } from "@/lib/real-offer";

export interface RealOfferWorkspaceProps {
  url: string;
  pastedText?: string;
  requirements: Requirements;
  health?: { exa: boolean; gateway: boolean } | null;
  autoStart?: boolean;
}

function errorMessage(value: unknown): string {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error
    : "Offer research is unavailable. Check the URL and try again.";
}

function validResult(value: unknown): value is RealOfferResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<RealOfferResult>;
  return result.mode === "real-offer-research" && result.checkoutEnabled === false && result.verifiedDemoQuote === false &&
    Array.isArray(result.sources) && Array.isArray(result.limitations) &&
    result.assessment?.kind === "research-preference-check" &&
    ["fits", "does-not-fit", "unresolved"].includes(result.assessment.status) &&
    ["productPlan", "amountDueToday", "billingCadence", "annualCommitment", "cancellationPolicy"].every(key => {
      const field = result.fields?.[key as keyof RealOfferResult["fields"]];
      return field && (field.status === "established" || field.status === "unresolved") && "value" in field && "evidence" in field;
    });
}

function safeWebUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

function fieldEvidence<T>(field: EstablishedField<T>, sources: RealOfferResult["sources"]) {
  if (!field.evidence) return null;
  const source = sources.find(item => item.id === field.evidence?.sourceId);
  if (!source) return null;
  return <a href={`#real-offer-source-${source.id}`} className="research-source-link">Source: {source.title}</a>;
}

function renderField<T>(label: string, field: EstablishedField<T>, value: string, sources: RealOfferResult["sources"]) {
  return <div className="real-offer-field" key={label}>
    <span>{label}</span>
    <strong>{field.status === "established" ? value : "Not established"}</strong>
    {fieldEvidence(field, sources)}
  </div>;
}

export default function RealOfferWorkspace({ url, pastedText = "", requirements, health, autoStart = false }: RealOfferWorkspaceProps) {
  const [result, setResult] = useState<RealOfferResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    setResult(null);
    setError("");
    setBusy(false);
    return () => controllerRef.current?.abort();
  }, [url, pastedText, requirements.maxToday, requirements.billing, requirements.annualOk]);

  async function research() {
    if (busy || !url.trim() || health?.exa === false) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(58_000)]);
      const response = await fetch("/api/offer-research", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: url.trim(), ...(pastedText.trim() ? { pastedText } : {}), requirements }),
        signal,
      });
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error("The server returned an unreadable response. Try again."); }
      if (!response.ok) throw new Error(errorMessage(data));
      if (!validResult(data)) throw new Error("The research response was incomplete; no findings were shown.");
      if (signal.aborted || controllerRef.current !== controller) return;
      setResult(data);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error && cause.name === "TimeoutError"
        ? "Offer research took too long. Try again."
        : cause instanceof Error ? cause.message : "Offer research failed. Try again.");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => { if (autoStart) void research(); }, [autoStart]);

  const money = (amount: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount);

  return <section className="research-panel real-offer-workspace" aria-labelledby="real-offer-title">
    <header className="research-panel-header">
      <div>
        <p className="research-kicker">Real-offer research · read only</p>
        <h2 id="real-offer-title">Check the offer’s published terms.</h2>
        <p className="research-intro">Review attached source passages and compare only terms established on the exact offer page with your preferences.</p>
      </div>
      <span className="research-only-badge">Research · no checkout</span>
    </header>

    <p className="real-offer-url"><span>Offer URL</span> {safeWebUrl(url) ? <a href={url} target="_blank" rel="noreferrer">{url}</a> : <span>{url || "No offer URL provided"}</span>}</p>
    {health?.exa === false && <p className="research-gate" role="status">Exa is not connected. Real-offer research is unavailable until it is configured.</p>}
    {health?.gateway === false && <p className="research-gate" role="status">Optional Gateway clause selection is unavailable; complete literal clauses can still be checked conservatively.</p>}
    {error && <p className="research-error" role="alert">{error}</p>}
    <button className="research-submit real-offer-submit" type="button" disabled={busy || !url.trim() || health?.exa === false} onClick={research}>
      {busy ? "Reviewing offer evidence…" : "Research this offer"}
    </button>
    {busy && <p className="research-live" role="status" aria-live="polite">Checking the submitted page and domain-scoped public evidence. No purchase or merchant action will be taken.</p>}

    {result && <div className="research-results" aria-label="Real-offer research results">
      <div className="research-results-heading">
        <div><p className="research-kicker">Preference check · not a verified demo quote</p><h3>What the evidence establishes</h3></div>
        <span>{result.assessment.status === "unresolved" ? "Unresolved" : result.assessment.status === "fits" ? "Fits stated preferences" : "Does not fit all preferences"}</span>
      </div>
      <p className="real-offer-assessment">{result.assessment.reason}</p>
      <div className="real-offer-fields">
        {renderField("Exact product / plan", result.fields.productPlan, String(result.fields.productPlan.value ?? ""), result.sources)}
        {renderField("Due today", result.fields.amountDueToday, result.fields.amountDueToday.value ? money(result.fields.amountDueToday.value.amount) : "", result.sources)}
        {renderField("Billing cadence", result.fields.billingCadence, result.fields.billingCadence.value ?? "", result.sources)}
        {renderField("Annual commitment", result.fields.annualCommitment, result.fields.annualCommitment.value === null ? "" : result.fields.annualCommitment.value ? "Required" : "Explicitly not required", result.sources)}
        {renderField("Cancellation policy", result.fields.cancellationPolicy, result.fields.cancellationPolicy.value ?? "", result.sources)}
      </div>
      {result.assessment.checks && <ul className="real-offer-checks" aria-label="Preference checks">
        {result.assessment.checks.map(check => <li key={check.label}><span aria-hidden="true">{check.pass ? "✓" : "×"}</span><strong>{check.label}</strong> {check.detail}</li>)}
      </ul>}

      <h4 className="real-offer-sources-heading">Retrieved source evidence</h4>
      <div className="research-source-list">
        {result.sources.map((source, index) => <details className="research-source" id={`real-offer-source-${source.id}`} key={source.id} open={index === 0 && source.status === "retrieved"}>
          <summary>
            <span className={`research-source-mark${source.status === "unresolved" ? " unresolved" : ""}`} aria-hidden="true">{source.status === "retrieved" ? "✓" : "?"}</span>
            <span className="research-source-title"><b>{source.title}</b><small>{source.subject} · {source.sourceKind === "pasted" ? "user-provided" : source.status}</small></span>
            <span className="research-source-status">{source.status === "retrieved" ? "Passage attached" : "Unresolved"}</span>
          </summary>
          <blockquote>{source.passage}</blockquote>
          {source.sourceKind === "exa" && <a className="research-source-link" href={source.url} target="_blank" rel="noreferrer">Open public source ↗</a>}
          <time dateTime={source.capturedAt}>{source.capturedAt}</time>
        </details>)}
      </div>
      <div className="research-limitations"><strong>Limits</strong><ul>{result.limitations.map(item => <li key={item}>{item}</li>)}</ul></div>
      <p className="research-boundary">Real-offer research stays separate from Second Look’s verified synthetic demo quote. It cannot determine account eligibility, approve a purchase, or interact with merchant checkout.</p>
    </div>}
  </section>;
}
