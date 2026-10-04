// Browser-side presentation layer for scripts/record-demo.ts.
// Draws captions, a visible cursor, click ripples, spotlights and title cards
// in the top layer (a manual popover), so they also sit above modal dialogs.
(() => {
  if (window.top !== window || window.__demo) return;

  const css = `
#__demo-root{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
#__demo-root *{box-sizing:border-box}
.d-spot{position:fixed;left:0;top:0;width:0;height:0;border-radius:16px;opacity:0;box-shadow:0 0 0 200vmax rgba(6,8,12,.52),0 0 0 2px rgba(255,255,255,.92),0 0 34px 4px rgba(120,160,255,.35);transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),width .5s cubic-bezier(.2,.8,.2,1),height .5s cubic-bezier(.2,.8,.2,1),opacity .35s ease}
.d-spot.on{opacity:1}
.d-cap{position:fixed;left:50%;bottom:24px;display:flex;gap:14px;align-items:flex-start;max-width:min(1020px,88vw);padding:14px 22px 15px 14px;border-radius:18px;background:rgba(13,15,21,.86);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);border:1px solid rgba(255,255,255,.14);box-shadow:0 22px 60px rgba(0,0,0,.38);opacity:0;transform:translate(-50%,14px);transition:opacity .3s ease,transform .4s cubic-bezier(.2,.8,.2,1)}
.d-cap.on{opacity:1;transform:translate(-50%,0)}
.d-step{flex:none;margin-top:2px;padding:6px 8px;border-radius:8px;background:#fff;color:#0d0f15;font:700 13px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.02em}
.d-cap b{display:block;font-size:22px;font-weight:650;line-height:1.28;letter-spacing:-.012em}
.d-cap small{display:block;margin-top:5px;font-size:15.5px;line-height:1.35;color:rgba(255,255,255,.72)}
.d-cap small:empty{display:none}
.d-ff{position:fixed;top:16px;right:16px;padding:8px 13px;border-radius:999px;background:rgba(13,15,21,.86);border:1px solid rgba(255,255,255,.16);font:600 14px/1 -apple-system,system-ui,sans-serif;letter-spacing:.01em;opacity:0;transition:opacity .2s ease}
.d-ff.on{opacity:1}
.d-cursor{position:fixed;left:0;top:0;width:26px;height:26px;transform:translate(780px,420px);transition-property:transform;transition-timing-function:cubic-bezier(.65,0,.35,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}
.d-ripple{position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid rgba(255,255,255,.95);background:rgba(90,140,255,.28);opacity:0}
.d-ripple.go{animation:d-ripple .55s ease-out}
@keyframes d-ripple{from{opacity:.95;transform:scale(.3)}to{opacity:0;transform:scale(1.5)}}
.d-card{position:fixed;inset:0;display:grid;place-items:center;background:radial-gradient(1100px 620px at 50% 38%,#1c2232 0%,#0a0c12 62%,#06070a 100%);opacity:0;transition:opacity .6s ease;text-align:center}
.d-card.on{opacity:1}
.d-card.paused *{animation-play-state:paused!important}
.d-card .in{opacity:0;animation:d-in .7s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes d-in{from{opacity:0;transform:translateY(16px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
.ic-ad{position:relative;display:inline-block;font-size:76px;font-weight:700;letter-spacing:-.035em;color:#fff}
.ic-ad em{font-style:normal;color:#9fd0ff}
.ic-strike{position:absolute;left:-2%;right:-2%;top:54%;height:7px;border-radius:4px;background:#ff5d5d;transform:scaleX(0);transform-origin:left;animation:d-strike .55s cubic-bezier(.7,0,.3,1) 1.45s forwards}
@keyframes d-strike{to{transform:scaleX(1)}}
.ic-truth{margin-top:18px;font-size:58px;font-weight:700;letter-spacing:-.03em;color:#ff7a7a}
.ic-brand{margin-top:54px;font-size:30px;font-weight:700;letter-spacing:-.02em}
.ic-brand span,.oc-brand span{color:#8fb8ff}
.ic-tag{margin:12px auto 0;max-width:820px;font-size:22px;line-height:1.42;color:rgba(255,255,255,.74)}
.oc-brand{font-size:30px;font-weight:700;letter-spacing:-.02em}
.oc h1{margin:22px 0 0;font-size:70px;line-height:1.05;font-weight:750;letter-spacing:-.04em}
.oc h1 span{color:#8fb8ff}
.oc-stack{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:40px auto 0;max-width:980px}
.oc-stack span{padding:10px 15px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);font-size:17px;font-weight:550}
.th-kicker{font:700 15px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8fb8ff}
.th-line{margin:28px auto 0;max-width:1000px;font-size:27px;line-height:1.45;color:rgba(255,255,255,.8)}
.th-line b{color:#fff;font-weight:700}
.oc-honest{margin-top:30px;font-size:16px;color:rgba(255,255,255,.58)}
`;

  let root;
  function el(cls, html = "") { const node = document.createElement("div"); node.className = cls; node.innerHTML = html; root.appendChild(node); return node; }
  function mount() {
    if (document.getElementById("__demo-root")) return;
    const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
    root = document.createElement("div"); root.id = "__demo-root"; root.setAttribute("popover", "manual");
    document.body.appendChild(root);
    parts.spot = el("d-spot"); parts.card = el("d-card"); parts.ff = el("d-ff", "⏩&nbsp; Fast-forward");
    parts.cap = el("d-cap", '<span class="d-step"></span><div><b></b><small></small></div>');
    parts.ripple = el("d-ripple");
    parts.cursor = el("d-cursor", '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2 L4 19.2 L8.6 15.1 L11.6 22 L14.6 20.7 L11.6 13.9 L18 13.9 Z" fill="#0d0f15" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
    front();
  }
  const parts = {};
  function front() { if (!root) return; try { if (root.matches(":popover-open")) root.hidePopover(); root.showPopover(); } catch { root.style.zIndex = "2147483647"; } }

  const intro = `<div>
    <div class="in" style="animation-delay:.15s"><div class="ic-ad">“Only <em>$29</em>/month.”<i class="ic-strike"></i></div></div>
    <div class="ic-truth in" style="animation-delay:1.9s">Due today: $348.</div>
    <div class="ic-brand in" style="animation-delay:3.1s"><span>◉</span> Second Look</div>
    <p class="ic-tag in" style="animation-delay:3.45s">Checkouts are built to get a yes. Second Look is a personal agent built to work for you:<br>it reads the fine print, checks your rules, and acts only on the exact quote you approve.</p>
  </div>`;
  const thesis = `<div class="oc">
    <div class="th-kicker in" style="animation-delay:.1s">Why this matters</div>
    <h1 class="in" style="animation-delay:.3s">Personal agents are about<br>to spend our money.</h1>
    <p class="th-line in" style="animation-delay:1.5s">The ones we trust will show their evidence, follow our rules in code,<br>and <b>never act on a stale yes.</b></p>
  </div>`;
  const outro = chips => `<div class="oc">
    <div class="oc-brand in" style="animation-delay:.1s"><span>◉</span> Second Look</div>
    <h1 class="in" style="animation-delay:.35s">A clearer yes.<br><span>A better no.</span></h1>
    <div class="oc-stack in" style="animation-delay:.9s">${chips.map(chip => `<span>${chip}</span>`).join("")}</div>
    <p class="oc-honest in" style="animation-delay:1.3s">Synthetic storefront · no real payments · every claim linked to its source</p>
  </div>`;

  window.__demo = {
    front,
    card(kind, paused, chips = []) {
      front(); parts.card.innerHTML = kind === "intro" ? intro : kind === "thesis" ? thesis : outro(chips);
      parts.card.classList.toggle("paused", Boolean(paused));
      parts.card.style.transition = paused ? "none" : ""; parts.card.classList.add("on");
    },
    play() { parts.card.classList.remove("paused"); parts.card.style.transition = ""; },
    hideCard() { parts.card.classList.remove("on"); },
    caption(step, title, sub) {
      front();
      if (!title) { parts.cap.classList.remove("on"); return; }
      const swap = () => {
        parts.cap.querySelector(".d-step").textContent = step;
        parts.cap.querySelector("b").textContent = title;
        parts.cap.querySelector("small").textContent = sub || "";
        parts.cap.classList.add("on");
      };
      if (parts.cap.classList.contains("on")) { parts.cap.classList.remove("on"); setTimeout(swap, 180); } else swap();
    },
    spotlight(box) {
      front();
      if (!box) { parts.spot.classList.remove("on"); return; }
      Object.assign(parts.spot.style, { left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" });
      parts.spot.classList.add("on");
    },
    cursorTo(x, y, ms) {
      front(); parts.cursor.style.transitionDuration = ms + "ms";
      parts.cursor.style.transform = `translate(${x - 4.3}px, ${y - 2.2}px)`;
    },
    ripple(x, y) {
      Object.assign(parts.ripple.style, { left: x + "px", top: y + "px" });
      parts.ripple.classList.remove("go"); void parts.ripple.offsetWidth; parts.ripple.classList.add("go");
    },
    ff(on) { parts.ff.classList.toggle("on", Boolean(on)); },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
