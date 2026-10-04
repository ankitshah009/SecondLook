"use client";
import { useMemo } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

function UserMessage() { return <MessagePrimitive.Root className="aui-message user-message"><span className="chat-speaker">You</span><MessagePrimitive.Parts /></MessagePrimitive.Root>; }
const toolLabels: Record<string, string> = {
  checkEligibility: "Checking your preferences",
  extractPlans: "Reviewing signed plan evidence",
  searchAlternatives: "Comparing same-storefront plans",
};
type DecisionView = {
  eligible: boolean; reason: string;
  plan: { id: string; name: string; payableToday: number; monthlyEquivalent: number; cadence: string; commitment: boolean };
  checks: { label: string; pass: boolean; detail: string }[];
};
type PlanEvidenceView = { plan: DecisionView["plan"]; evidence: { field: string; passage: string; url: string }[] };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function PlanFacts({ plan }: { plan: PlanEvidenceView["plan"] }) {
  return <p><strong>{plan.name} plan.</strong> ${plan.payableToday} due today; ${plan.monthlyEquivalent} monthly equivalent; {plan.cadence} billing; {plan.commitment ? "annual commitment" : "no annual commitment"}.</p>;
}
function DecisionDetails({ decision }: { decision: DecisionView }) {
  return <section>
    <p><strong>{decision.plan.name}: {decision.eligible ? "fits" : "does not fit"} your preferences.</strong> ${decision.plan.payableToday} due today; {decision.plan.cadence} billing; {decision.plan.commitment ? "annual commitment" : "no annual commitment"}.</p>
    <ul>{decision.checks.map(check => <li key={check.label}><strong>{check.pass ? "Pass" : "Does not pass"} — {check.label}:</strong> {check.detail}</li>)}</ul>
  </section>;
}
function ToolResult({ result }: { result: unknown }) {
  if (!isRecord(result)) return <p>Signed evidence check completed.</p>;
  if (typeof result.eligible === "boolean" && isRecord(result.plan) && Array.isArray(result.checks)) {
    return <DecisionDetails decision={result as unknown as DecisionView} />;
  }
  if (Array.isArray(result.plans)) return <ul>{(result.plans as PlanEvidenceView[]).map(({ plan, evidence }) => <li key={plan.id}>
    <PlanFacts plan={plan} />
    {evidence.length ? <details><summary>Read captured passages ({evidence.length})</summary>{evidence.map((item, index) => <blockquote key={index}><strong>{item.field}</strong><p>{item.passage}</p><a href={item.url} target="_blank" rel="noreferrer">Open captured source</a></blockquote>)}</details> : <p>No established passage was linked to this plan.</p>}
  </li>)}</ul>;
  if (Array.isArray(result.candidates)) return <ul>{(result.candidates as DecisionView[]).map(item => <li key={item.plan.id}><DecisionDetails decision={item} /></li>)}</ul>;
  return <p>Signed evidence check completed.</p>;
}
function ToolActivity({ toolName, args, result, isError, isPreliminary }: ToolCallMessagePartProps) {
  const label = toolLabels[toolName] ?? "Reviewing evidence";
  const pending = result === undefined || isPreliminary;
  return <details className="chat-tool-activity" open>
    <summary aria-live="polite"><span>{label}</span><span>{isError ? "Needs attention" : pending ? "In progress" : "Complete"}</span></summary>
    {args && Object.keys(args as Record<string, unknown>).length > 0 ? <p className="chat-tool-args">Requested plan: {String((args as Record<string, unknown>).planId ?? "reviewed plans")}</p> : null}
    {isError ? <p role="alert">This evidence check did not complete. Ask again or check the reviewed offer.</p> : pending ? <p role="status">Using the signed review. No quote will be created or approved.</p> : <ToolResult result={result} />}
  </details>;
}
const toolComponents = { tools: { by_name: { checkEligibility: ToolActivity, extractPlans: ToolActivity, searchAlternatives: ToolActivity }, Fallback: ToolActivity } };
function AssistantMessage() {
  return <MessagePrimitive.Root className="aui-message assistant-message"><span className="chat-speaker">Second Look</span><MessagePrimitive.Parts components={toolComponents} /><MessagePrimitive.Error><p className="chat-error" role="alert">The evidence assistant could not respond. Check the Neon Gateway configuration or try again.</p></MessagePrimitive.Error></MessagePrimitive.Root>;
}
export default function EvidenceChat({ analysisToken, onReviewQuote, canReviewQuote }: { analysisToken: string; onReviewQuote?: () => void; canReviewQuote?: boolean }) {
  const transport = useMemo(() => new AssistantChatTransport({ api: "/api/chat", body: { analysisToken } }), [analysisToken]);
  const runtime = useChatRuntime({ transport });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="chat-thread">
    <ThreadPrimitive.Viewport className="chat-viewport">
      <ThreadPrimitive.Empty><div className="chat-empty"><p>Ask about the source passages or why a plan fits. Answers are grounded in this reviewed evidence.</p><ThreadPrimitive.Suggestion prompt="Why is the annual price not a false claim?" send>Why isn’t the annual price false? ↗</ThreadPrimitive.Suggestion><ThreadPrimitive.Suggestion prompt="Which facts are established and which remain unresolved?" send>What remains unresolved? ↗</ThreadPrimitive.Suggestion></div></ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
    </ThreadPrimitive.Viewport>
    <ComposerPrimitive.Root className="chat-composer"><ComposerPrimitive.Input placeholder="Ask about this evidence…" aria-label="Question about reviewed evidence" /><ThreadPrimitive.If running={false}><ComposerPrimitive.Send aria-label="Send evidence question">↗</ComposerPrimitive.Send></ThreadPrimitive.If><ThreadPrimitive.If running><ComposerPrimitive.Cancel aria-label="Stop assistant response">■</ComposerPrimitive.Cancel></ThreadPrimitive.If></ComposerPrimitive.Root>
    {canReviewQuote && onReviewQuote ? <button className="review-quote-button" type="button" onClick={onReviewQuote}>Review exact quote <span aria-hidden="true">↗</span></button> : null}
    <small className="chat-footnote">Evidence tools require the configured Neon AI Gateway.<br />They use signed reviewed evidence only and do not approve or change your quote.</small>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
