---
name: Promo video preferences (pace, completeness, end-states)
description: How Ross wants the landing-page promo video produced — natural pace, full end-to-end flow, visible click feedback, section labels, tappable to pause
type: feedback
---

When iterating on `public/promo.webm` (the recorded landing-page hero video), several preferences came out across many rounds of feedback. Internalize these the first time so you don't waste rounds.

**Length: longer is OK if it earns its time.** A 15s sped-up version got rejected ("awkward, stays on building 10 seconds"). A 1m55s natural version was too long. The sweet spot was ~45-60s natural pace. The user explicitly said "the video can be longer than 15 seconds — it needs to give the users a good preview."

**Pace: natural. Don't speed up.** `setpts=PTS/1.65` to fit a budget got pushback. Re-record tighter or trim with `-t` instead. The user said "slow the video down so users can see."

**Smoothness matters.** Use ffmpeg `minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` to upsample the 25fps Playwright capture to 30fps with motion-compensated interpolation. Visibly smoother on transitions, scrolls, and the polygon-draw act.

**Both flows must show end-to-end completion.**
- Voice flow ends at the **Download → preview modal** (not at "scroll back up" or "fill client"). The preview modal IS the completed quote — viewers must see it.
- Map flow ends at **Save & Share** after the AI Scope of Work narrative writes itself.

**Click feedback is required.** Inject a global click handler that spawns an amber pulsing ring at every click point. Without it the user can't tell which button was pressed. Keep the ring 700ms, brand-amber `#FFB000`.

**Section labels distinguish the two flows.** Bold black-pill `VOICE QUOTE` and `MAP QUOTE` overlays via ffmpeg `drawtext` at the section starts. Without them viewers don't know they're watching two different products.

**Tap-to-pause on the embedded video.** Wrap the `<video>` in a `<button>`, add a centered ▶ overlay that appears via `.is-paused`, sync via `pause`/`play` event listeners. Caption "Tap to pause · Real flow" so the interaction is obvious.

**No personal addresses, ever.** Promo recordings are publicly served. Use `1601 Bryan St, Dallas TX` (Energy Plaza, downtown commercial) or another obviously-public commercial address. See `feedback_never_use_personal_address.md` for the hard rule.

**How to apply:** when asked to re-record the promo, follow `docs/promo-video.md`. The Playwright script + ffmpeg pipeline lives outside the repo at `C:\Users\Ross.Wearden\AppData\Local\Temp\pquote-browser-tests\record-promo.js`. Run `node record-promo.js` from that dir to produce a fresh `public/promo.webm`.
