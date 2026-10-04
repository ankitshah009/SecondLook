import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { AnalysisClaims } from "@/lib/approval-token";
import type { DecisionRecord } from "@/lib/second-look";

type OutboxState = "pending" | "accepted" | "unknown";
type Reservation = { kind: "reserved" } | { kind: "existing"; state: OutboxState; messageId?: string };
export interface ReceiptOutbox {
  reserve(recordId: string, recipientKey: string): Promise<Reservation>;
  accepted(recordId: string, recipientKey: string, messageId: string, threadId?: string): Promise<void>;
  unknown(recordId: string, recipientKey: string): Promise<void>;
}

export type ReceiptEmailOutcome =
  | { status: "accepted"; messageId: string; duplicate: boolean }
  | { status: "unknown"; error: string; duplicate: boolean }
  | { status: "pending"; error: string; duplicate: true }
  | { status: "not_sent"; error: string };

const memory = globalThis as typeof globalThis & { secondLookReceiptOutbox?: Map<string, { status: OutboxState; messageId?: string }> };
// Temporary process-local fallback for development only; it is lost on restart and is not shared across instances.
memory.secondLookReceiptOutbox ??= new Map();
const memoryRows = memory.secondLookReceiptOutbox;
let tableReady: Promise<void> | undefined;

const memoryOutbox: ReceiptOutbox = {
  async reserve(recordId, recipientKey) {
    const key = recordId + ":" + recipientKey;
    const existing = memoryRows.get(key);
    if (existing) return { kind: "existing", state: existing.status, messageId: existing.messageId };
    memoryRows.set(key, { status: "pending" });
    return { kind: "reserved" };
  },
  async accepted(recordId, recipientKey, messageId) {
    memoryRows.set(recordId + ":" + recipientKey, { status: "accepted", messageId });
  },
  async unknown(recordId, recipientKey) {
    memoryRows.set(recordId + ":" + recipientKey, { status: "unknown" });
  },
};

function neonOutbox(databaseUrl: string): ReceiptOutbox {
  const sql = neon(databaseUrl, { fetchOptions: { signal: AbortSignal.timeout(10_000) } });
  async function ensureTable() {
    tableReady ??= sql.query("CREATE TABLE IF NOT EXISTS second_look_receipt_mail_outbox (record_id text NOT NULL, recipient_key text NOT NULL, status text NOT NULL CHECK (status IN ('pending','accepted','unknown')), message_id text, thread_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (record_id, recipient_key))")
      .then(() => undefined).catch(error => { tableReady = undefined; throw error; });
    await tableReady;
  }
  return {
    async reserve(recordId, recipientKey) {
      await ensureTable();
      const inserted = await sql.query("INSERT INTO second_look_receipt_mail_outbox (record_id, recipient_key, status) VALUES ($1, $2, 'pending') ON CONFLICT (record_id, recipient_key) DO NOTHING RETURNING status", [recordId, recipientKey]);
      if (inserted.length) return { kind: "reserved" };
      const rows = await sql.query("SELECT status, message_id FROM second_look_receipt_mail_outbox WHERE record_id = $1 AND recipient_key = $2 LIMIT 1", [recordId, recipientKey]);
      const row = rows[0] as { status?: string; message_id?: string | null } | undefined;
      if (!row || !["pending", "accepted", "unknown"].includes(row.status ?? "")) throw new Error("Outbox state unavailable.");
      return { kind: "existing", state: row.status as OutboxState, ...(typeof row.message_id === "string" ? { messageId: row.message_id } : {}) };
    },
    async accepted(recordId, recipientKey, messageId, threadId) {
      await ensureTable();
      await sql.query("UPDATE second_look_receipt_mail_outbox SET status = 'accepted', message_id = $3, thread_id = $4, updated_at = now() WHERE record_id = $1 AND recipient_key = $2", [recordId, recipientKey, messageId, threadId ?? null]);
    },
    async unknown(recordId, recipientKey) {
      await ensureTable();
      await sql.query("UPDATE second_look_receipt_mail_outbox SET status = 'unknown', updated_at = now() WHERE record_id = $1 AND recipient_key = $2 AND status = 'pending'", [recordId, recipientKey]);
    },
  };
}

export function matchesSignedDecisionRecord(record: DecisionRecord, id: string, claims: AnalysisClaims): boolean {
  const selected = record.selectedDecision.plan;
  const quote = record.verifiedQuote;
  return record.id === id && record.analysisId === claims.analysisId &&
    record.planId === claims.selectedPlan.id && selected.id === claims.selectedPlan.id &&
    selected.payableToday === claims.quoteAmount && claims.selectedPlan.payableToday === claims.quoteAmount &&
    record.amount === claims.quoteAmount && quote.amount === claims.quoteAmount &&
    quote.planId === claims.selectedPlan.id && quote.url === claims.quoteUrl &&
    quote.cadence === claims.selectedPlan.cadence && quote.commitment === claims.selectedPlan.commitment &&
    record.selectedDecision.eligible === true &&
    record.requirements.maxToday === claims.requirements.maxToday &&
    record.requirements.billing === claims.requirements.billing &&
    record.requirements.annualOk === claims.requirements.annualOk;
}

export function buildDecisionReceipt(record: DecisionRecord): { subject: string; text: string } {
  const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  const plan = record.selectedDecision.plan;
  return {
    subject: "Your Second Look demo decision record",
    text: [
      "SECOND LOOK DEMO — DECISION RECORD",
      "",
      "This is a synthetic receipt of the decision saved in Second Look. It is not a payment receipt, invoice, or proof of a subscription. No payment was made and no subscription was created.",
      "",
      "Saved record: " + record.id,
      "Reviewed plan: " + plan.name + " (" + plan.cadence + " billing; " + (plan.commitment ? "annual commitment" : "no annual commitment") + ")",
      "Amount shown in the reviewed quote: " + money(record.amount) + " due today in the demo storefront; not charged.",
      "Decision: " + record.selectedDecision.reason,
      "",
      "Your saved preferences",
      "Maximum due today: " + money(record.requirements.maxToday),
      "Billing preference: " + record.requirements.billing,
      "Annual commitment acceptable: " + (record.requirements.annualOk ? "Yes" : "No"),
      "",
      "Second Look records a reviewed decision only. It does not submit payment or start a subscription.",
    ].join("\n"),
  };
}

function unavailableStoreError() {
  return !process.env.DATABASE_URL && (Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production" || process.env.REQUIRE_NEON === "true");
}

export async function sendDecisionReceipt(
  record: DecisionRecord,
  recipient: string,
  options: { apiKey?: string; inboxId?: string; fetcher?: typeof fetch; outbox?: ReceiptOutbox; signal?: AbortSignal } = {},
): Promise<ReceiptEmailOutcome> {
  const apiKey = options.apiKey ?? process.env.AGENTMAIL_API_KEY;
  const inboxId = options.inboxId ?? process.env.AGENTMAIL_INBOX_ID;
  if (!apiKey || !inboxId) return { status: "not_sent", error: "AgentMail is not configured. No email was sent." };

  const databaseUrl = process.env.DATABASE_URL;
  if (!options.outbox && !databaseUrl && unavailableStoreError()) {
    return { status: "not_sent", error: "Durable email deduplication requires DATABASE_URL in deployed environments. No email was sent." };
  }
  const outbox = options.outbox ?? (databaseUrl ? neonOutbox(databaseUrl) : memoryOutbox);
  const normalizedRecipient = recipient.trim().toLowerCase();
  const recipientKey = createHash("sha256").update(normalizedRecipient).digest("hex");
  let reservation: Reservation;
  try { reservation = await outbox.reserve(record.id, recipientKey); }
  catch { return { status: "not_sent", error: "The email safety record could not be reserved. No email was sent." }; }

  if (reservation.kind === "existing") {
    if (reservation.state === "accepted") {
      if (reservation.messageId) return { status: "accepted", messageId: reservation.messageId, duplicate: true };
      return { status: "unknown", error: "The saved acceptance record is incomplete. Do not retry automatically; check the inbox or contact support.", duplicate: true };
    }
    if (reservation.state === "unknown") return { status: "unknown", error: "The earlier send outcome is unknown. Do not retry automatically; check the inbox or contact support.", duplicate: true };
    return { status: "pending", error: "An email send is already reserved for this record and recipient. Wait for its outcome; do not retry yet.", duplicate: true };
  }

  const email = buildDecisionReceipt(record);
  const endpoint = "https://api.agentmail.to/v0/inboxes/" + encodeURIComponent(inboxId) + "/messages/send";
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ to: normalizedRecipient, subject: email.subject, text: email.text }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    let providerResult: unknown;
    try { providerResult = await response.json(); } catch { providerResult = undefined; }
    const messageId = typeof providerResult === "object" && providerResult !== null && "message_id" in providerResult && typeof providerResult.message_id === "string" && providerResult.message_id.trim()
      ? providerResult.message_id.trim() : undefined;
    const threadId = typeof providerResult === "object" && providerResult !== null && "thread_id" in providerResult && typeof providerResult.thread_id === "string" ? providerResult.thread_id : undefined;
    if (!response.ok || !messageId) {
      try { await outbox.unknown(record.id, recipientKey); } catch { /* The reserved row still prevents a resend. */ }
      return { status: "unknown", error: "AgentMail did not confirm acceptance. The outcome may be ambiguous; automatic retry is disabled.", duplicate: false };
    }
    try { await outbox.accepted(record.id, recipientKey, messageId, threadId); } catch { /* Provider acceptance is still confirmed by its actual message ID. */ }
    return { status: "accepted", messageId, duplicate: false };
  } catch {
    try { await outbox.unknown(record.id, recipientKey); } catch { /* Pending reservation remains a resend lock. */ }
    return { status: "unknown", error: "The send timed out or lost its response. The email may have been accepted; automatic retry is disabled.", duplicate: false };
  }
}
