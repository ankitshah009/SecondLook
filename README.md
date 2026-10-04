# Second Look

A personal subscription agent with source receipts, deterministic guardrails, and approval of an exact verified demo quote. **Synthetic storefront; no real payments.**

## Run

Requires Node.js 22.13+ and installed Chrome on macOS (or Chromium via `PLAYWRIGHT_EXECUTABLE_PATH`).

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Default requirements are $40 today, monthly billing, no annual commitment. The annual plan is $348 upfront ($29 monthly equivalent); the monthly plan is $35 monthly. Amounts are displayed totals.

## Workflow

The API opens actual storefront pages with Playwright (local Chrome or Kernel), captures plan-specific pricing, billing and cancellation passages, evaluates preferences in TypeScript, clicks the eligible plan, and reads its resulting quote. Progress streams as operations complete.

Approval validates a signed, expiring analysis receipt and opens the quote again. A changed total requires reevaluation and fresh approval. Records are idempotent per analysis and exact quote; the UI reads the saved record back before reporting success.

The workspace includes source inspection, browser captures, individual rule checks, an exact-quote review dialog, and a downloadable decision record. Incomplete cancellation terms remain unresolved, not fabricated.

The main input also accepts public merchant URLs for Exa source research. Complete literal terms on the exact submitted page can receive conservative deterministic preference checks; missing or ambiguous terms remain unresolved. This path never creates an approval token or merchant checkout. Screenshot intake accepts PNG, JPEG or WebP up to 2 MB and transcribes visible offer fields through Mastra + Neon Gateway; screenshot observations are not browser-verified.

## Connect the hackathon stack

Copy `.env.example` to `.env.local` and supply credentials through your normal secret-management workflow:

- Neon persistence: `DATABASE_URL`. The decision-record table is created on first save.
- Neon AI Gateway: `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN`, optionally `NEON_AI_MODEL` (default `gpt-5-mini`).
- Kernel: `KERNEL_API_KEY`, `BROWSER_PROVIDER=kernel`, and a publicly reachable deployment `APP_URL`. Kernel cannot inspect localhost.
- Exa research: `EXA_API_KEY` enables read-only search of an offer's domain and retrieval of the submitted URL's contents.
- AgentMail receipts: `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`. After a saved decision is read back, enter a recipient and explicitly approve sending from the receipt drawer. Provider acceptance is not delivery confirmation; uncertain sends are not automatically retried. Neon stores durable send reservations when configured; local reservations are temporary.
- Production: stable random `SECOND_LOOK_SIGNING_SECRET` and `REQUIRE_NEON=true`.

Mastra performs structured extraction through Neon Gateway using its documented prompt-JSON mode, with strict local schema validation (native schema-format requests were rejected by the configured Gateway). Extracted financial fields must match captured passages. Assistant UI provides a streaming, evidence-grounded explanation drawer through the same agent. Without Gateway credentials, local fixture extraction remains deterministic and explanation chat is disabled. Without Neon credentials, local records are temporary process memory; deployed persistence refuses this fallback.

Configuration indicators report credentials present, **not provider health**. Credentialed Neon, Gateway and Kernel runtime verification requires working service credentials.

## Verify

```sh
npm run typecheck
npm test
npm run test:e2e  # keep the server running; BASE_URL defaults to localhost:3000
npm run test:ui   # actual review/approval clicks; screenshots saved in artifacts/
npm run test:research # live Exa UI; requires EXA_API_KEY on the running server
npm run test:stack # strict Kernel + Mastra/Gateway + Neon runtime gate; no local fallback
REQUIRE_GATEWAY=true REQUIRE_NEON=true npm run test:e2e # actual Gateway + Neon with local browser; does not certify Kernel
node --import tsx scripts/persistence-smoke.ts # isolate actual Neon save/read/idempotency; explicitly excludes Gateway and Kernel
npm run build
npm start
```

Try annual prepayment, incomplete terms, and changed-quote scenarios. Changing preferences invalidates the old review. A changed $45 monthly quote fails the default $40 limit.

## Boundaries

Automated plan selection and quote creation support only the synthetic Streamly storefront. No arbitrary merchant checkout, real subscriptions, payment handling, or recorded replay is presented as live automation. Exa research accepts a public offer URL and optional pasted text, returns domain-scoped source passages, and cannot determine plan eligibility or approve or enable checkout. Pasted text remains user-provided and unverified.

Each research run intentionally makes four Exa requests in parallel: three domain-filtered searches for pricing, billing/renewal, and cancellation/refunds, plus one contents request for the submitted URL. The separate topic searches keep evidence focused on the merchant's own domain while the contents request checks the known offer page. If `EXA_API_KEY` is absent, research returns an unavailable response rather than fixture results.

Current provider adapters must not be confused with a fully credentialed deployment. AgentMail inbox-access checks have not succeeded in this environment; no live receipt email has been sent or verified.

Use `npm run build && npm start` for the stage demo. Local browser inspections use fresh isolated contexts in a reusable process; idle processes close after 30 seconds, outside the response path. No LLM calls are made when Gateway credentials are absent. Exa research intentionally makes four provider requests per run; Gateway extraction is one generation per inspection or screenshot, with separate calls for evidence questions. Actual provider charges follow your credited account rates.

One Next.js App Router application, TypeScript, pinned package versions, AI SDK 7, Assistant UI, Mastra, Neon and Kernel, following the [official Assistant UI + Mastra full-stack guide](https://www.assistant-ui.com/docs/integrations/frameworks/mastra/full-stack). Browser and model network operations have timeouts; model output never authorizes a quote.
