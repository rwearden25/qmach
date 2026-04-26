---
name: Frontend work needs frontend-design treatment
description: When building UI for pquote (and likely other Ross projects), invoke the frontend-design skill — generic CSS is not acceptable
type: feedback
---

When building any frontend for Ross's projects, default to invoking the `frontend-design` skill rather than producing generic system-ui + utility-class CSS.

**Why:** Mid-execution on the pquote voice quote flow (2026-04-25), Ross interrupted the mechanical subagent task flow at the CSS step to manually invoke `/frontend-design:frontend-design`. The implementation plan had specified generic palette-borrowed CSS — Ross expects bold, intentional, distinctive aesthetics, not "AI slop."

**How to apply:**
- Whenever a plan reaches a CSS / HTML / visual scaffolding step, ask whether to apply frontend-design treatment BEFORE the implementer writes generic styles
- For Ross's projects (pquote, P-Supp/Pippy, Scanbook Portal, ELERA Dashboard), default to a distinctive design direction with one strong aesthetic concept, not boilerplate framework defaults
- Pair the frontend-design skill with `react-azure-spa` or `psupp-node` skills as appropriate for the stack
- Take direct ownership of design work — don't delegate creative judgment to mechanical subagents who will smooth bold choices into safer/blander ones
