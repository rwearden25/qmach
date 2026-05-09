---
name: Pricing-card features that don't ship yet (aspirational backlog)
description: Four features were struck from the landing pricing card because they don't exist in code. They remain on the build wishlist.
type: project
---

The landing-page pricing card was rewritten to be truthful (`paid-readiness-pass` PR #43, 2026-05-09). Four features were removed because they didn't exist:

1. **Auto lot-trace** — Automatic polygon detection of building footprints / parcel boundaries from satellite imagery. Multi-day work; needs a parcel API integration (Regrid, ArcGIS, or county GIS data) since computer-vision-from-satellite-tile alone isn't reliable.
2. **Drag-and-drop photos with AI scope tagging** — Upload multiple photos to a quote, then run them through Claude Vision to auto-tag scope items. Needs (a) file upload pipeline + storage on the Railway volume, and (b) integration with Anthropic's vision endpoint. Roughly 2-3 days end-to-end.
3. **Margin slider with live total math** — UI control on the price step where the user drags a margin %, and total/per-unit recalcs live. The cleanest one to ship — ~30-60 min of work.
4. **One-click email with PDF attached** — The current "Save & Share" flow does SMS / email link / clipboard but doesn't auto-attach the generated PDF to a mailto. Needs a real outbound email provider (SES, Postmark, Resend) since `mailto:` URIs can't carry attachments. ~half-day with the right provider key.

**Why:** A paying user clicking through the landing pricing card and finding these features missing erodes trust on day 1. Striking them is the safe move; building them is the higher-value move.

**How to apply:** when planning sprint work or asked "what should we build next," surface this list. Recommended priority by value-per-effort: margin slider → drag-drop photos (upload only, defer AI tagging) → AI scope tagging → email-with-PDF → auto lot-trace last (speculative; quality of result depends on parcel API).

**Pricing-card status:** the card now lists 9 truthful items. AI features are featured prominently (parses voice → quote, suggests pricing, writes scope-of-work narrative). If any of the four above ships, add it back to the card in the same PR.
