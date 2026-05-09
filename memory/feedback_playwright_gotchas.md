---
name: Playwright gotchas hit during promo recording
description: Specific timeouts, selectors, and step-flow assumptions that broke when scripting /app via Playwright. Saves rounds of debug next time.
type: feedback
---

When using Playwright to drive the production /app and /voice flows for recordings or tests, several issues recur. Hit them all once during the promo-video sessions; saving the lessons.

**1. `scrollIntoViewIfNeeded()` default timeout is 30 s.** If the element doesn't exist on the current page, the call hangs for 30 s before throwing. Always pass `{ timeout: 3000 }` explicitly. Same for any locator action that takes a `timeout` option — the default is unreasonably long for headless scripted flows.

**2. `locator.click({ timeout: N })` doesn't catch unmet preconditions.** A click on `#btn-continue` will time out at N ms if the button is `disabled` for the current step (e.g., step 2 needs `inp-area > 0`). Wrap the selector in `:not([disabled])` and bump the timeout to 5 s so legitimate enable-after-render cases pass, illegitimate cases fail visibly.

```js
await page.locator('#btn-continue:not([disabled])').click({ timeout: 5000 });
```

**3. The /app step machine auto-advances on service-tile click.** `selectService` fires `setTimeout(() => goStep(2), 280)`. So clicking a `.svc-row` skips step 1 → step 2 without the user clicking Continue. Don't add a Continue click after picking a service; it'll fail because Continue is now governed by step 2 conditions (`inp-area > 0`).

**4. Step 3 (price) does NOT auto-fill.** Reaching the price step doesn't populate `inp-price`. The user must click `#btn-ai-price` (which opens a modal) and then `#ai-price-apply` to commit the recommended rate. Continue stays disabled until then. The flow is:
- Continue → step 3 (price)
- Click `#btn-ai-price` → modal opens with three tiers
- Click `#ai-price-apply` → modal closes, `inp-price` populates
- Click Continue → step 4 (review)

**5. Map confirm button id is `#btn-map-done`, not a generic role match.** A `getByRole('button', { name: /done|use|confirm/i })` regex worked sometimes by accident. Pin to `#btn-map-done:not([disabled])` — the disabled state lifts after 3+ polygon points are drawn.

**6. Headless Chromium doesn't render the SR (SpeechRecognition) API meaningfully.** For /voice, unhide `#transcript-fallback` programmatically before typing into it:

```js
await page.evaluate(() => {
  document.getElementById('transcript-fallback')?.classList.remove('hidden');
  document.getElementById('submit-btn')?.classList.remove('hidden');
});
```

**7. /voice expects two sequential Anthropic round-trips before result is fully populated.** `/voice/analyze` fires immediately on submit (~3-4s), then `/voice/price` kicks off after analyze completes (~3-4s more). Total ~6.5 s wait between submit and a complete result. Going earlier shows "Calculating" placeholder instead of the price.

**8. Authenticate as full-tier (signup with password) not email-only.** Email-only sees blurred prices and the conversion CTA, which is on-brand for the product but not what you want in a promo. Full-tier shows exact prices, skips Turnstile, allows save. Each promo recording adds one row to the `users` table with email `promo-<ts>@pquote-demo.example` and password `PromoDemo!2026` — sweep manually if it accumulates.

**9. Click-visualization injection.** Ross expects every click to be visible in recordings. Inject this via `page.addInitScript()` so it runs on every navigation:

```js
const CLICK_VIZ = `(function() {
  const style = document.createElement('style');
  style.textContent = \`
    @keyframes pq_click_ring { 0% {transform:translate(-50%,-50%) scale(.4); opacity:1} 100% {transform:translate(-50%,-50%) scale(2.2); opacity:0} }
    .pq-click-ring { position:fixed; width:60px; height:60px; border-radius:50%; border:4px solid #FFB000; box-shadow:0 0 24px rgba(255,176,0,.9); pointer-events:none; z-index:2147483647; animation:pq_click_ring 700ms ease-out forwards; }
  \`;
  document.head.appendChild(style);
  function spawn(x,y) { const r=document.createElement('div'); r.className='pq-click-ring'; r.style.left=x+'px'; r.style.top=y+'px'; document.body.appendChild(r); setTimeout(()=>r.remove(),800); }
  document.addEventListener('click', e=>spawn(e.clientX,e.clientY), true);
  document.addEventListener('mousedown', e=>spawn(e.clientX,e.clientY), true);
})();`;
await page.addInitScript(CLICK_VIZ);
```

**How to apply:** when scripting /app or /voice flows in Playwright (for tests, recordings, or smoke checks), assume each of these gotchas applies until proven otherwise.
