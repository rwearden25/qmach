---
name: Never use 11905 Metmora Ct or other personal addresses
description: 11905 Metmora Ct is Ross's home address — never use it as a demo, test, or example address. Use a public commercial address instead.
type: feedback
---

**Hard rule: never use 11905 Metmora Ct as a test, demo, or example address anywhere — code, docs, commit messages, video recordings, screenshots, prompts, or chat replies.** It is Ross's home address and exposing it (especially in shipped artifacts like a landing-page promo video) is a privacy leak.

**Why:** Ross flagged this directly after the address appeared in the embedded promo video on the landing page. The address had already been used in commit messages (#30 fix-target-pin), the v2 premortem, the user-feedback test plans, and the recorded video sent to public/promo.webm. The promo video specifically would have served the address to every visitor on pquote.ai.

**How to apply:**
- Default to **public commercial addresses** when an example is needed: chain restaurants, retail stores, stadiums, parking garages, public landmarks. Example pool that's safe and on-brand for trades:
  - "1717 N Akard St, Dallas TX" (downtown Dallas commercial)
  - "5300 N Belt Line Rd, Irving TX" (chain restaurant)
  - "2401 Victory Park Ln, Dallas TX" (American Airlines Center)
  - Any explicit "Acme Restaurant — 123 Main St, Anytown" placeholder
- For map/pin demos that need a parking lot, pick a known commercial parking lot. Don't use any residential address — a stranger's house is also a privacy issue, just less obviously.
- If a recording or demo asset needs replacing because this rule was missed, re-record / re-publish urgently — the leak duration matters.
- Past commit messages can't be easily redacted, but going forward, NEVER put a personal address in a commit message.
