"use client";

import { useEffect, useState, type FormEvent } from "react";

type ResearchPanelProps = { gateway?: boolean; exa?: boolean };
type ResearchSource = {
  id: string;
  title: string;
  url: string;
  passage: string;
  capturedAt: string;
  subject: string;
  status: "retrieved" | "unresolved";
  sourceKind: "exa" | "pasted";
};
type ScreenshotFinding = {
  field: string;
  value: string;
  passage: string;
  subject: string;
  status: "unresolved";
};
type Health = { gateway: boolean; exa: boolean };
type ResearchResult = { sources: ResearchSource[]; limitations: string[]; mode: "research-only"; checkoutEnabled: false };
type ScreenshotResult = { findings: ScreenshotFinding[]; capturedAt: string; url: string; mode: "screenshot-input"; checkoutEnabled: false };

const maxImageBytes = 2 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const imageAccept = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

function errorMessage(value: unknown, fallback: string) {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : fallback;
}

function isWebUrl(value: string) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error("The server returned an unreadable response. Try again in a moment."); }
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected image could not be read. Choose it again or try another file."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("The selected image could not be converted. Choose it again."));
    reader.readAsDataURL(file);
  });
}

function validSource(value: unknown): value is ResearchSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<ResearchSource>;
  return typeof source.id === "string" && typeof source.title === "string" && typeof source.url === "string" && isWebUrl(source.url) &&
    typeof source.passage === "string" && typeof source.capturedAt === "string" && typeof source.subject === "string" &&
    (source.status === "retrieved" || source.status === "unresolved") && (source.sourceKind === "exa" || source.sourceKind === "pasted");
}

function validFinding(value: unknown): value is ScreenshotFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<ScreenshotFinding>;
  return typeof finding.field === "string" && typeof finding.value === "string" && typeof finding.passage === "string" &&
    typeof finding.subject === "string" && finding.status === "unresolved";
}

export default function ResearchPanel({ gateway, exa }: ResearchPanelProps = {}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthState, setHealthState] = useState<"checking" | "ready" | "error">("checking");
  const [offerUrl, setOfferUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [active, setActive] = useState<"research" | "screenshot" | null>(null);
  const [researchError, setResearchError] = useState("");
  const [screenshotError, setScreenshotError] = useState("");
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [screenshotResult, setScreenshotResult] = useState<ScreenshotResult | null>(null);

  useEffect(() => {
    if (gateway !== undefined && exa !== undefined) {
      setHealthState("ready");
      return;
    }
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || typeof data.gateway !== "boolean" || typeof data.exa !== "boolean") throw new Error("Provider status could not be read.");
        setHealth({ gateway: data.gateway, exa: data.exa });
        setHealthState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setHealthState("error"); });
    return () => controller.abort();
  }, [gateway, exa]);

  useEffect(() => {
    if (!imageFile) { setImagePreview(""); return; }
    const objectUrl = URL.createObjectURL(imageFile);
    setImagePreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [imageFile]);

  const gatewayAvailable = gateway ?? health?.gateway ?? false;
  const exaAvailable = exa ?? health?.exa ?? false;
  const gatewayChecking = healthState === "checking" && gateway === undefined;
  const exaChecking = healthState === "checking" && exa === undefined;
  const availabilityError = healthState === "error" && (gateway === undefined || exa === undefined);
  const validOfferUrl = isWebUrl(offerUrl.trim());

  async function research(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active || !exaAvailable || !validOfferUrl) return;
    setActive("research"); setResearchError("");
    try {
      const response = await fetch("/api/research", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: offerUrl.trim(), ...(pastedText.trim() ? { pastedText: pastedText.trim() } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const data: unknown = await responseJson(response);
      if (!response.ok) throw new Error(errorMessage(data, "Source research is unavailable. Check the URL and try again."));
      if (!data || typeof data !== "object" || (data as ResearchResult).mode !== "research-only" || (data as ResearchResult).checkoutEnabled !== false ||
          !Array.isArray((data as ResearchResult).sources) || !(data as ResearchResult).sources.every(validSource) ||
          !Array.isArray((data as ResearchResult).limitations) || !(data as ResearchResult).limitations.every((item: unknown) => typeof item === "string")) {
        throw new Error("The research response was incomplete. No results were shown; try again.");
      }
      setResearchResult(data as ResearchResult);
    } catch (cause) {
      setResearchError(cause instanceof Error && cause.name === "TimeoutError" ? "Source research took too long. Check the URL and try again." : cause instanceof Error ? cause.message : "Source research failed. Try again.");
    } finally { setActive(null); }
  }

  function chooseImage(file?: File) {
    setScreenshotError("");
    setScreenshotResult(null);
    if (!file) { setImageFile(null); return; }
    if (!acceptedImageTypes.has(file.type.toLowerCase())) {
      setImageFile(null); setScreenshotError("Choose a PNG, JPEG, or WebP image."); return;
    }
    if (file.size === 0) {
      setImageFile(null); setScreenshotError("That image is empty. Choose another file."); return;
    }
    if (file.size > maxImageBytes) {
      setImageFile(null); setScreenshotError("That image is over 2 MB. Choose a smaller image and try again."); return;
    }
    setImageFile(file);
  }

  async function inspectImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active || !gatewayAvailable || !imageFile || !validOfferUrl) return;
    setActive("screenshot"); setScreenshotError("");
    try {
      const image = await readImage(imageFile);
      const response = await fetch("/api/screenshot", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ image, url: offerUrl.trim() }), signal: AbortSignal.timeout(60_000),
      });
      const data: unknown = await responseJson(response);
      if (!response.ok) throw new Error(errorMessage(data, "Image review is unavailable. Check the image and try again."));
      if (!data || typeof data !== "object" || (data as ScreenshotResult).mode !== "screenshot-input" || (data as ScreenshotResult).checkoutEnabled !== false ||
          !Array.isArray((data as ScreenshotResult).findings) ||
          !(data as ScreenshotResult).findings.every(validFinding) || typeof (data as ScreenshotResult).capturedAt !== "string" ||
          typeof (data as ScreenshotResult).url !== "string" || !isWebUrl((data as ScreenshotResult).url)) {
        throw new Error("The image review response was incomplete. No findings were shown; try again.");
      }
      setScreenshotResult(data as ScreenshotResult);
    } catch (cause) {
      setScreenshotError(cause instanceof Error && cause.name === "TimeoutError" ? "Image review took too long. Try again." : cause instanceof Error ? cause.message : "Image review failed. Try again.");
    } finally { setActive(null); }
  }

  return <section className="research-panel" aria-labelledby="research-panel-title">
    <header className="research-panel-header">
      <div>
        <p className="research-kicker">Optional offer research</p>
        <h2 id="research-panel-title">Bring in more evidence.</h2>
        <p className="research-intro">Search public sources or ask about a screenshot. Findings stay separate from the quote decision.</p>
      </div>
      <span className="research-only-badge"><span aria-hidden="true">⌕</span> Read only · no checkout</span>
    </header>

    <label className="research-label" htmlFor="research-offer-url">Offer page URL</label>
    <input className="research-url" id="research-offer-url" type="url" inputMode="url" placeholder="https://merchant.example/offer" value={offerUrl} disabled={Boolean(active)} onChange={event => { setOfferUrl(event.target.value); setResearchResult(null); setScreenshotResult(null); setResearchError(""); setScreenshotError(""); }} aria-describedby="research-url-help" />
    <p className="research-url-help" id="research-url-help">Use a full http or https offer URL. Nothing will be purchased or submitted.</p>
    <p className="research-privacy">The URL is sent to Exa for source research; pasted text is not sent to Exa. The URL and screenshot are sent to Neon Gateway for extraction.</p>

    <div className="research-actions">
      <form className="research-action research-search" onSubmit={research}>
        <div className="research-action-heading"><span className="research-action-icon" aria-hidden="true">⌕</span><div><h3>Search for source material</h3><p>Find related public pages and passages.</p></div></div>
        <label className="research-label" htmlFor="research-pasted-text">Offer text <span>optional</span></label>
        <textarea id="research-pasted-text" rows={3} maxLength={12_000} disabled={Boolean(active)} placeholder="Paste offer language to include as clearly labeled input." value={pastedText} onChange={event => { setPastedText(event.target.value); setResearchResult(null); setResearchError(""); }} />
        {!exaAvailable && <p className="research-gate" role="status">{exaChecking ? "Checking Exa availability…" : availabilityError && exa === undefined ? "Provider status could not be checked. Reload to try again." : "Exa is not connected. Search is unavailable until it is configured."}</p>}
        {researchError && <p className="research-error" role="alert">{researchError}</p>}
        <button className="research-submit" type="submit" disabled={!exaAvailable || exaChecking || Boolean(active) || !validOfferUrl}>
          {active === "research" ? <><span className="research-spinner" />Searching sources…</> : <>Search public sources <span aria-hidden="true">↗</span></>}
        </button>
      </form>

      <form className="research-action research-image" onSubmit={inspectImage}>
        <div className="research-action-heading"><span className="research-action-icon image-icon" aria-hidden="true">▧</span><div><h3>Review a screenshot</h3><p>Use an image you provide from the offer.</p></div></div>
        <label className="research-label" htmlFor="research-image-file">Offer screenshot</label>
        <input className="research-file" id="research-image-file" type="file" accept={imageAccept} disabled={!gatewayAvailable || gatewayChecking || Boolean(active)} onChange={event => chooseImage(event.currentTarget.files?.[0])} />
        <p className="research-image-hint">PNG, JPEG, or WebP · up to 2 MB. A provided image is not browser-verified.</p>
        {imagePreview && imageFile && <div className="research-image-preview"><img src={imagePreview} alt="Preview of the image you selected for review" /><span>{imageFile.name}</span></div>}
        {!gatewayAvailable && <p className="research-gate" role="status">{gatewayChecking ? "Checking AI Gateway availability…" : availabilityError && gateway === undefined ? "Provider status could not be checked. Reload to try again." : "The AI Gateway is not connected. Screenshot review is unavailable until it is configured."}</p>}
        {screenshotError && <p className="research-error" role="alert">{screenshotError}</p>}
        <button className="research-submit secondary-submit" type="submit" disabled={!gatewayAvailable || gatewayChecking || Boolean(active) || !imageFile || !validOfferUrl}>
          {active === "screenshot" ? <><span className="research-spinner" />Reviewing image…</> : <>Review provided image <span aria-hidden="true">↗</span></>}
        </button>
      </form>
    </div>

    {active && <p className="research-live" role="status" aria-live="polite">{active === "research" ? "Searching public sources. No purchase or checkout action will be taken." : "Reviewing your provided image. It is not being treated as a browser capture."}</p>}
    {(researchResult || screenshotResult) && <section className="research-results" aria-label="Research findings">
      <div className="research-results-heading"><div><p className="research-kicker">Collected material</p><h3>Evidence to review</h3></div><span>Research only</span></div>
      {researchResult && <div className="research-result-group">
        <h4>Search results <span>{researchResult.sources.length}</span></h4>
        {researchResult.sources.length ? <div className="research-source-list">{researchResult.sources.map((source, index) => <details className="research-source" key={source.id || `${source.url}-${index}`}>
          <summary><span className={`research-source-mark ${source.status}`} aria-hidden="true">{source.status === "retrieved" ? "✓" : "?"}</span><span className="research-source-title"><b>{source.title || "Untitled source"}</b><small>{source.subject} · {source.sourceKind === "pasted" ? "Text you provided" : "Exa public search"}</small></span><span className="research-source-status">{source.status === "retrieved" ? "Retrieved" : "Unresolved"}</span></summary>
          <blockquote>{source.passage}</blockquote><p className="research-empty">Exact product or plan applicability: not established. This passage cannot authorize a quote.</p><a className="research-source-link" href={source.url} target="_blank" rel="noreferrer">Open source in a new tab ↗</a><time dateTime={source.capturedAt}>Captured {new Date(source.capturedAt).toLocaleString()}</time>
        </details>)}</div> : <p className="research-empty">No source passages were returned for this search.</p>}
        {researchResult.limitations.length > 0 && <div className="research-limitations"><b>Limits of this search</b><ul>{researchResult.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul></div>}
      </div>}
      {screenshotResult && <div className="research-result-group screenshot-findings">
        <h4>Image observations <span>{screenshotResult.findings.length}</span></h4>
        <p className="research-image-disclaimer">User-provided image · not browser-verified · unresolved evidence</p>
        {screenshotResult.findings.length ? screenshotResult.findings.map((finding, index) => <details className="research-observation" key={`${finding.field}-${index}`}>
          <summary><span className="research-source-mark unresolved" aria-hidden="true">?</span><span className="research-source-title"><b>{finding.field}</b><small>{finding.subject}</small></span><span className="research-source-status">Unresolved</span></summary>
          <p className="research-observation-value">{finding.value}</p><blockquote>{finding.passage}</blockquote>
        </details>) : <p className="research-empty">No observations were returned for this image.</p>}
        <p className="research-capture-time">Reviewed {new Date(screenshotResult.capturedAt).toLocaleString()} · <a href={screenshotResult.url} target="_blank" rel="noreferrer">Offer page ↗</a></p>
      </div>}
      <p className="research-boundary">This panel gathers material for your review. It does not verify a live checkout, select a plan, or approve a purchase.</p>
    </section>}
  </section>;
}
