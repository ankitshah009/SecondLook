import { z } from "zod";

export const requirementsSchema = z.object({
  maxToday: z.number().finite().nonnegative().max(10_000),
  billing: z.enum(["monthly", "annual", "either"]),
  annualOk: z.boolean(),
});
export const analyzeRequestSchema = z.object({
  url: z.string().url().max(2048),
  pastedText: z.string().max(20_000).optional().default(""),
  requirements: requirementsSchema,
  initialPlanId: z.enum(["annual", "monthly"]).default("annual"),
});
export const approvalRequestSchema = z.object({
  analysisToken: z.string().min(20).max(128_000),
  planId: z.enum(["annual", "monthly"]),
  expectedAmount: z.number().finite().nonnegative(),
});
export const planSchema = z.object({
  id: z.enum(["annual", "monthly"]),
  name: z.string(),
  cadence: z.enum(["monthly", "annual"]),
  payableToday: z.number().finite().nonnegative(),
  monthlyEquivalent: z.number().finite().nonnegative(),
  commitment: z.boolean(),
  url: z.string().url(),
  evidenceIds: z.array(z.string()).default([]),
});
export const findingSchema = z.object({
  id: z.string(), field: z.string(), value: z.string(), passage: z.string(),
  url: z.string().url(), capturedAt: z.string(), subject: z.string(),
  status: z.enum(["established", "unresolved"]),
  sourceKind: z.enum(["browser", "pasted", "screenshot"]).default("browser"),
});
export type Requirements = z.infer<typeof requirementsSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type RuleCheck = { label: string; pass: boolean; detail: string };
export type Decision = { eligible: boolean; reason: string; plan: Plan; checks: RuleCheck[] };
export type BrowserMode = "kernel" | "local-browser";
export type VerifiedQuote = {
  planId: Plan["id"]; amount: number; cadence: Plan["cadence"]; commitment: boolean;
  capturedAt: string; url: string; passage: string; replay: boolean; provider: BrowserMode;
};
export type ProgressItem = { id: string; label: string; state: "active" | "complete" | "unresolved" };
export type BrowserCapture = { url: string; image: string; capturedAt: string; provider: BrowserMode };
export type Analysis = {
  id: string; findings: Finding[]; initial: Decision; alternative: Plan | null;
  alternativeDecision: Decision | null; verifiedQuote: VerifiedQuote | null;
  analysisToken: string | null; mode: BrowserMode; progress: ProgressItem[];
  browserCapture: BrowserCapture; extraction: "deterministic-fixture" | "mastra-neon";
};
export type DecisionRecord = {
  id: string; analysisId: string; planId: Plan["id"]; amount: number; createdAt: string;
  requirements: Requirements; originalDecision: Decision; selectedDecision: Decision;
  findings: Finding[]; verifiedQuote: VerifiedQuote;
};

// The storefront renders these fixtures. Eligibility consumes browser-observed plans instead.
export const plans: Plan[] = [
  { id: "annual", name: "Annual", cadence: "annual", payableToday: 348, monthlyEquivalent: 29, commitment: true, url: "/demo-storefront/pricing", evidenceIds: [] },
  { id: "monthly", name: "Monthly", cadence: "monthly", payableToday: 35, monthlyEquivalent: 35, commitment: false, url: "/demo-storefront/pricing", evidenceIds: [] },
];
export function moneyCents(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("The payment amount is invalid.");
  return Math.round(amount * 100);
}
export function evaluate(requirements: Requirements, plan: Plan): Decision {
  const checks: RuleCheck[] = [
    { label: "Due today", pass: moneyCents(plan.payableToday) <= moneyCents(requirements.maxToday), detail: "$" + plan.payableToday + " due today; your limit is $" + requirements.maxToday },
    { label: "Billing cadence", pass: requirements.billing === "either" || plan.cadence === requirements.billing, detail: plan.cadence + " billing; you prefer " + requirements.billing },
    { label: "Commitment", pass: requirements.annualOk || !plan.commitment, detail: plan.commitment ? "Requires an annual commitment" : "No annual commitment" },
  ];
  const eligible = checks.every(check => check.pass);
  return { eligible, reason: eligible ? plan.name + " fits your requirements." : plan.name + " does not fit all of your requirements.", plan, checks };
}
export function findAlternative(requirements: Requirements, candidates: Plan[]): Plan | undefined {
  return candidates.filter(plan => evaluate(requirements, plan).eligible)
    .sort((a, b) => moneyCents(a.payableToday) - moneyCents(b.payableToday))[0];
}
export function evaluateQuote(requirements: Requirements, plan: Plan, quote: VerifiedQuote) {
  const verifiedIdentity = quote.planId === plan.id && quote.cadence === plan.cadence && quote.commitment === plan.commitment;
  const currentPlan = { ...plan, payableToday: quote.amount };
  return { verifiedIdentity, decision: evaluate(requirements, currentPlan) };
}
