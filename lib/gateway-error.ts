export type GatewayFailureCause =
  | "credits_exhausted"
  | "credit_limit"
  | "credit_restriction"
  | "access"
  | "timeout"
  | "model"
  | "provider";

export type GatewayFailureDescription = {
  cause: GatewayFailureCause;
  status: number | null;
  message: string;
};

type ErrorDetails = { texts: string[]; statuses: Array<{ status: number; depth: number }> };

const textKeys = new Set(["message", "responsebody", "body", "error", "detail", "code", "name"]);
const nestedKeys = new Set(["cause", "response", "data"]);
const statusKeys = new Set(["status", "statuscode", "httpstatus", "httpstatuscode"]);

function collectDetails(value: unknown, details: ErrorDetails, seen = new Set<object>(), depth = 0): void {
  if (depth > 5 || value == null) return;
  if (typeof value === "string") {
    details.texts.push(value.slice(0, 12_000));
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { collectDetails(JSON.parse(trimmed), details, seen, depth + 1); } catch { /* Treat malformed body as opaque text. */ }
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) details.texts.push(value.name, value.message);
  if (typeof DOMException !== "undefined" && value instanceof DOMException) details.texts.push(value.name, value.message);
  const record = value as Record<string, unknown>;
  const ownKeys = new Set(Object.getOwnPropertyNames(value));
  for (const key of ownKeys) {
    let entry: unknown;
    try { entry = record[key]; } catch { continue; }
    const normalizedKey = key.toLowerCase();
    if (statusKeys.has(normalizedKey) && typeof entry === "number" && Number.isInteger(entry) && entry >= 100 && entry <= 599) {
      details.statuses.push({ status: entry, depth });
    } else if (textKeys.has(normalizedKey)) {
      if (typeof entry === "string") details.texts.push(entry.slice(0, 12_000));
      else if (entry && typeof entry === "object") collectDetails(entry, details, seen, depth + 1);
    } else if (nestedKeys.has(normalizedKey)) {
      collectDetails(entry, details, seen, depth + 1);
    }
  }
  // Response.status and a few SDK status accessors are inherited getters rather than own fields.
  for (const key of statusKeys) {
    if (ownKeys.has(key)) continue;
    try {
      const entry = record[key];
      if (typeof entry === "number" && Number.isInteger(entry) && entry >= 100 && entry <= 599) {
        details.statuses.push({ status: entry, depth });
      }
    } catch { /* Ignore provider-defined throwing getters. */ }
  }
}

function creditCause(text: string): GatewayFailureCause {
  if (/\b(?:out of|no|insufficient|zero|exhausted|depleted)\s+(?:(?:free|available)\s+)?credits?\b|\bcredit balance\b.{0,40}\b(?:low|empty|insufficient|exhausted|depleted|zero)\b/i.test(text)) {
    return "credits_exhausted";
  }
  if (/\bcredit\b.{0,50}\b(?:limit|quota|cap|threshold)\b|\b(?:limit|quota|cap|threshold)\b.{0,50}\bcredits?\b/i.test(text)) {
    return "credit_limit";
  }
  return "credit_restriction";
}

function describe(cause: GatewayFailureCause, status: number | null): string {
  const statusNote = status === null ? "" : ` (HTTP ${status})`;
  switch (cause) {
    case "credits_exhausted":
      return `The Neon AI Gateway reports that available credits are exhausted${statusNote}. Add Gateway credits or confirm the account balance, then retry. NeonDB query access is separate; this Gateway request did not complete.`;
    case "credit_limit":
      return `The Neon AI Gateway rejected generation because a credit or spending limit was reached${statusNote}. Review the Gateway project’s credit/spend limits, adjust them if appropriate, then retry. NeonDB query access is separate; this Gateway request did not complete.`;
    case "credit_restriction":
      return `The Neon AI Gateway rejected generation for a credit-related restriction${statusNote}. Check the Gateway account’s credits and spending limits, then retry. NeonDB query access is separate; this Gateway request did not complete.`;
    case "access":
      return `The Neon AI Gateway denied access${statusNote}. Verify the Gateway URL, token, and project permissions. This Gateway request did not complete.`;
    case "timeout":
      return `The Neon AI Gateway request timed out${statusNote}. Check Gateway availability and retry. This Gateway request did not complete.`;
    case "model":
      return `The configured model is unavailable to the Neon AI Gateway${statusNote}. Check the configured model name and Gateway model access. This Gateway request did not complete.`;
    default:
      return `The Neon AI Gateway request failed${statusNote}. Check Gateway availability and configuration, then retry. Provider details were omitted; this Gateway request did not complete.`;
  }
}

/** Convert SDK/provider errors to safe user-facing diagnostics. Raw messages are inspected but never returned. */
export function describeGatewayFailure(error: unknown): GatewayFailureDescription {
  const details: ErrorDetails = { texts: [], statuses: [] };
  collectDetails(error, details);
  // Machine-readable codes such as credits_required carry the same meaning
  // as prose, but underscores otherwise prevent word-boundary matches.
  const text = details.texts.join(" ").replace(/[_-]+/g, " ");
  const status = details.statuses.sort((a, b) => a.depth - b.depth)[0]?.status ?? null;

  let cause: GatewayFailureCause;
  if (/\bcredits?\b|\bbalance\b/i.test(text)) {
    cause = creditCause(text);
  } else if (/\b(?:timed?\s*out|timeout|etimedout|econnaborted)\b/i.test(text) || /\b(?:AbortError|TimeoutError)\b/i.test(text)) {
    cause = "timeout";
  } else if ((status === 401 || status === 403) || /\b(?:unauthorized|forbidden|invalid token|authentication failed|permission denied)\b/i.test(text)) {
    cause = "access";
  } else if (/\b(?:model not found|unknown model|model unavailable|model access|unsupported model)\b/i.test(text)) {
    cause = "model";
  } else {
    cause = "provider";
  }

  return { cause, status, message: describe(cause, status) };
}
