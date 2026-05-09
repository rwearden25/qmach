# Landing-page promo video — production runbook

The hero video at `public/promo.webm` is a real recording of the production app driven by Playwright + a small ffmpeg post-processing step. This doc covers what's in it, how to re-record it, and where the knobs are.

## What the video shows

≈45–60 s, 30 fps, VP9 in webm container, 414 × 896 portrait (phone-shaped, sized for the hero on mobile).

Two flows back-to-back, with bold black-pill `VOICE QUOTE` and `MAP QUOTE` caption banners overlaid at the section starts:

| Time     | Section     | What happens |
|----------|-------------|-------|
| 0 – 2 s  | landing     | Page renders / hero text |
| 2 – 22 s | VOICE QUOTE | Tap textarea → type "Pressure wash a 2,000 sqft house and the driveway" → submit → AI parses + price loads → scroll through full result → fill client name → tap Download → quote-preview modal slides in |
| 22 – 56 s | MAP QUOTE | Open /app → type address → autocomplete → Continue → service tile (auto-advances) → Open Map & Draw → satellite tiles + red target pin → 4 corner taps drawing polygon → ✓ Done — Calculate Area → Continue → ✨ AI Suggest Price → modal with three tiers → Apply → Continue → Review → fill client → ✍ AI Scope of Work → Save & Share |

Every click spawns a brand-amber pulsing ring at the click point so the viewer can see exactly which control was tapped.

## Where the tooling lives

**Outside the repo,** so the production app stays a thin Express server:

```
C:\Users\Ross.Wearden\AppData\Local\Temp\pquote-browser-tests\
├── package.json              (playwright + ffmpeg-static)
├── node_modules/
├── record-promo.js           (the Playwright driver)
├── run-tests.js              (smoke test fixture)
└── video-out/                (raw webm captures)
```

If the temp dir is gone (machine wiped, fresh setup), recreate with:
```bash
mkdir -p /tmp/pquote-browser-tests
cd /tmp/pquote-browser-tests
npm init -y
npm install --silent playwright ffmpeg-static
npx playwright install chromium
```

Then copy `record-promo.js` from a previous PR (e.g., from the description in the `promo-clean-flow` branch).

## To re-record

```bash
cd /tmp/pquote-browser-tests
rm -f video-out/*.webm
node record-promo.js
```

The script:
1. Calls `POST /api/auth/signup` to create a one-shot full-tier user (`promo-<timestamp>@pquote-demo.example`, password `PromoDemo!2026`). Full-tier so prices aren't blurred and Turnstile is skipped.
2. Plants the session token + a click-visualization injection on every navigation.
3. Drives /voice end-to-end, then /app end-to-end.
4. Auto-copies the raw webm to `public/promo.webm`.

You'll see step-by-step timing logs:
```
▶ VOICE: open page
  └─ 2.1s
▶ VOICE: tap textarea + type prompt
  └─ 3.0s
...
```

## To post-process (smoothness + section labels)

The raw recording is 25 fps and unlabeled. Re-encode for the final asset:

```bash
FFMPEG=$(node -e "console.log(require('/tmp/pquote-browser-tests/node_modules/ffmpeg-static'))")
SRC=$(ls /tmp/pquote-browser-tests/video-out/*.webm | head -1)

"$FFMPEG" -y -i "$SRC" -an \
  -vf "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,drawtext=text='VOICE QUOTE':x=(w-tw)/2:y=80:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=18:enable='between(t,1.5,5)',drawtext=text='MAP QUOTE':x=(w-tw)/2:y=80:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=18:enable='between(t,24,27.5)'" \
  -c:v libvpx-vp9 -b:v 700k -crf 32 public/promo.webm
```

Filter chain explained:
- **`minterpolate=fps=30:mi_mode=mci:...`** — motion-compensated interpolation from 25 → 30 fps. Visibly smoother on transitions, scrolls, and the polygon-draw act. Slow encode (~1× realtime).
- **`drawtext=...:enable='between(t,X,Y)'`** — the section labels. Two of them, timed to the section starts. Adjust `X`/`Y` if section boundaries shift on a re-record.
- **`-an`** — strip audio (recording is silent anyway).
- **`-c:v libvpx-vp9 -b:v 700k -crf 32`** — VP9 encode targeting ~700 kbps; CRF 32 is near-best quality at this resolution. Result is ~1.4 MB for ~55 s.

## Cleanup after recording

Each recording adds one row to the production `users` table. Sweep periodically:

```sql
DELETE FROM users WHERE email LIKE 'promo-%@pquote-demo.example';
```

Run via `gh railway connect` or whatever direct-DB access pattern is preferred.

## When to re-record

- /voice or /app flow materially changes (new step, renamed button, different end-state).
- A button id shifts in a way that breaks the script's selectors (which fail loudly with a ⚠ but produce a partial recording).
- New trade or service appears in the service-tile list and the demo should highlight it.

Cosmetic CSS changes don't require a re-record — the recording is screen-pixel accurate, so colors / typography updates appear automatically the next time we re-encode.

## Knobs you might tune

| Knob | Where | Effect |
|------|-------|--------|
| Section-label timing | The `drawtext=...:enable='between(t,X,Y)'` ranges | Adjust if boundaries shift |
| Caption styling | `fontsize`, `fontcolor`, `box`, `boxcolor` in drawtext | Match your brand |
| Smoothness | `minterpolate` `mi_mode` (`dup` / `blend` / `mci`) | mci is highest quality, dup is fastest |
| Encode quality | `-b:v` and `-crf` | Lower bitrate / higher CRF = smaller file |
| Per-step pacing | `page.waitForTimeout(N)` calls in record-promo.js | The whole script's rhythm |
| Click ring color/size | `CLICK_VIZ` constant in record-promo.js | Currently brand-amber `#FFB000`, 60 px ring |
| Test address | `1601 Bryan St, Dallas TX` (Energy Plaza) | Public commercial only — never residential |

## Embedded video element

The video lives in the landing-page hero as a tap-to-pause `<button>` wrapper:

```html
<button class="hero-promo" id="hero-promo" type="button" aria-label="Tap to pause or play">
  <video class="hero-promo-video" id="hero-promo-video"
         src="/promo.webm" autoplay loop muted playsinline preload="metadata"></video>
  <span class="hero-promo-pause-icon" aria-hidden="true">▶</span>
  <span class="hero-promo-caption">Tap to pause · Real flow</span>
</button>
```

CSS class `.hero-promo.is-paused` toggles the ▶ overlay; JS at the bottom of `landing.html` syncs it to the video's pause/play events. `autoplay+muted+playsinline` is the iOS Safari combo that lets the video auto-start; `preload=metadata` keeps initial page weight low.
