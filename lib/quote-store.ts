import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { DecisionRecord } from "@/lib/second-look";

const cache = globalThis as typeof globalThis & { secondLookRecords?: Map<string, DecisionRecord> };
cache.secondLookRecords ??= new Map();
const memoryStore = cache.secondLookRecords;
let tableSetup: Promise<void> | undefined;
export function idempotencyKey(record: Pick<DecisionRecord, "analysisId" | "planId" | "amount" | "verifiedQuote">) {
  return createHash("sha256").update(JSON.stringify({ analysisId: record.analysisId, planId: record.planId,
    amount: record.amount, source: record.verifiedQuote.url })).digest("hex");
}
export async function saveDecisionRecord(record: DecisionRecord): Promise<{ record: DecisionRecord; duplicate: boolean; persistence: "neon" | "memory" }> {
  const key = idempotencyKey(record);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (process.env.VERCEL || process.env.REQUIRE_NEON === "true") throw new Error("Configure DATABASE_URL to save this decision in Neon.");
    const existing = memoryStore.get(key);
    if (existing) return { record: existing, duplicate: true, persistence: "memory" };
    memoryStore.set(key, record);
    return { record, duplicate: false, persistence: "memory" };
  }
  const sql = neon(databaseUrl, { fetchOptions: { signal: AbortSignal.timeout(10_000) } });
  tableSetup ??= sql.query("CREATE TABLE IF NOT EXISTS second_look_decisions (id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())")
    .then(() => undefined).catch(error => { tableSetup = undefined; throw error; });
  await tableSetup;
  const inserted = await sql.query("INSERT INTO second_look_decisions (id, idempotency_key, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (idempotency_key) DO NOTHING RETURNING record",
    [record.id, key, JSON.stringify(record)]);
  if (inserted.length) return { record: inserted[0].record as DecisionRecord, duplicate: false, persistence: "neon" };
  const rows = await sql.query("SELECT record FROM second_look_decisions WHERE idempotency_key = $1 LIMIT 1", [key]);
  if (!rows.length) throw new Error("The saved record could not be confirmed.");
  return { record: rows[0].record as DecisionRecord, duplicate: true, persistence: "neon" };
}
export async function readDecisionRecord(id: string): Promise<DecisionRecord | null> {
  if (!process.env.DATABASE_URL) return [...memoryStore.values()].find(record => record.id === id) ?? null;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(10_000) } });
  const rows = await sql.query("SELECT record FROM second_look_decisions WHERE id = $1 LIMIT 1", [id]);
  return rows[0]?.record as DecisionRecord ?? null;
}
