"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import type { Analysis, BrowserCapture, DecisionRecord, Finding, ProgressItem, Requirements } from "@/lib/second-look";

const EvidenceChat = dynamic(() => import("@/components/evidence-chat"), { ssr: false });
const ResearchPanel = dynamic(() => import("@/components/research-panel"), { ssr: false });
const RealOfferWorkspace = dynamic(() => import("@/components/real-offer-workspace"), { ssr: false });
const ReceiptEmail = dynamic(() => import("@/components/receipt-email"), { ssr: false });
const defaults: Requirements = { maxToday: 40, billing: "monthly", annualOk: false };
const currency = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
type Health = { browser: string; persistence: string; gateway: boolean; exa: boolean; agentmail: boolean };
const stages = [
  { id: "source", label: "Open the offer" }, { id: "evidence", label: "Capture the source passages" },
  { id: "rules", label: "Check your requirements" }, { id: "alternative", label: "Select a suitable plan" }, { id: "quote", label: "Verify the resulting quote" },
  { id: "approval", label: "Your approval" }, { id: "receipt", label: "Receipt saved" },
];

function FindingRow({ finding, showSource }: { finding: Finding; showSource: (url: string) => void }) {
  return <details className={"finding " + finding.status}>
    <summary><span className="fact-icon">{finding.status === "established" ? "✓" : "?"}</span><span><b>{finding.field}</b><small>{finding.subject}</small></span><span className="fact-value">{finding.value}</span><span className="expand-icon">+</span></summary>
    <div className="finding-body"><div className="source-kind">{finding.status === "unresolved" ? "Not established" : "Captured source passage"}{finding.sourceKind !== "browser" ? " · " + finding.sourceKind + " input" : ""}</div><blockquote>{finding.passage}</blockquote><div className="source-controls"><button onClick={() => showSource(finding.url)}>Show source in browser ↗</button><a href={finding.url} target="_blank" rel="noreferrer">Open page ↗</a></div><div className="source-url">{finding.url}</div><time dateTime={finding.capturedAt}>Captured {new Date(finding.capturedAt).toLocaleString()}</time></div>
  </details>;
}

export default function Home() {
  const [url, setUrl] = useState("https://demo.secondlook.local/offer");
  const [pastedText, setPastedText] = useState("");
  const [requirements, setRequirements] = useState<Requirements>(defaults);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [liveCapture, setLiveCapture] = useState<BrowserCapture | null>(null);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [phase, setPhase] = useState<"idle" | "analyzing" | "saving">("idle");
  const [reviewedInput, setReviewedInput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [record, setRecord] = useState<DecisionRecord | null>(null);
  const [recordToken, setRecordToken] = useState("");
  const [persistence, setPersistence] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [browserTab, setBrowserTab] = useState("offer");
  const [sourceUrl, setSourceUrl] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [realResearchRun, setRealResearchRun] = useState(0);
  const approveDialog = useRef<HTMLDialogElement>(null);
  const recordDialog = useRef<HTMLDialogElement>(null);
  const chatDialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const currentInput = JSON.stringify({ url, pastedText, requirements });
  const stale = Boolean(analysis && currentInput !== reviewedInput);
  const busy = phase !== "idle";
  const canApprove = Boolean(analysis?.analysisToken && analysis?.verifiedQuote && analysis?.alternativeDecision?.eligible && !stale && !busy);
  const syntheticUrl = (() => { try { const candidate = new URL(url); return candidate.hostname === "demo.secondlook.local" || (candidate.origin === window.location.origin && candidate.pathname.startsWith("/demo-storefront/")); } catch { return false; } })();
  const scenario = (() => { try { return new URL(url).searchParams.get("scenario") || "standard"; } catch { return "standard"; } })();
  const fixtureUrl = "/demo-storefront/" + (browserTab === "capture" ? "offer" : browserTab) + "?scenario=" + scenario;
  const iframeUrl = sourceUrl || fixtureUrl;
  const displayedCapture = analysis?.browserCapture ?? liveCapture;
  const showCapture = browserTab === "capture" && !sourceUrl && displayedCapture;
  const cancellation = analysis?.findings.find(item => item.id === "cancellation");
  const currentRecord = Boolean(record && analysis && record.analysisId === analysis.id && !stale);
  const shownProgress: Array<Omit<ProgressItem, "state"> & { state: ProgressItem["state"] | "waiting" }> = [...(analysis?.progress ?? progress),
    { id: "approval", label: "Your approval", state: currentRecord ? "complete" : canApprove ? "active" : "waiting" },
    { id: "receipt", label: persistence === "neon" ? "Receipt saved in Neon" : "Receipt saved temporarily", state: currentRecord ? "complete" : "waiting" },
  ];

  useEffect(() => { fetch("/api/health").then(response => response.json()).then(setHealth).catch(() => undefined); return () => abort.current?.abort(); }, []);
  useEffect(() => { if (record) recordDialog.current?.showModal(); }, [record]);
  useEffect(() => {
    approveDialog.current?.setAttribute("aria-label", "Review exact demo quote");
    recordDialog.current?.setAttribute("aria-label", "Saved decision receipt");
    chatDialog.current?.setAttribute("aria-label", "Evidence assistant");
  }, []);
  useEffect(() => { setNotice(""); }, [currentInput]);

  function showSource(source: string) {
    setBrowserTab("source"); setSourceUrl(source);
    document.getElementById("browser-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function inspect(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!syntheticUrl) {
      abort.current?.abort(); setAnalysis(null); setLiveCapture(null); setProgress([]); setError(""); setNotice("");
      setRealResearchRun(value => value + 1);
      return;
    }
    const snapshot = currentInput;
    const controller = new AbortController();
    abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 110_000);
    setPhase("analyzing"); setError(""); setNotice(""); setAnalysis(null); setLiveCapture(null); setProgress([]); setSourceUrl(""); setBrowserTab("offer"); setChatOpen(false);
    let completed = false;
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ url, pastedText, requirements, initialPlanId: "annual" }), signal: controller.signal });
      if (!response.ok) { const failure = await response.json(); throw new Error(failure.error || "The offer could not be checked."); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The inspection stream is unavailable. Try again.");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const type = chunk.split("\n").find(line => line.startsWith("event: "))?.slice(7);
          const raw = chunk.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (type === "error") throw new Error(data.error);
          if (type === "progress") setProgress(previous => [...previous.filter(item => item.id !== data.id), data as ProgressItem]);
          if (type === "capture") { setLiveCapture(data as BrowserCapture); setBrowserTab("capture"); setSourceUrl(""); }
          if (type === "result") { setAnalysis(data as Analysis); setReviewedInput(snapshot); setBrowserTab("capture"); completed = true; }
        }
        if (done) break;
      }
      if (!completed) throw new Error("Inspection ended before the quote could be verified. Nothing was approved.");
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "AbortError" ? "Inspection stopped. No quote was approved. Run the check again when ready." : cause instanceof Error ? cause.message : "The offer check failed. Try again.");
    } finally { clearTimeout(timeout); abort.current = null; setPhase("idle"); }
  }

  async function approve() {
    if (!canApprove || !analysis?.alternative || !analysis.verifiedQuote || !analysis.analysisToken) return;
    setPhase("saving"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisToken: analysis.analysisToken, planId: analysis.alternative.id, expectedAmount: analysis.verifiedQuote.amount }), signal: AbortSignal.timeout(60_000) });
      const data = await response.json();
      if (!response.ok) {
        if (data.changed) {
          setAnalysis({ ...analysis, alternative: data.reevaluatedDecision.plan, alternativeDecision: data.reevaluatedDecision,
            verifiedQuote: data.verifiedQuote, analysisToken: data.analysisToken, browserCapture: data.browserCapture });
          setNotice("The final total changed from " + currency(analysis.verifiedQuote.amount) + " to " + currency(data.verifiedQuote.amount) + ". Your rules were checked again. " + (data.reevaluatedDecision.eligible ? "Review this new quote before approving." : "It no longer fits. Approval is blocked."));
          setSourceUrl(""); setBrowserTab("capture"); approveDialog.current?.close();
          return;
        }
        throw new Error(data.error || "The quote could not be confirmed.");
      }
      const confirmation = await fetch("/api/record", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: data.quote.id, analysisToken: analysis.analysisToken }), signal: AbortSignal.timeout(15_000) });
      const stored = await confirmation.json();
      if (!confirmation.ok || stored.record.amount !== data.quote.amount || stored.record.analysisId !== analysis.id ||
        stored.record.planId !== data.quote.planId || stored.record.verifiedQuote.url !== data.quote.verifiedQuote.url ||
        stored.record.verifiedQuote.cadence !== data.quote.verifiedQuote.cadence || stored.record.verifiedQuote.commitment !== data.quote.verifiedQuote.commitment) {
        throw new Error("The save response could not be confirmed by reading the record. Retry to recover the existing decision.");
      }
      setRecord(stored.record); setRecordToken(analysis.analysisToken); setPersistence(data.persistence);
      setNotice(data.duplicate ? "This exact quote was already saved. The existing record was retrieved." : "Your exact demo quote and decision record were saved and retrieved.");
      approveDialog.current?.close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The decision could not be saved. Retry."); approveDialog.current?.close(); }
    finally { setPhase("idle"); }
  }

  return <main className="app-shell">
    <div className="demo-bar"><span className="tiny-dot" /> Synthetic subscription demo <span>No payment or real subscription</span><a href="/demo-storefront/offer" target="_blank" rel="noreferrer">Meet the storefront ↗</a></div>
    <header className="topbar"><a className="wordmark" href="/"><span className="brand-symbol">◉</span>second look<span className="beta-tag">personal agent</span></a><div className="header-actions">{record && <button className="quiet-button" onClick={() => recordDialog.current?.showModal()}>Decision record <span>↗</span></button>}<span className="privacy-note">Your requirements. Your approval.</span></div></header>
    {analysis && <section className="stage-verdict" aria-label="Current quote verdict" data-state={stale ? "stale" : currentRecord ? "saved" : analysis.analysisToken ? "ready" : "blocked"}>
      <div className="stage-verdict-context"><span>{stale ? "Preferences changed · check again" : currentRecord ? "Approved · receipt read back" : analysis.analysisToken ? "Verified quote · fits your rules" : "Approval blocked"}</span>{!stale && <b>Annual: {currency(analysis.initial.plan.monthlyEquivalent)}/mo · {currency(analysis.initial.plan.payableToday)} upfront in the original offer · {analysis.initial.eligible ? "fits" : "doesn’t fit"}</b>}</div>
      <div className="stage-verdict-total"><strong>{stale ? "Recheck needed" : analysis.verifiedQuote ? currency(analysis.verifiedQuote.amount) : "No fit"}</strong>{!stale && <span>{analysis.verifiedQuote ? "due today" : "No quote selected"}</span>}</div>
      <button className="stage-verdict-action" disabled={stale ? busy : !canApprove} onClick={() => stale ? void inspect() : approveDialog.current?.showModal()}>{stale ? "Recheck" : "Review quote"}</button>
    </section>}
    {!analysis && realResearchRun === 0 && <section className="intro"><div><p className="kicker">A little clarity before you commit</p><h1>Good offers.<br /><span>Your terms.</span></h1></div><div className="intro-description"><p>Your agent reads the offer, checks the fine print,<br className="desktop-break" /> and finds a plan that actually fits your life.</p><div className="intro-proof"><span>↳</span> Evidence attached. Final quote checked. You decide.</div></div></section>}

    <section className="requirements-bar" aria-label="Your payment and billing requirements"><div className="pref-heading"><span>⌁</span><div><b>Your guardrails</b><small>What works for you?</small></div></div><label className="pref-control"><span>Maximum payment today</span><div className="amount-input"><span>$</span><input aria-label="Maximum amount due today" type="number" step="0.01" min="0" max="10000" value={requirements.maxToday} disabled={busy} onChange={event => setRequirements({ ...requirements, maxToday: Number(event.target.value) })} /></div></label><label className="pref-control"><span>Billing preference</span><select aria-label="Billing preference" value={requirements.billing} disabled={busy} onChange={event => setRequirements({ ...requirements, billing: event.target.value as Requirements["billing"] })}><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="either">Either is fine</option></select></label><label className="commitment-control"><input type="checkbox" checked={requirements.annualOk} disabled={busy} onChange={event => setRequirements({ ...requirements, annualOk: event.target.checked })} /><span className="custom-check">✓</span><span><b>Annual commitment is okay</b><small>A full year can fit my plans</small></span></label></section>

    <form className="offer-form" onSubmit={inspect}><div className="offer-inputs"><label htmlFor="offer-url">The offer you’re considering</label><div className="url-field"><span>↗</span><input id="offer-url" type="url" required value={url} disabled={busy} onChange={event => setUrl(event.target.value)} /></div></div><button className="inspect-button" disabled={busy}>{phase === "analyzing" ? <><span className="button-spinner" />Taking a closer look</> : <>Check this offer <span>↗</span></>}</button></form>
    <div className="input-extras"><details className="paste-field"><summary>Add offer text <span>optional</span></summary><textarea aria-label="Pasted offer text" value={pastedText} disabled={busy} onChange={event => setPastedText(event.target.value)} placeholder="Paste the offer or fine print. We keep user-provided text distinct from browser evidence." rows={3} /></details><div className="scenario-controls" aria-label="Synthetic demo scenarios"><span>Try a scenario</span>{[{ id: "standard", label: "Annual prepayment" }, { id: "missing", label: "Incomplete terms" }, { id: "changed", label: "Quote changes" }].map(item => <button key={item.id} type="button" aria-pressed={scenario === item.id} disabled={busy} onClick={() => setUrl("https://demo.secondlook.local/offer" + (item.id === "standard" ? "" : "?scenario=" + item.id))}>{item.label}</button>)}</div></div>
    <p className="supported-source">Synthetic offers: browser selection and verified demo quote. Public merchant offers: source research and conservative preference checks; no real checkout.</p>
    {stale && <div className="alert stale-note" role="status"><span>↻</span><p>Your inputs changed. Recheck the offer to review a fresh decision.</p><button onClick={() => inspect()} disabled={busy}>Recheck</button></div>}
    {error && <div className="alert error-alert" role="alert"><span>!</span><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="alert notice-alert" role="status"><span>↳</span><p>{notice}</p></div>}

    {!syntheticUrl && realResearchRun > 0 && <RealOfferWorkspace key={realResearchRun} url={url} pastedText={pastedText} requirements={requirements} health={health} autoStart />}
    {syntheticUrl && <div className="workspace-grid">
      <section className="panel browser-panel" id="browser-panel"><div className="panel-heading"><div><span className="window-dots"><i /><i /><i /></span><b>{showCapture ? "Captured browser view" : "Offer & source browser"}</b></div><span className="subtle-tag">{analysis?.mode === "kernel" ? "Kernel" : "Synthetic storefront"}</span></div>
        <div className="browser-tabs" role="group" aria-label="Storefront source pages">{(displayedCapture ? ["capture", "offer", "pricing", "billing", "cancellation"] : ["offer", "pricing", "billing", "cancellation"]).map(tab => <button key={tab} className={browserTab === tab ? "active" : ""} onClick={() => { setBrowserTab(tab); setSourceUrl(""); }}>{tab === "capture" ? (phase === "analyzing" ? "Live inspection" : "Quote capture") : tab}</button>)}</div>
        <div className="browser-address"><span>◈</span><span>{showCapture ? displayedCapture.url : iframeUrl}</span><a href={showCapture ? displayedCapture.url : iframeUrl} target="_blank" rel="noreferrer" aria-label="Open displayed source page">↗</a></div>
        <div className={"browser-viewport " + (phase === "analyzing" ? "inspecting" : "")}>{showCapture ? <img src={displayedCapture.image} alt="Actual browser capture of the Streamly storefront at the displayed source URL" /> : <iframe key={iframeUrl} src={iframeUrl} title="Synthetic Streamly offer and source pages" />}
          {phase === "analyzing" && <div className="browser-working"><span className="button-spinner" />Reading the storefront <button onClick={() => abort.current?.abort()}>Stop</button></div>}</div>
        <div className="browser-caption"><span>{showCapture ? "Captured " + time(displayedCapture.capturedAt) + " · " + (displayedCapture.provider === "kernel" ? "Kernel browser" : "local browser") : "Interactive synthetic source · no real purchase"}</span><span>{showCapture ? (stale ? "Previous capture · recheck needed" : "Observed result") : "Preview"}</span></div>
      </section>

      <aside className={"panel agent-panel " + (analysis ? "has-result" : "")}><div className="panel-heading"><div><span className="agent-mark">◉</span><b>Your second look</b></div><span className={"agent-status " + (busy ? "working" : "")}>{phase === "analyzing" ? "Inspecting" : phase === "saving" ? "Rechecking" : stale ? "Recheck needed" : analysis ? "Review ready" : "Ready"}</span></div>
        {!analysis && phase !== "analyzing" && <div className="empty-agent"><div className="look-art" aria-hidden="true"><span /><span /><i>2</i></div><h2>The small print.<br />The bigger picture.</h2><p>Choose your guardrails, then check the offer.<br />Your agent brings the evidence and the next step.</p><div className="empty-guardrails"><span>{currency(requirements.maxToday)} today</span><span>{requirements.billing} billing</span><span>{requirements.annualOk ? "Annual term allowed" : "No annual term"}</span></div></div>}
        {(analysis || phase === "analyzing") && !stale && <ol className="progress-list" aria-live="polite">{stages.map(stage => { const item = shownProgress.find(item => item.id === stage.id); return <li className={item?.state || "waiting"} key={stage.id} title={item?.label}><span className="progress-node">{item?.state === "complete" ? "✓" : item?.state === "unresolved" ? "?" : item?.state === "active" ? <i /> : "·"}</span><span>{stage.id === "receipt" && currentRecord ? item?.label : stage.label}</span></li>; })}</ol>}
        {stale && <div className="proposal"><h2>Check your new terms.</h2><p>The previous recommendation is hidden because your requirements changed. No current quote is ready for approval.</p></div>}
        {analysis && !stale && <div className="proposal"><div className={"verdict-label" + (analysis.alternativeDecision?.eligible ? "" : " blocked")}>{analysis.alternativeDecision?.eligible ? <><span>✓</span> A plan that fits your rules</> : <><span>!</span> Approval is blocked</>}</div><h2>{analysis.alternative ? analysis.alternative.name + " works" + (analysis.alternativeDecision?.eligible ? " for you." : " differently now.") : "No plan fits yet."}</h2>
          {analysis.verifiedQuote && <div className="proposed-total"><strong>{currency(analysis.verifiedQuote.amount)}</strong><span>due today<br /><b>{analysis.verifiedQuote.cadence} billing</b></span></div>}
          <p>{currency(analysis.initial.plan.monthlyEquivalent)}/mo is the annual equivalent, but it’s {currency(analysis.initial.plan.payableToday)} today with a one-year term. {analysis.initial.eligible ? "That fits your settings." : "That does not fit your settings."}</p>
          <div className="proposal-rules">{analysis.alternativeDecision?.checks.map(check => <div key={check.label} className={check.pass ? "passes" : "fails"}><span>{check.pass ? "✓" : "×"}</span><span>{check.detail}</span></div>)}</div>
          {cancellation?.status === "unresolved" && <div className="terms-warning"><b>Cancellation timing is not established.</b><span>We found enough to check your three preferences, but this term remains unresolved.</span></div>}
          {analysis.verifiedQuote && <button className="review-quote-button" disabled={!canApprove} onClick={() => approveDialog.current?.showModal()}>Review exact demo quote <span>↗</span></button>}
          {!analysis.alternative && <p className="no-fit-help">Adjust your payment limit or billing preference, then check again. No plan was selected.</p>}
          <small className="approval-note">You approve the exact plan and amount. No real payment.</small>
        </div>}
      </aside>
    </div>}

    {analysis && !stale && <section className="results-detail"><div className="result-detail-header"><div><p className="kicker">The decision, with receipts</p><h2>Everything behind the recommendation.</h2></div><button className="quiet-button" disabled={!health?.gateway || !analysis.analysisToken} title={!health?.gateway ? "Connect the Neon AI Gateway to enable evidence questions" : undefined} onClick={() => { setChatOpen(true); chatDialog.current?.showModal(); }}>Ask about the evidence <span>↗</span></button></div>
      <div className="detail-grid"><section className="panel evidence-panel"><div className="panel-heading"><div><span className="section-symbol">≋</span><b>Source findings</b></div><span>{analysis.findings.filter(item => item.status === "established").length} established · {analysis.findings.filter(item => item.status === "unresolved").length} unresolved</span></div><div className="evidence-list">{analysis.findings.map(finding => <FindingRow key={finding.id} finding={finding} showSource={showSource} />)}</div></section>
        <section className="panel decision-panel"><div className="panel-heading"><div><span className="section-symbol">⌁</span><b>Your preferences, applied</b></div><span>Deterministic checks</span></div><div className="decision-intro"><h3>A true price can still be a poor fit.</h3><p>The annual monthly equivalent is {currency(analysis.initial.plan.monthlyEquivalent)}. The payment today is {currency(analysis.initial.plan.payableToday)}. Those are different facts.</p></div><div className="comparison-table">{[analysis.initial, ...(analysis.alternativeDecision && analysis.alternativeDecision.plan.id !== analysis.initial.plan.id ? [analysis.alternativeDecision] : [])].map(decision => <article key={decision.plan.id}><div className="comparison-heading"><b>{decision.plan.name}</b><strong>{currency(decision.plan.payableToday)} <small>today</small></strong><span className={decision.eligible ? "eligible" : "ineligible"}>{decision.eligible ? "Fits" : "Doesn’t fit"}</span></div>{decision.checks.map(check => <div className="comparison-rule" key={check.label}><span>{check.label}</span><span className={check.pass ? "passes" : "fails"}>{check.pass ? "✓ Pass" : "× Fail"}</span></div>)}</article>)}</div><p className="method-note">Source truth and personal eligibility are evaluated separately. Missing evidence remains unresolved.</p></section></div>
    </section>}

    <dialog className="approval-sheet" ref={approveDialog} onCancel={event => { if (phase === "saving") event.preventDefault(); }}><button className="icon-button sheet-close" aria-label="Close quote review" onClick={() => approveDialog.current?.close()} disabled={phase === "saving"}>×</button><p className="kicker">Your approval is the final step</p><h2>One last look.</h2><p>Approve creation of this exact synthetic demo quote.</p>{analysis?.verifiedQuote && analysis.alternative && <><div className="quote-total"><strong>{currency(analysis.verifiedQuote.amount)}</strong><span>due today</span></div><dl className="quote-details"><div><dt>Product & plan</dt><dd>Streamly {analysis.alternative.name}</dd></div><div><dt>Billing</dt><dd>{analysis.verifiedQuote.cadence}</dd></div><div><dt>Commitment</dt><dd>{analysis.verifiedQuote.commitment ? "One year" : "No annual term"}</dd></div><div><dt>Your payment limit</dt><dd>{currency(requirements.maxToday)}</dd></div><div><dt>Cancellation timing</dt><dd>{cancellation?.status === "established" ? "Before next billing date" : "Not established"}</dd></div></dl><blockquote className="quote-proof">{analysis.verifiedQuote.passage}</blockquote><a className="text-link" href={analysis.verifiedQuote.url} target="_blank" rel="noreferrer">Inspect the quote source ↗</a><button className="confirm-button" disabled={!canApprove} onClick={approve}>{phase === "saving" ? <><span className="button-spinner" />Rechecking and saving…</> : "Approve this demo quote"}</button></>}<small>Creates a decision record only. No subscription or payment is created.</small></dialog>

    <dialog className="record-drawer" ref={recordDialog}><button className="icon-button sheet-close" aria-label="Close decision record" onClick={() => recordDialog.current?.close()}>×</button>{record && <><p className="kicker">{persistence === "neon" ? "Verified and persisted" : "Verified · temporary record"}</p><h2>Your decision receipt.</h2><span className="record-id">{record.id}</span><div className="record-total"><strong>{currency(record.amount)}</strong><span>Streamly {record.selectedDecision.plan.name}<br />{record.selectedDecision.plan.cadence} billing</span></div><div className="record-storage"><span>{persistence === "neon" ? "✓" : "!"}</span>{persistence === "neon" ? "Persisted in Neon and read back" : "Temporary local record; cleared on process restart"}</div><time>{new Date(record.createdAt).toLocaleString()}</time><h3>Your approved requirements</h3><dl className="quote-details"><div><dt>Maximum today</dt><dd>{currency(record.requirements.maxToday)}</dd></div><div><dt>Billing</dt><dd>{record.requirements.billing}</dd></div><div><dt>Annual term acceptable</dt><dd>{record.requirements.annualOk ? "Yes" : "No"}</dd></div></dl><h3>The verified quote passage</h3><blockquote className="quote-proof">{record.verifiedQuote.passage}</blockquote><a className="text-link" href={record.verifiedQuote.url} target="_blank" rel="noreferrer">Open exact quote source ↗</a><details className="record-json"><summary>Inspect the full decision record</summary><pre>{JSON.stringify(record, null, 2)}</pre></details><button className="quiet-button download-record" onClick={() => { const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }); const download = document.createElement("a"); const objectUrl = URL.createObjectURL(blob); download.href = objectUrl; download.download = record.id + ".json"; download.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }}>Download decision record ↗</button></>}</dialog>
    <dialog className="chat-drawer" ref={chatDialog} onClose={() => setChatOpen(false)}><button className="icon-button sheet-close" aria-label="Close evidence assistant" onClick={() => chatDialog.current?.close()}>×</button><p className="kicker">Explain this review</p><h2>Ask Second Look.</h2>{chatOpen && analysis?.analysisToken && <EvidenceChat analysisToken={analysis.analysisToken} canReviewQuote={canApprove} onReviewQuote={() => { if (!canApprove) return; chatDialog.current?.close(); approveDialog.current?.showModal(); }} />}</dialog>

    {(syntheticUrl || realResearchRun === 0) && <ResearchPanel gateway={Boolean(health?.gateway)} exa={Boolean(health?.exa)} />}
    {record && recordToken && <ReceiptEmail key={record.id} id={record.id} analysisToken={recordToken} enabled={Boolean(health?.agentmail)} target={recordDialog.current} />}

    <footer className="page-footer"><span className="wordmark"><span className="brand-symbol">◉</span>second look</span><span>A clearer yes. A better no.</span><details className="stack-status"><summary>Demo capabilities</summary><p>Browser: {health?.browser ?? "checking configuration"}</p><p>Storage: {health?.persistence === "neon" ? "Neon configured" : "temporary local memory"}</p><p>Agent: {health?.gateway ? "Mastra + Neon AI Gateway configured" : "deterministic fixture extraction; Gateway not connected"}</p><p>Search: {health?.exa ? "Exa configured" : "Exa not connected"}</p>{analysis && <p>Observed extraction path: {analysis.extraction}</p>}</details></footer>
  </main>;
}
