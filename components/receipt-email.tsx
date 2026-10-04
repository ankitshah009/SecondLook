"use client";
import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

export default function ReceiptEmail({ id, analysisToken, enabled, target }: {
  id: string; analysisToken: string; enabled: boolean; target: HTMLDialogElement | null;
}) {
  const [to, setTo] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "accepted" | "unknown">("idle");
  const [message, setMessage] = useState("");
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!enabled || !confirmed || state !== "idle") return;
    setState("sending"); setMessage("");
    try {
      const response = await fetch("/api/receipt-email", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, analysisToken, to: to.trim() }), signal: AbortSignal.timeout(20_000) });
      const data = await response.json();
      if (response.ok && data.status === "accepted" && typeof data.messageId === "string") {
        setState("accepted"); setMessage("AgentMail accepted this receipt email. Delivery is not yet verified.");
      } else if (data.status === "unknown" || data.status === "pending") {
        setState("unknown"); setMessage("Sending is uncertain or still in progress. Check AgentMail before trying another send.");
      } else { setState("idle"); setMessage(typeof data.error === "string" ? data.error : "Receipt email was not confirmed. Check the service setup."); }
    } catch { setState("unknown"); setMessage("The response could not be confirmed. The email may have been sent; check AgentMail before retrying."); }
  }
  if (!target) return null;
  return createPortal(<section className="receipt-email" aria-label="Email saved receipt">
    <h3>Email this saved receipt</h3>
    {!enabled ? <p>Connect AgentMail to send this receipt. No email has been requested.</p> : <form onSubmit={send}>
      <label>Receipt recipient<input type="email" required autoComplete="email" value={to} disabled={state !== "idle"} onChange={e => { setTo(e.target.value); setConfirmed(false); setMessage(""); }} /></label>
      <label className="receipt-email-consent"><input type="checkbox" checked={confirmed} disabled={state !== "idle"} onChange={e => setConfirmed(e.target.checked)} />I approve emailing this synthetic decision receipt to this address.</label>
      <button type="submit" disabled={!confirmed || !to.trim() || state !== "idle"}>{state === "sending" ? "Requesting receipt email…" : state === "accepted" ? "Accepted by AgentMail" : state === "unknown" ? "Check sending status" : "Send receipt email"}</button>
      <small>Includes the saved plan, amount, and preferences. No subscription or payment is created.</small>
    </form>}
    {message && <p role="status">{message}</p>}
  </section>, target);
}
