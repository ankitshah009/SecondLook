import { lookup as dnsLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

export const MAX_RESEARCH_URL_LENGTH = 2_048;
export const MAX_PASTED_TEXT_LENGTH = 12_000;
export const MAX_RESEARCH_BODY_BYTES = 64 * 1_024;
const MAX_PASSAGE_LENGTH = 1_600;
const MAX_SEARCH_PASSAGE_LENGTH = 2_400;
const EXA_API = "https://api.exa.ai";
const EXA_TIMEOUT_MS = 18_000;

const researchRequestSchema = z.object({
  url: z.string().trim().min(1).max(MAX_RESEARCH_URL_LENGTH),
  pastedText: z.string().max(MAX_PASTED_TEXT_LENGTH).optional(),
}).strict();

export type ResearchSource = {
  id: string;
  title: string;
  url: string;
  passage: string;
  capturedAt: string;
  subject: string;
  status: "retrieved" | "unresolved";
  sourceKind: "exa" | "pasted";
};

export type ResearchResult = {
  sources: ResearchSource[];
  limitations: string[];
  mode: "research-only";
  checkoutEnabled: false;
};

type ResolvedAddress = { address: string; family: number };
export type ResearchDependencies = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
};

export class ResearchInputError extends Error {
  constructor(message: string) { super(message); this.name = "ResearchInputError"; }
}

export class ResearchUnavailableError extends Error {
  constructor(message = "Research is temporarily unavailable. Please try again.") {
    super(message); this.name = "ResearchUnavailableError";
  }
}

export class ResearchAbortedError extends Error {
  constructor() { super("Research was cancelled."); this.name = "ResearchAbortedError"; }
}

class BodyTooLargeError extends Error {}

type Topic = { id: string; subject: string; terms: string[]; query: (domain: string) => string };
const topics: Topic[] = [
  {
    id: "pricing", subject: "Pricing and plans", terms: ["price", "pricing", "plan", "plans", "cost", "monthly", "annual", "yearly", "subscription"],
    query: domain => `${domain} official subscription pricing plans price monthly annual`,
  },
  {
    id: "billing", subject: "Billing and renewals", terms: ["billing", "bill", "payment", "charge", "renew", "renewal", "monthly", "annual", "subscription"],
    query: domain => `${domain} official subscription billing payment charges renewal billing frequency`,
  },
  {
    id: "cancellation", subject: "Cancellation and refunds", terms: ["cancel", "cancellation", "refund", "subscription", "terminate", "termination", "renewal", "notice"],
    query: domain => `${domain} official subscription cancellation cancel refund policy`,
  },
];

type ExaResult = { title?: unknown; url?: unknown; text?: unknown };
type ExaResponse = { results?: unknown };

function isSpecialUseHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return !host.includes(".") || [
    "localhost", "local", "internal", "lan", "home", "test", "example", "invalid", "onion",
  ].some(suffix => host === suffix || host.endsWith("." + suffix));
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99) || (b === 0 && c === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
    // Accept global-unicast space only; this excludes unspecified, loopback,
    // mapped IPv4, unique-local, link-local, multicast, and reserved ranges.
    return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && (second === 0 || second === 0x0db8));
  }
  return false;
}

function parsePublicWebUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ResearchInputError("Enter a valid public HTTP or HTTPS offer URL."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!(["http:", "https:"].includes(url.protocol)) || !hostname || url.username || url.password || isIP(hostname) || isSpecialUseHostname(hostname)) {
    throw new ResearchInputError("Use a public HTTP or HTTPS URL without credentials, IP addresses, or local/private hosts.");
  }
  url.hash = "";
  return url;
}

function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function assertPublicHost(hostname: string, resolveHost: NonNullable<ResearchDependencies["resolveHost"]>, signal: AbortSignal) {
  let addresses: ResolvedAddress[];
  try { addresses = await raceSignal(resolveHost(hostname), signal); }
  catch {
    if (signal.aborted) throw signal.reason;
    throw new ResearchInputError("The offer host could not be verified as publicly reachable.");
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ResearchInputError("Use an offer URL that resolves only to public IP addresses.");
  }
}

function sourceId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isSameDomain(candidate: string, domain: string): boolean {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !isIP(hostname)
      && !isSpecialUseHostname(hostname) && (hostname === domain || hostname.endsWith("." + domain));
  } catch { return false; }
}

function choosePassage(text: string, terms: string[], maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  // Split only after punctuation followed by whitespace, never inside $12.99.
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  let best = "";
  let bestScore = 0;
  let bestIndex = -1;
  for (const [index, sentence] of sentences.entries()) {
    const candidate = sentence.trim();
    const lower = candidate.toLowerCase();
    const score = [...new Set(terms)].reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0)
      + (/\$\s?\d|\b(?:usd|eur|gbp)\s?\d/i.test(candidate) ? 3 : 0);
    if (score > bestScore) { best = candidate; bestScore = score; bestIndex = index; }
  }
  if (!bestScore) return "";
  const context = sentences.slice(Math.max(0, bestIndex - 2), bestIndex + 2).join(" ");
  return context.length <= maxLength ? context : best.slice(0, maxLength).trimEnd();
}

function resultRows(value: unknown): ExaResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ExaResult => Boolean(item) && typeof item === "object");
}

async function exaPost(endpoint: "search" | "contents", body: unknown, apiKey: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ExaResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${EXA_API}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ResearchUnavailableError();
  }
  if (!response.ok) throw new ResearchUnavailableError();
  try {
    const json: unknown = await response.json();
    if (!json || typeof json !== "object") throw new Error("Invalid response");
    return json as ExaResponse;
  } catch {
    throw new ResearchUnavailableError();
  }
}

export async function researchOffer(input: unknown, dependencies: ResearchDependencies = {}): Promise<ResearchResult> {
  const parsed = researchRequestSchema.safeParse(input);
  if (!parsed.success) throw new ResearchInputError("Provide an offer URL and optional offer text within the supported size limits.");
  if (!dependencies.apiKey?.trim()) throw new ResearchUnavailableError("Offer research is unavailable because EXA_API_KEY is not configured.");

  const offerUrl = parsePublicWebUrl(parsed.data.url);
  const suppliedText = parsed.data.pastedText?.trim() ?? "";
  const timeoutSignal = AbortSignal.timeout(dependencies.timeoutMs ?? EXA_TIMEOUT_MS);
  const signal = dependencies.signal ? AbortSignal.any([timeoutSignal, dependencies.signal]) : timeoutSignal;
  await assertPublicHost(offerUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, ""), dependencies.resolveHost ?? defaultResolveHost, signal);

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const domain = offerUrl.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const requests = [
    exaPost("contents", { urls: [offerUrl.href], text: { maxCharacters: 8_000 }, livecrawlTimeout: 12_000 }, dependencies.apiKey, fetchImpl, signal),
    ...topics.map(topic => exaPost("search", {
      query: topic.query(domain),
      type: "fast",
      numResults: 1,
      includeDomains: domain === offerUrl.hostname.toLowerCase().replace(/^www\./, "") ? [domain] : [domain, offerUrl.hostname],
      contents: { text: { maxCharacters: 2_400 } },
    }, dependencies.apiKey!, fetchImpl, signal)),
  ];
  const outcomes = await Promise.allSettled(requests);
  if (dependencies.signal?.aborted) throw new ResearchAbortedError();
  if (signal.aborted) throw new ResearchUnavailableError("Offer research timed out. Please try again.");

  const sources: ResearchSource[] = [];
  const limitations = [
    `Search is restricted to ${domain} and the submitted offer URL; coverage may be incomplete or stale.`,
    "Domain-matched passages may refer to other products or plans; applicability to the exact offer has not been established.",
    "This is read-only research. It does not determine eligibility, recommend a plan, approve a purchase, or enable checkout.",
  ];
  let successfulProviderCalls = 0;
  const stamp = () => now().toISOString();
  const addUnresolved = (id: string, subject: string, passage: string, url = offerUrl.href) => {
    sources.push({ id: `exa-${id}`, title: `${subject} source not established`, url, passage, capturedAt: stamp(), subject, status: "unresolved", sourceKind: "exa" });
  };

  const contentOutcome = outcomes[0];
  if (contentOutcome.status === "fulfilled") {
    successfulProviderCalls++;
    const result = resultRows(contentOutcome.value.results)[0];
    const resultUrl = typeof result?.url === "string" && isSameDomain(result.url, domain) ? new URL(result.url).href : "";
    const passage = typeof result?.text === "string" ? choosePassage(result.text, [...topics[0].terms, ...topics[1].terms, ...topics[2].terms], MAX_PASSAGE_LENGTH) : "";
    if (resultUrl && passage) {
      sources.push({ id: `exa-offer-${sourceId(resultUrl)}`, title: typeof result?.title === "string" && result.title.trim() ? result.title.trim() : "Submitted offer page", url: resultUrl, passage, capturedAt: stamp(), subject: "Submitted offer page", status: "retrieved", sourceKind: "exa" });
    } else {
      addUnresolved("offer", "Submitted offer page", "No readable passage was returned for the submitted offer URL.");
      limitations.push("The submitted offer page did not return readable text.");
    }
  } else {
    addUnresolved("offer", "Submitted offer page", "The submitted offer page could not be retrieved.");
    limitations.push("The submitted offer page could not be retrieved.");
  }

  for (let index = 0; index < topics.length; index++) {
    const topic = topics[index];
    const subject = `${domain} · ${topic.subject}`;
    const outcome = outcomes[index + 1];
    if (outcome.status !== "fulfilled") {
      addUnresolved(topic.id, subject, `No ${topic.subject.toLowerCase()} passage was retrieved from ${domain}.`);
      limitations.push(`No readable ${topic.subject.toLowerCase()} result was retrieved.`);
      continue;
    }
    successfulProviderCalls++;
    const candidates = resultRows(outcome.value.results)
      .filter(result => typeof result.url === "string" && isSameDomain(result.url, domain));
    const match = candidates.map(result => ({ result, passage: typeof result.text === "string" ? choosePassage(result.text, topic.terms, MAX_SEARCH_PASSAGE_LENGTH) : "" }))
      .find(item => item.passage);
    if (match) {
      const sourceUrl = new URL(match.result.url as string).href;
      sources.push({
        id: `exa-${topic.id}-${sourceId(sourceUrl)}`,
        title: typeof match.result.title === "string" && match.result.title.trim() ? match.result.title.trim() : `${subject} page`,
        url: sourceUrl, passage: match.passage, capturedAt: stamp(), subject, status: "retrieved", sourceKind: "exa",
      });
    } else {
      addUnresolved(topic.id, subject, `No relevant ${topic.subject.toLowerCase()} passage was found on ${domain}.`);
      limitations.push(`No relevant ${topic.subject.toLowerCase()} passage was found on this domain.`);
    }
  }

  if (successfulProviderCalls === 0) throw new ResearchUnavailableError();
  if (suppliedText) {
    sources.push({
      id: `pasted-${sourceId(suppliedText)}`, title: "Pasted offer text", url: offerUrl.href, passage: suppliedText,
      capturedAt: stamp(), subject: "User-provided context", status: "unresolved", sourceKind: "pasted",
    });
    limitations.push("Pasted offer text is user-provided and has not been independently verified.");
  }

  return { sources, limitations: [...new Set(limitations)], mode: "research-only", checkoutEnabled: false };
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESEARCH_BODY_BYTES) throw new BodyTooLargeError();
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESEARCH_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function handleResearchRequest(request: Request, dependencies: ResearchDependencies = {}): Promise<Response> {
  let input: unknown;
  try { input = await readLimitedJson(request); }
  catch (error) {
    if (error instanceof BodyTooLargeError) return Response.json({ error: "Research input exceeds the 64 KB request limit." }, { status: 413 });
    return Response.json({ error: "Send valid JSON with an offer URL and optional pasted text." }, { status: 400 });
  }

  try {
    const result = await researchOffer(input, { ...dependencies, signal: request.signal });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ResearchInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof ResearchAbortedError || request.signal.aborted) return Response.json({ error: "Research was cancelled." }, { status: 499 });
    if (error instanceof ResearchUnavailableError) return Response.json({ error: error.message }, { status: 503 });
    return Response.json({ error: "Offer research is temporarily unavailable. Please try again." }, { status: 503 });
  }
}
