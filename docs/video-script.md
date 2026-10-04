# Demo video and submission kit

Submissions close at 4:30 PM. Judges have 15 minutes (4:30–4:45) to choose the Top 6, so the video has to land in its first 10 seconds and still work on mute.

## The story: why this wins

**Act 1, the pain everyone has felt.** “Only $29/month” turns out to be $348 due today. Checkouts are engineered to get a yes: an annual prepay behind a monthly price, a total that shifts at the last step, cancellation terms nobody can find.

**Act 2, an agent that works for you, not the checkout.** Second Look holds the offer to *your* rules. It shows evidence for every claim, decides eligibility in deterministic code rather than model guesses, and acts only on the exact quote you approve.

**Act 3, the climax.** After you approve, the price changes to $45. The agent refuses to let yesterday's yes pay today's price, and blocks the save. That's the moment judges remember.

**The thesis (say it out loud in the room):** *Personal agents are about to spend our money. The ones we trust will show their evidence, follow our rules in code, and never act on a stale yes.* Second Look is that trust layer, demonstrated on the most universal personal-money problem there is. Every agent that buys, books or subscribes needs the same loop: evidence → your rules → exact approval → recheck → receipt.

Why it beats a typical entry, by what this panel rewards:

- **Personal agent for personal life (the brief):** everyone in the room has been burned by a subscription. No explanation needed.
- **Every sponsor has a job, not a logo slot:** the browser is the agent's eyes, Exa its research, Mastra + Neon AI Gateway its reasoning, Neon Postgres its memory, Assistant UI its voice, AgentMail its paper trail.
- **Depth that holds up in Q&A:** signed, expiring approval tokens; recheck at save time; idempotent records read back before success is shown; unresolved stays unresolved.
- **The agent can say no.** Most demos show an agent saying yes faster. This one shows judgment, which is the hard and valuable part.

**Tagline:** A clearer yes. A better no.

**Opening line for the live pitch:** “Raise your hand if a ‘$29 a month’ plan has ever charged you for a whole year.” Wait for the hands. “Personal agents are about to make those clicks for us. This one knows when to say no.”

## Make the video

```sh
npm run build && npm start            # production server on :3000 (snappy, no dev compile pauses)
BASE_URL=http://localhost:3000 npm run video
# optional: DEMO_EMAIL_TO=you@example.com npm run video   (also sends the AgentMail receipt on camera)
```

Output in `artifacts/video/`: `second-look-demo.mp4` (1080p H.264), `second-look-demo.srt` (captions), `voiceover.md` (timed narration script), `thumbnail.jpg` (verdict frame).

The recorder drives the real app. Nothing is mocked. Long waits are sped up and labeled "Fast-forward" on screen. If an optional scene fails (evidence chat, Exa, unresolved terms), it is cut, and its sponsor chip is left off the closing card. The video never claims a capability that wasn't exercised.

## Storyboard (~90 s)

| # | Beat | Why it scores |
|---|------|---------------|
| 0 | “Only $29/month.” gets crossed out: **Due today: $348.** | A hook everyone has felt, in 5 seconds |
| 1–2 | My rules ($40 today, monthly, no lock-in) and the offer | Personal agent for personal life (the brief) |
| 3 | One click: a real browser captures the pricing, billing and cancellation pages | Browser agent doing real work (Kernel/Mastra judges) |
| 4–5 | “True, but $348 today” fails; the monthly plan passes at $35 | Evidence is separate from eligibility; deterministic checks |
| 6 | Source passage, URL and capture time | Trust: no hallucinated facts |
| 7–8 | I approve the exact quote: signed, rechecked, saved to Neon, read back | Human-in-the-loop, Neon |
| 9–10 | **The price changes to $45 after review: blocked** | The wow moment: the agent refuses to act on a stale approval |
| 11 | Missing terms stay “not established” | Honest uncertainty |
| 12 | Ask why: the Mastra agent answers in Assistant UI, tool calls visible | Mastra + Assistant UI (Best UI quest) |
| 13 | Real public offer, researched with Exa (read-only) | Works beyond the fixture |
| end | “A clearer yes. A better no.” plus the stack actually used | Memorable close |

## Your voice (optional, +10 minutes, worth it)

A founder's voice beats silence. Play the MP4, read `voiceover.md` into QuickTime (File → New Audio Recording), save it as `voiceover.m4a`, then run:

```sh
ffmpeg -i artifacts/video/second-look-demo.mp4 -i voiceover.m4a -c:v copy -c:a aac -b:a 192k -shortest artifacts/video/second-look-demo-vo.mp4
```

Upload as an **unlisted YouTube** video (or Loom) and put the link in the portal. Upload by 4:15.

## Portal copy

**Title:** Second Look: a personal agent that reads the fine print before you pay

**One-liner:** “$29/month” can mean $348 today. Second Look checks a subscription offer against your rules, picks the plan that actually fits, and acts only on the exact quote you approve.

**Description:** Second Look is a personal subscription agent. You set your rules (how much you can pay today, monthly vs. annual, whether a year-long commitment is okay). The agent opens the offer in a real browser and captures the pricing, billing and cancellation passages with URLs and timestamps. It evaluates your rules in deterministic code, not model judgment, selects an eligible plan, and re-reads the resulting quote. You approve the exact amount. Approval is a signed, expiring receipt that is rechecked at save time. If the price changes, the old approval cannot authorize it. Missing terms stay unresolved instead of being invented. Decisions are stored in Neon Postgres and read back before the UI reports success. Real public offers can be researched with Exa (read-only, no checkout). Synthetic storefront; no real payments.

**Stack (only list what you show working):** Mastra agent + Neon AI Gateway (extraction, evidence agent with tools) · Neon Postgres (idempotent decision records) · Assistant UI (streaming evidence chat with tool-call cards) · Exa (domain-scoped source research) · AgentMail (approval-gated receipt email) · browser automation via Playwright, with a Kernel adapter (Kernel needs a public deployment URL).

## If you make the Top 6 (2 min live + 1 min Q&A)

Run the live flow from `docs/demo-script.md`. Keep the MP4 open in a second tab; if the Wi-Fi or a provider fails, say “here's the recorded run” and play it. Never present a recording as live.

Likely questions:

- **Kernel (Catherine Jue):** “Does it run on Kernel?” The adapter exists (`BROWSER_PROVIDER=kernel`). Kernel can't reach localhost, so a public URL is needed. Say what actually ran.
- **Mastra (Abhi Aiyer):** “Where's the agent?” Structured extraction plus an evidence agent with `checkEligibility`, `extractPlans` and `searchAlternatives` tools bound to the signed analysis. Model output never authorizes a quote.
- **Exa (Jeff Wang):** Four parallel requests per run: three domain-filtered searches (pricing, renewal, cancellation) plus contents for the exact URL.
- **Assistant UI (Simon Farshid):** Streaming evidence chat with tool-call cards and an inline “Review exact quote” action.
- **AgentMail (Haakam Aujla):** The receipt email requires a separate explicit approval. Ambiguous sends are never auto-retried.
- **a16z (James da Costa):** Dark patterns in subscriptions are a consumer-protection problem. The agent works for the user, not the merchant: a fiduciary for your recurring spend.
