// Records the hackathon demo video from the real running app.
// Playwright drives the production UI; CDP screencast captures 1080p frames; ffmpeg assembles
// an MP4 where long waits are sped up (and labeled on screen) and failed optional scenes are cut.
// Usage: BASE_URL=http://localhost:3000 npm run video   (optional: DEMO_EMAIL_TO=you@example.com)
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const outDir = path.resolve(process.env.VIDEO_DIR || "artifacts/video");
const framesDir = path.join(outDir, "frames");
const viewport = { width: Number(process.env.VIDEO_WIDTH || 1280), height: Number(process.env.VIDEO_HEIGHT || 720) };
const realOfferUrl = process.env.VIDEO_REAL_OFFER_URL || "https://www.spotify.com/us/premium/";
const emailTo = process.env.DEMO_EMAIL_TO || "";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;

type Health = { browser: string; persistence: string; gateway: boolean; exa: boolean; agentmail: boolean };
type Range = { start: number; end: number; factor: number };
type Cue = { t: number; step: string; title: string; sub: string };
type Frame = { file: string; t: number };

const ranges: Range[] = [];
const cues: Cue[] = [];
const exercised = new Set<string>();
let cursor = { x: viewport.width * 0.62, y: viewport.height * 0.6 };

const call = (page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) =>
  (window as unknown as { __demo: Record<string, (...x: unknown[]) => unknown> }).__demo[n](...a), [name, args] as const);

async function startRecorder(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  let writes = Promise.resolve();
  cdp.on("Page.screencastFrame", event => {
    const file = path.join(framesDir, String(frames.length).padStart(6, "0") + ".jpg");
    frames.push({ file, t: event.metadata.timestamp ?? now() });
    writes = writes.then(() => writeFile(file, Buffer.from(event.data, "base64")))
      .then(() => cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId })).then(() => undefined, () => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080 });
  return { frames, async stop() { const end = now(); await cdp.send("Page.stopScreencast").catch(() => undefined); await writes; return end; } };
}

// Output-time weight: cut ranges vanish, fast-forward ranges are divided by their factor.
function weightAt(t: number) {
  for (const range of ranges) if (t >= range.start && t < range.end) return range.factor === Infinity ? 0 : 1 / range.factor;
  return 1;
}
function integrate(a: number, b: number) {
  if (b <= a) return 0;
  const points = [a, b, ...ranges.flatMap(r => [r.start, r.end]).filter(p => p > a && p < b)].sort((x, y) => x - y);
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) sum += (points[i + 1] - points[i]) * weightAt((points[i] + points[i + 1]) / 2);
  return sum;
}
const stamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

async function assemble(frames: Frame[], end: number) {
  const usable = frames.slice().sort((a, b) => a.t - b.t);
  if (usable.length < 2) throw new Error("The screencast produced no frames; nothing to assemble.");
  const t0 = usable[0].t;
  const lines: string[] = [];
  let total = 0;
  usable.forEach((frame, index) => {
    const duration = integrate(frame.t, index + 1 < usable.length ? usable[index + 1].t : end);
    if (duration < 0.001) return;
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
    total += duration;
  });
  lines.push(lines[lines.length - 2]);
  const list = path.join(outDir, "frames.txt");
  await writeFile(list, lines.join("\n") + "\n");
  const video = path.join(outDir, "second-look-demo.mp4");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "fps=30,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", video], { stdio: "inherit" });

  const shown = cues.map((cue, index) => ({ ...cue, from: integrate(t0, cue.t), to: integrate(t0, index + 1 < cues.length ? cues[index + 1].t : end) }))
    .filter(cue => cue.title && cue.to - cue.from > 0.3);
  await writeFile(path.join(outDir, "second-look-demo.srt"),
    shown.map((cue, i) => `${i + 1}\n${stamp(cue.from)} --> ${stamp(cue.to)}\n${cue.title}${cue.sub ? "\n" + cue.sub : ""}\n`).join("\n"));
  await writeFile(path.join(outDir, "voiceover.md"), "# Voiceover (read over the video; times are output timestamps)\n\n" +
    shown.map(cue => `- **${stamp(cue.from).slice(3, 8)}** ${cue.title}${cue.sub ? " " + cue.sub : ""}`).join("\n") + "\n");
  const verdictCue = cues.find(cue => cue.step === "THE CATCH");
  if (verdictCue) {
    const poster = usable.filter(frame => frame.t <= verdictCue.t + 1.4).pop();
    if (poster) await copyFile(poster.file, path.join(outDir, "thumbnail.jpg"));
  }
  return { video, total, captions: shown.length };
}

async function main() {
  const health = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(10_000) }).then(r => r.json()) as Health;
  console.log("Recording against", baseUrl, JSON.stringify(health));
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.platform === "darwin" ? { channel: "chrome" } : {}) });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1920 / viewport.width });
  await context.addInitScript({ path: path.resolve("scripts/video/overlay.js") });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  const caption = async (step: string, title: string, sub = "") => { cues.push({ t: now(), step, title, sub }); await call(page, "caption", step, title, sub); };
  const reveal = async (target: Locator, block: "center" | "start" | "nearest" = "center") => {
    await target.evaluate((node, b) => node.scrollIntoView({ behavior: "smooth", block: b }), block);
    await sleep(650);
  };
  const spotlight = async (target: Locator | null, pad = 10) => {
    if (!target) return call(page, "spotlight", null);
    const box = await target.boundingBox();
    if (!box) return;
    const top = Math.max(6, box.y - pad), bottom = Math.min(viewport.height - 6, box.y + box.height + pad);
    await call(page, "spotlight", { x: box.x - pad, y: top, w: box.width + pad * 2, h: Math.max(24, bottom - top) });
  };
  const pointAt = async (target: Locator) => {
    await reveal(target);
    const box = await target.boundingBox();
    if (!box) throw new Error("Target is not visible.");
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const ms = Math.round(Math.min(900, Math.max(420, Math.hypot(x - cursor.x, y - cursor.y) * 0.9)));
    await call(page, "cursorTo", x, y, ms);
    await page.mouse.move(x, y, { steps: 6 });
    await sleep(ms + 80);
    cursor = { x, y };
  };
  const clickOn = async (target: Locator) => {
    await pointAt(target);
    await call(page, "ripple", cursor.x, cursor.y);
    await sleep(140);
    await target.click();
    await sleep(250);
  };
  const fastForward = async <T>(work: () => Promise<T>, target = 2.4): Promise<T> => {
    await call(page, "ff", true);
    const start = now();
    try { return await work(); }
    finally {
      const end = now();
      await call(page, "ff", false).catch(() => undefined);
      ranges.push({ start, end, factor: Math.max(1.5, (end - start) / target) });
    }
  };
  const optionalScene = async (name: string, run: () => Promise<boolean>) => {
    const start = now();
    try {
      if (!(await run())) throw new Error("preconditions not met");
      exercised.add(name);
    } catch (error) {
      ranges.unshift({ start, end: now(), factor: Infinity });
      console.warn(`Cut scene "${name}": ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      await page.keyboard.press("Escape").catch(() => undefined);
      await call(page, "spotlight", null).catch(() => undefined);
    }
  };

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.frameLocator("iframe").first().getByRole("heading", { name: "A little more entertainment." }).waitFor({ timeout: 45_000 });
  await page.waitForFunction("Boolean(window.__demo)");
  await sleep(600);
  await call(page, "card", "intro", true);
  await sleep(300);
  const recorder = await startRecorder(page);
  await call(page, "play");
  await sleep(5800);
  await call(page, "hideCard");
  await sleep(700);

  const checkOffer = page.getByRole("button", { name: "Check this offer" });
  const review = page.getByRole("button", { name: "Review exact demo quote" });
  const approve = page.getByRole("button", { name: "Approve this demo quote", exact: true });

  const rules = page.getByRole("region", { name: "Your payment and billing requirements" });
  await reveal(rules);
  await spotlight(rules);
  await caption("THE RULES", "I’m about to subscribe. My rules: at most $40 today, billed monthly, no annual lock-in.", "Second Look holds every offer to these, in code.");
  await sleep(3400);

  const browserPanel = page.locator("#browser-panel");
  await reveal(browserPanel, "center");
  await spotlight(browserPanel);
  await caption("THE OFFER", "The offer: a storefront pitching “$29/month.”", "A labeled synthetic storefront. No real payment is ever made.");
  await sleep(3000);
  await spotlight(null);

  await caption("THE CHECK", "One click: the agent opens the storefront in a real browser…", "…and captures the pricing, billing and cancellation terms as evidence.");
  await clickOn(checkOffer);
  await reveal(browserPanel, "center");
  await fastForward(() => review.waitFor({ timeout: 120_000 }));
  if ((await page.locator(".browser-caption").innerText().catch(() => "")).includes("Kernel")) exercised.add("kernel");
  if ((await page.locator(".stack-status").textContent().catch(() => ""))?.includes("mastra-neon")) exercised.add("mastra");

  const verdict = page.getByRole("region", { name: "Current quote verdict" });
  await verdict.waitFor();
  const verdictBox = await verdict.boundingBox();
  if (!verdictBox || verdictBox.y < 0 || verdictBox.y + verdictBox.height > viewport.height) await reveal(verdict);
  await spotlight(verdict, 6);
  await caption("THE CATCH", "“$29/mo” is true, but it means $348 due today. That breaks my $40 rule.", "A qualified price isn’t a lie. It’s just not a fit for me.");
  await sleep(3800);

  const proposal = page.locator(".proposal").first();
  await reveal(proposal);
  await spotlight(proposal);
  await caption("THE FIT", "So it selected the monthly plan and re-read the final quote: $35 today.", "Rule checks are deterministic TypeScript. The model never decides.");
  await sleep(3800);
  await spotlight(null);

  const finding = page.locator("details.finding").first();
  await clickOn(finding.locator("summary"));
  await sleep(450);
  await reveal(finding);
  await spotlight(finding);
  await caption("THE PROOF", "Every finding carries its source passage, URL and capture time.", "Unverifiable terms stay unresolved instead of becoming facts.");
  await sleep(3600);
  await spotlight(null);

  await clickOn(review);
  await page.locator("dialog.approval-sheet[open]").waitFor();
  await call(page, "front");
  await caption("MY YES", "Nothing happens without me: I approve this exact plan and amount.", "Approval is bound to a signed, expiring analysis receipt.");
  await sleep(2200);
  await clickOn(approve);
  const drawer = page.locator("dialog.record-drawer[open]");
  await fastForward(() => drawer.waitFor({ timeout: 75_000 }), 2);
  await call(page, "front");
  const storage = drawer.locator(".record-storage");
  if ((await storage.innerText().catch(() => "")).includes("Neon")) exercised.add("neon");
  await reveal(storage);
  await spotlight(storage, 8);
  await caption("THE RECEIPT", exercised.has("neon") ? "Rechecked at approval, saved to Neon, then read back before it says “done.”"
    : "Rechecked at approval and saved, then read back before it says “done.”", "Repeated approvals are idempotent: no duplicate quotes.");
  await sleep(3800);
  await spotlight(null);

  if (emailTo && health.agentmail) await optionalScene("agentmail", async () => {
    const recipient = drawer.getByLabel("Receipt recipient");
    await clickOn(recipient);
    await recipient.pressSequentially(emailTo, { delay: 25 });
    await clickOn(drawer.getByRole("checkbox"));
    await caption("THE RECEIPT", "Email the receipt? AgentMail sends it, but only after I approve that too.");
    await clickOn(drawer.getByRole("button", { name: "Send receipt email", exact: true }));
    await fastForward(() => drawer.getByText("AgentMail accepted this receipt email", { exact: false }).waitFor({ timeout: 25_000 }), 2);
    await sleep(2600);
    return true;
  });
  await clickOn(page.getByRole("button", { name: "Close decision record", exact: true }));

  await caption("THE TRAP", "Now the trap: the store changes the price after I reviewed it.");
  await clickOn(page.getByRole("button", { name: "Quote changes", exact: true }));
  await clickOn(checkOffer);
  await reveal(browserPanel, "center");
  await fastForward(() => review.waitFor({ timeout: 120_000 }));
  await clickOn(review);
  await page.locator("dialog.approval-sheet[open]").waitFor();
  await call(page, "front");
  await sleep(900);
  await clickOn(approve);
  const notice = page.locator(".notice-alert").filter({ hasText: "changed" });
  await fastForward(() => notice.waitFor({ timeout: 75_000 }), 2);
  await reveal(notice);
  await spotlight(notice, 8);
  await caption("BLOCKED", "At the final step the total is $45. My earlier yes can’t pay for it: blocked.", "A changed total forces a fresh rules check and a fresh approval.");
  await sleep(4600);
  await spotlight(null);

  await optionalScene("unresolved", async () => {
    await caption("HONESTY", "And when the cancellation terms are missing…");
    await clickOn(page.getByRole("button", { name: "Incomplete terms", exact: true }));
    await clickOn(checkOffer);
    const warning = page.locator(".terms-warning");
    await fastForward(() => warning.waitFor({ timeout: 120_000 }));
    await reveal(warning);
    await spotlight(warning, 8);
    await caption("HONESTY", "…they stay “not established.” Never invented.", "A failed retrieval is uncertainty, not a fact.");
    await sleep(3600);
    await spotlight(null);
    return true;
  });

  if (health.gateway) await optionalScene("assistant-ui", async () => {
    const ask = page.getByRole("button", { name: "Ask about the evidence" });
    if (!(await ask.isEnabled())) return false;
    await clickOn(ask);
    const chat = page.locator("dialog.chat-drawer[open]");
    await chat.waitFor();
    await call(page, "front");
    await caption("ASK WHY", "Ask why. A Mastra agent answers only from the signed evidence.", "Streamed in Assistant UI, with each tool call visible.");
    await clickOn(chat.getByRole("button", { name: /What remains unresolved/ }));
    await fastForward(async () => {
      await chat.locator(".assistant-message").first().waitFor({ timeout: 30_000 });
      await chat.getByRole("button", { name: "Stop assistant response" }).waitFor({ state: "detached", timeout: 60_000 });
    }, 4);
    if (await chat.locator(".chat-error").count()) return false;
    await sleep(3600);
    await clickOn(page.getByRole("button", { name: "Close evidence assistant" }));
    return true;
  });

  if (health.exa) await optionalScene("exa", async () => {
    const input = page.locator("#offer-url");
    await caption("REAL OFFERS", "Works on real offers too: paste any public subscription page.", "Exa pulls the merchant’s own pricing, renewal and cancellation passages. Read-only, no checkout.");
    await clickOn(input);
    await input.fill("");
    await input.pressSequentially(realOfferUrl, { delay: 18 });
    await clickOn(checkOffer);
    const heading = page.getByRole("heading", { name: "What the evidence establishes" });
    await fastForward(() => heading.waitFor({ timeout: 70_000 }));
    await reveal(heading, "start");
    await spotlight(page.locator('[aria-label="Real-offer research results"]'), 8);
    await sleep(4200);
    await spotlight(null);
    return true;
  });

  await caption("", "");
  const chips = [
    exercised.has("kernel") ? "Kernel browser" : "Real Chrome browser automation",
    ...(exercised.has("mastra") || exercised.has("assistant-ui") ? ["Mastra agent · Neon AI Gateway"] : []),
    ...(exercised.has("neon") ? ["Neon Postgres receipts"] : []),
    ...(exercised.has("assistant-ui") ? ["Assistant UI evidence chat"] : []),
    ...(exercised.has("exa") ? ["Exa source research"] : []),
    ...(exercised.has("agentmail") ? ["AgentMail receipts"] : []),
  ];
  await call(page, "card", "thesis", false);
  await sleep(5800);
  await call(page, "card", "outro", false, chips);
  await sleep(5000);
  const end = await recorder.stop();
  await context.close();
  await browser.close();

  const result = await assemble(recorder.frames, end);
  await rm(framesDir, { recursive: true, force: true });
  await rm(path.join(outDir, "frames.txt"), { force: true });
  console.log(`Video: ${result.video} (${result.total.toFixed(1)}s, ${result.captions} captions)`);
  console.log(`Exercised: ${[...exercised].join(", ") || "core flow only"}`);
  if (errors.length) console.warn("Page errors during recording:", errors);
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
