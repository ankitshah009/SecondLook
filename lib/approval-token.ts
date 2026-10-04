import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { findingSchema, planSchema, requirementsSchema } from "@/lib/second-look";

const claimsSchema = z.object({
  analysisId: z.string().uuid(),
  requirements: requirementsSchema,
  sourceUrl: z.string().url(),
  findings: z.array(findingSchema),
  selectedPlan: planSchema,
  originalPlan: planSchema,
  quoteUrl: z.string().url(),
  quoteAmount: z.number().finite().nonnegative(),
  issuedAt: z.number().int(), expiresAt: z.number().int(),
});
export type AnalysisClaims = z.infer<typeof claimsSchema>;

const globalKey = globalThis as typeof globalThis & { secondLookSigningKey?: string };
function signingKey() {
  if (process.env.SECOND_LOOK_SIGNING_SECRET) return process.env.SECOND_LOOK_SIGNING_SECRET;
  if (process.env.VERCEL) throw new Error("Set SECOND_LOOK_SIGNING_SECRET before deploying approvals.");
  globalKey.secondLookSigningKey ??= randomBytes(32).toString("hex");
  return globalKey.secondLookSigningKey;
}
function signature(payload: string) {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}
export function issueAnalysisToken(input: Omit<AnalysisClaims, "issuedAt" | "expiresAt">) {
  const now = Date.now();
  const claims = claimsSchema.parse({ ...input, issuedAt: now, expiresAt: now + 30 * 60 * 1000 });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + signature(payload);
}
export function verifyAnalysisToken(token: string): AnalysisClaims {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("This review is invalid. Check the offer again.");
  const expected = Buffer.from(signature(payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("This review could not be verified. Check the offer again.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("This review is malformed. Check the offer again."); }
  const claims = claimsSchema.parse(parsed);
  if (claims.expiresAt < Date.now()) throw new Error("This review expired. Check the offer again before approving.");
  return claims;
}
