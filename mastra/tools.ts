import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AnalysisClaims } from "@/lib/approval-token";
import { evaluate, type Plan } from "@/lib/second-look";

export const eligibilityInputSchema = z.object({ planId: z.enum(["annual", "monthly"]) }).strict();
const evidenceSchema = z.array(z.object({ id: z.string(), field: z.string(), value: z.string(), passage: z.string(), url: z.string().url() }));
const decisionSchema = z.object({
  eligible: z.boolean(), reason: z.string(),
  plan: z.object({ id: z.enum(["annual", "monthly"]), name: z.string(), cadence: z.enum(["monthly", "annual"]), payableToday: z.number(), monthlyEquivalent: z.number(), commitment: z.boolean(), url: z.string().url(), evidenceIds: z.array(z.string()) }),
  checks: z.array(z.object({ label: z.string(), pass: z.boolean(), detail: z.string() })),
});

function trustedPlans(claims: AnalysisClaims): Plan[] {
  let sourceOrigin: string;
  try { sourceOrigin = new URL(claims.sourceUrl).origin; } catch { return []; }
  const unique = new Map<string, Plan>();
  for (const plan of [claims.originalPlan, claims.selectedPlan]) {
    try {
      if (new URL(plan.url).origin === sourceOrigin) unique.set(plan.id, plan);
    } catch { /* A malformed or cross-storefront claim cannot be a candidate. */ }
  }
  return [...unique.values()];
}

function evidenceFor(claims: AnalysisClaims, plan: Plan) {
  const ids = new Set(plan.evidenceIds);
  return claims.findings
    .filter(item => item.status === "established" && ids.has(item.id))
    .map(({ id, field, value, passage, url }) => ({ id, field, value, passage, url }));
}

export function createEvidenceTools(claims: AnalysisClaims) {
  const candidates = trustedPlans(claims);
  const getPlan = (planId: "annual" | "monthly") => candidates.find(plan => plan.id === planId);

  const checkEligibility = createTool({
    id: "checkEligibility",
    description: "Deterministically evaluate a signed reviewed plan against the user's signed budget, billing, and commitment preferences.",
    inputSchema: eligibilityInputSchema,
    outputSchema: decisionSchema,
    execute: async ({ planId }) => {
      const plan = getPlan(planId);
      if (!plan) throw new Error("That plan is not present in the signed same-storefront review.");
      return evaluate(claims.requirements, plan);
    },
  });

  const extractPlans = createTool({
    id: "extractPlans",
    description: "Return only plan amounts and terms already present in the signed review, with their established evidence passages.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ sourceUrl: z.string().url(), plans: z.array(z.object({ plan: decisionSchema.shape.plan, evidence: evidenceSchema })) }),
    execute: async () => ({
      sourceUrl: claims.sourceUrl,
      plans: candidates.map(plan => ({ plan, evidence: evidenceFor(claims, plan) })),
    }),
  });

  const searchAlternatives = createTool({
    id: "searchAlternatives",
    description: "Compare the signed reviewed plans from the same storefront against the user's signed preferences. This is not a web search.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ sourceUrl: z.string().url(), candidates: z.array(decisionSchema) }),
    execute: async () => ({
      sourceUrl: claims.sourceUrl,
      candidates: candidates.map(plan => evaluate(claims.requirements, plan)),
    }),
  });

  return { checkEligibility, extractPlans, searchAlternatives };
}
