# pvault — Brand Design System

**Version:** 1.0
**Last updated:** 2026-04-21
**Owner:** pvault

---

## 0. Brand snapshot

| | |
|---|---|
| **Business** | pvault |
| **Industry** | SaaS — secure file cloud storage |
| **Audience** | Security-conscious professionals, small-to-mid teams, freelancers, and developers who need zero-knowledge storage without enterprise friction |
| **Personality** | Clean · Minimal · Modern · Trustworthy · Quiet confidence |
| **Voice** | Direct, precise, reassuring. Never hype. Short sentences. Plain English over jargon. |
| **Tagline direction** | "Your files. Sealed shut." |

> **Design north star:** Look like a product built by people who care about craft. Feel like a safe.

---

## 1. Colour palette

All colours are defined with a HEX value, an rgb() fallback, and a token name. Tokens are the source of truth — never hardcode hex values in product code.

### 1.1 Primary (brand)

| Token | Hex | RGB | Use |
|---|---|---|---|
| `--brand-900` | `#0B1220` | 11, 18, 32 | Headlines, logo on light bg |
| `--brand-700` | `#1E2A44` | 30, 42, 68 | Primary dark surfaces |
| `--brand-500` | `#3A57E8` | 58, 87, 232 | **Primary action** (buttons, links, focus) |
| `--brand-300` | `#9BAEFF` | 155, 174, 255 | Hover states, subtle highlights |
| `--brand-100` | `#EEF1FF` | 238, 241, 255 | Tinted backgrounds, selected rows |

### 1.2 Secondary (supporting)

| Token | Hex | Use |
|---|---|---|
| `--ink-900` | `#0E0F12` | Body text on light |
| `--ink-700` | `#2A2D35` | Secondary text |
| `--ink-500` | `#5B6070` | Muted text, captions |
| `--ink-300` | `#A7ADBB` | Placeholder, disabled |

### 1.3 Accent

| Token | Hex | Use |
|---|---|---|
| `--accent-teal` | `#17C3B2` | Success-adjacent highlights, "encrypted" badges |
| `--accent-amber` | `#F5B544` | Attention pulls — use sparingly |

### 1.4 Neutrals

| Token | Hex | Use |
|---|---|---|
| `--n-0` | `#FFFFFF` | Surface — card, modal |
| `--n-50` | `#F8F9FB` | Page background |
| `--n-100` | `#F1F3F7` | Subtle fills |
| `--n-200` | `#E4E7EE` | Dividers, borders |
| `--n-400` | `#C3C8D3` | Input borders |
| `--n-900` | `#0B0D12` | Dark-mode surface |

### 1.5 Semantic

| Token | Hex | Meaning |
|---|---|---|
| `--success` | `#16A34A` | Upload complete, saved |
| `--warning` | `#D97706` | Storage nearly full |
| `--danger` | `#DC2626` | Delete, auth failure |
| `--info` | `#0284C7` | System messages |

### 1.6 Usage ratios

- **60%** neutrals (`--n-0`, `--n-50`, `--n-100`)
- **30%** ink (text + dark surfaces)
- **10%** brand + accent combined

Never let accents exceed 10% of a screen's visible area.

---

## 2. Typography

### 2.1 Font pairing

| Role | Family | Fallback | License |
|---|---|---|---|
| **Display / headings** | `Inter Display` | `Inter`, system-ui, sans-serif | Open-source (OFL) |
| **Body / UI** | `Inter` | system-ui, -apple-system, Segoe UI, sans-serif | Open-source (OFL) |
| **Mono / code / file paths** | `JetBrains Mono` | Menlo, Consolas, monospace | Open-source (OFL) |

Inter is used for everything visible; JetBrains Mono only appears for code snippets, file hashes, and encryption keys — visual cue that *these characters matter exactly*.

### 2.2 Scale (1.250 — Major Third)

| Token | Size | Line-height | Weight | Letter-spacing | Use |
|---|---|---|---|---|---|
| `--t-display` | 72px / 4.5rem | 1.05 | 700 | -0.03em | Landing hero |
| `--t-h1` | 48px / 3rem | 1.1 | 700 | -0.02em | Page title |
| `--t-h2` | 36px / 2.25rem | 1.2 | 600 | -0.015em | Section title |
| `--t-h3` | 28px / 1.75rem | 1.25 | 600 | -0.01em | Card title |
| `--t-h4` | 22px / 1.375rem | 1.3 | 600 | 0 | Subsection |
| `--t-lg` | 18px / 1.125rem | 1.55 | 500 | 0 | Lead paragraph |
| `--t-base` | 16px / 1rem | 1.6 | 400 | 0 | Body |
| `--t-sm` | 14px / 0.875rem | 1.5 | 500 | 0 | UI, labels |
| `--t-xs` | 12px / 0.75rem | 1.4 | 600 | 0.04em | Eyebrows, captions, uppercase tags |
| `--t-mono` | 14px | 1.5 | 500 | 0 | File names, hashes |

### 2.3 Rules

- Only **three** weights in circulation: 400, 500, 600, 700. No 300, no 800+.
- Headings: `letter-spacing` negative (tighter). Body: 0. Caps tags: +0.04em.
- Max reading line length: **68ch**.
- Never center body paragraphs longer than 2 lines.

---

## 3. Spacing & layout grid

### 3.1 Spacing scale (4px base)

| Token | px | rem | Typical use |
|---|---|---|---|
| `--s-0` | 0 | 0 | — |
| `--s-1` | 4 | 0.25 | Icon-to-text gap |
| `--s-2` | 8 | 0.5 | Tight internal padding |
| `--s-3` | 12 | 0.75 | Input vertical padding |
| `--s-4` | 16 | 1 | Default gap |
| `--s-5` | 24 | 1.5 | Card padding, stack gap |
| `--s-6` | 32 | 2 | Block separation |
| `--s-8` | 48 | 3 | Section padding (mobile) |
| `--s-10` | 64 | 4 | Section padding (tablet) |
| `--s-12` | 96 | 6 | Section padding (desktop) |
| `--s-16` | 128 | 8 | Hero breathing room |

Rule: only use tokens. If a designer needs a value not on the scale, they should justify it — usually they don't need it.

### 3.2 Grid

- **Container max-width:** 1200px, centered, with 24px side padding.
- **Columns:** 12 on desktop, 8 on tablet, 4 on mobile.
- **Gutter:** 24px desktop, 16px tablet, 12px mobile.
- **Breakpoints:**
  - `sm` ≥ 640px
  - `md` ≥ 768px
  - `lg` ≥ 1024px
  - `xl` ≥ 1280px
  - `2xl` ≥ 1536px

### 3.3 Radius & elevation

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 6px | Inputs, small chips |
| `--r-md` | 10px | Buttons, cards |
| `--r-lg` | 16px | Modals, feature cards |
| `--r-xl` | 24px | Hero illustrations |
| `--r-full` | 9999px | Avatars, pills |

| Token | Shadow |
|---|---|
| `--shadow-sm` | `0 1px 2px rgba(11,18,32,.06)` |
| `--shadow-md` | `0 4px 12px rgba(11,18,32,.08)` |
| `--shadow-lg` | `0 12px 32px rgba(11,18,32,.10)` |
| `--shadow-focus` | `0 0 0 3px rgba(58,87,232,.35)` |

Use shadow sparingly. Prefer 1px borders (`--n-200`) to communicate depth on light UI.

---

## 4. Component styles

### 4.1 Buttons

Height 44px (default), 36px (sm), 52px (lg). Horizontal padding `--s-5`. Radius `--r-md`. Font: `--t-sm`, weight 600. Transition: `150ms ease-out` on color/shadow.

| Variant | Fill | Text | Border | Hover | Disabled |
|---|---|---|---|---|---|
| **Primary** | `--brand-500` | `--n-0` | none | darken 8% + `--shadow-md` | 40% opacity |
| **Secondary** | `--n-0` | `--ink-900` | 1px `--n-200` | bg `--n-50` | — |
| **Ghost** | transparent | `--brand-500` | none | bg `--brand-100` | — |
| **Danger** | `--danger` | `--n-0` | none | darken 8% | — |

Focus ring: always `--shadow-focus`. Never remove outlines without replacing them.

### 4.2 Cards

```
background:   var(--n-0);
border:       1px solid var(--n-200);
border-radius: var(--r-lg);
padding:      var(--s-5);
shadow:       var(--shadow-sm);
```

Hover (interactive only): `transform: translateY(-2px); box-shadow: var(--shadow-md);` over 180ms.

### 4.3 Inputs

- Height 44px, padding `12px 14px`, radius `--r-sm`.
- Border 1px `--n-400`, background `--n-0`.
- Focus: border `--brand-500` + `--shadow-focus`.
- Error: border `--danger`, helper text `--danger`.
- Label above the input, weight 500, `--t-sm`, color `--ink-700`.
- Placeholder color `--ink-300`.
- Helper/error text `--t-xs`, `--s-1` below input.

### 4.4 Badges / chips

- Height 24px, padding `2px 10px`, radius `--r-full`.
- `--t-xs`, weight 600, uppercase, letter-spacing +0.04em.
- Variants use pale fills + matching tinted text:
  - **Encrypted:** bg `#E6FBF7`, text `--accent-teal`.
  - **Pro:** bg `--brand-100`, text `--brand-700`.
  - **Beta:** bg `#FFF3DC`, text `#8B5E00`.
  - **Failed:** bg `#FDEAEA`, text `--danger`.

### 4.5 Other

- **Tables:** zebra rows off by default. Row height 52px. Divider `--n-200`. First column weight 500.
- **Modals:** max-width 520px. Radius `--r-lg`. Backdrop `rgba(11,18,32,.55)` with 4px blur.
- **Tooltips:** bg `--ink-900`, text `--n-0`, `--t-xs`, 8px padding, 150ms fade.

---

## 5. Iconography & illustration

### 5.1 Icons

- **Library:** Lucide (MIT) — consistent 24×24 grid, 1.75px stroke.
- **Size tokens:** 16 / 20 / 24 / 28. No freeform sizes.
- **Color:** inherit text color; never multi-color.
- **Alignment:** optical baseline aligned to text cap-height.
- **Don't mix** icon libraries — one family across the product.

### 5.2 Brand mark

- The "pvault" wordmark is all lowercase, Inter Display 700, letter-spacing -0.03em.
- Optional lock glyph: a rounded square with an interior keyhole, `--r-md` corners, in `--brand-500` on light, `--n-0` on dark.
- Clear space around the mark ≥ the height of the glyph.
- Minimum size: 20px glyph / 80px wordmark.

### 5.3 Illustration direction

- **Style:** flat geometric, generous negative space, 1–2 brand colours + one accent max.
- **Subject language:** vaults, shields, keys, folders — but abstracted, never literal clipart.
- **Lighting:** none. No gradients beyond a single linear `--brand-700 → --brand-500` on hero glass panels.
- **Photography:** only when showing the product UI itself. Mock on a solid `--n-50` background or a `--brand-700` surface. No stock people at laptops.
- **Motion:** subtle — 150–300ms ease-out transitions. Respect `prefers-reduced-motion`.

---

## 6. Do's & don'ts

### Do

- Use the token system for every colour, spacing, and typography value.
- Lean on whitespace — if a section feels cramped, add space before adding rules or borders.
- Keep primary CTAs to **one per screen**.
- Pair every piece of sensitive UI text (password, key, recovery code) with mono type.
- Maintain WCAG AA contrast (4.5:1 text, 3:1 large text / UI).
- Write short. Replace "Please click the button below to continue" with "Continue".

### Don't

- Don't introduce new colours outside the palette to "match" a screenshot or a marketing campaign.
- Don't stack more than three font weights on a single screen.
- Don't use drop shadows and thick borders together — pick one.
- Don't center-align long body text, testimonials, or forms.
- Don't use the danger red for anything except destructive or failed states. It loses meaning fast.
- Don't animate the logo.
- Don't use emoji as product iconography. Ever.
- Don't place text on imagery without a tint layer (min 40% ink overlay).

---

## 7. Implementation — CSS custom properties

Drop this into a root stylesheet so every project shares the same source.

```css
:root {
  /* Brand */
  --brand-900:#0B1220; --brand-700:#1E2A44; --brand-500:#3A57E8;
  --brand-300:#9BAEFF; --brand-100:#EEF1FF;

  /* Ink */
  --ink-900:#0E0F12; --ink-700:#2A2D35; --ink-500:#5B6070; --ink-300:#A7ADBB;

  /* Neutrals */
  --n-0:#FFFFFF; --n-50:#F8F9FB; --n-100:#F1F3F7;
  --n-200:#E4E7EE; --n-400:#C3C8D3; --n-900:#0B0D12;

  /* Accent & semantic */
  --accent-teal:#17C3B2; --accent-amber:#F5B544;
  --success:#16A34A; --warning:#D97706; --danger:#DC2626; --info:#0284C7;

  /* Type */
  --font-sans:'Inter', system-ui, -apple-system, Segoe UI, sans-serif;
  --font-display:'Inter Display', var(--font-sans);
  --font-mono:'JetBrains Mono', Menlo, Consolas, monospace;

  /* Spacing */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:24px;
  --s-6:32px; --s-8:48px; --s-10:64px; --s-12:96px; --s-16:128px;

  /* Radius */
  --r-sm:6px; --r-md:10px; --r-lg:16px; --r-xl:24px; --r-full:9999px;

  /* Shadow */
  --shadow-sm:0 1px 2px rgba(11,18,32,.06);
  --shadow-md:0 4px 12px rgba(11,18,32,.08);
  --shadow-lg:0 12px 32px rgba(11,18,32,.10);
  --shadow-focus:0 0 0 3px rgba(58,87,232,.35);
}
```

---

## 8. Accessibility checklist (non-negotiable)

- All interactive elements have a visible focus state (`--shadow-focus`).
- Contrast verified against AA at minimum, AAA for body text where possible.
- Hit target ≥ 44×44px.
- Never rely on colour alone — pair with icon or text.
- Motion respects `prefers-reduced-motion: reduce`.
- Forms: every input has a `<label>`, errors are announced, not just coloured.

---

*End of document. Fork, version, and date your changes — design systems rot without maintenance.*
