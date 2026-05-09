---
name: Materials KB — what it is and how to extend it
description: The materials_kb table grounds AI pricing in real industry numbers. Seeded from db/materials_seed.json on every boot. Add rows by editing the JSON.
type: reference
---

## What it does

`materials_kb` is a SQLite table seeded at boot from `db/materials_seed.json`. Each row is an industry-specific application rate, coverage number, or rule-of-thumb cost — things the AI used to guess (often badly) and now treats as ground truth.

`db/kb.js` exports `getMaterialsForIndustry(industry, region='US')`. The `/voice/price` and `/api/ai/suggest-price` handlers call it and inject the rows into the Anthropic prompt. The system prompt instructs the model to use these as priority-2 grounding (priority-1 is the user's own pricing calibration via `getPricingCalibration`).

## Schema

```sql
CREATE TABLE materials_kb (
  id         TEXT PRIMARY KEY,        -- "<industry>:<key>:<region>"
  industry   TEXT NOT NULL,           -- 'pressure-washing', 'roofing', etc.
  key        TEXT NOT NULL,           -- stable identifier the AI can reference
  label      TEXT NOT NULL,           -- human-readable description
  value_low  REAL,                    -- typical low end of the range
  value_mid  REAL,                    -- typical mid / market
  value_high REAL,                    -- typical high / premium
  unit       TEXT,                    -- "$/sqft", "sqft/gal", "$/stall", etc.
  region     TEXT NOT NULL DEFAULT 'US',
  source     TEXT,                    -- attribution / why this number
  created_at INTEGER NOT NULL
);
```

UPSERT semantics on the `id` (`<industry>:<key>:<region>`) — editing the seed JSON and redeploying refreshes existing rows in place.

## To add or update a row

1. Open `db/materials_seed.json`.
2. Add a row to `rows[]` with at minimum `industry`, `key`, `label`, and at least one of `value_low/mid/high`. `unit` is optional but strongly recommended — without it, the AI has to guess what `0.18` means.
3. Commit + push. Boot logs will show `[KB] materials_kb seeded (N rows)`.

```json
{
  "industry": "pressure-washing",
  "key": "rate_brick_sqft",
  "label": "Pressure-washing brick exterior (residential)",
  "value_low": 0.12, "value_mid": 0.22, "value_high": 0.40,
  "unit": "$/sqft",
  "source": "Brick is more porous; takes longer than vinyl"
}
```

## Industries currently seeded (20 starter rows)

- `pressure-washing` — house exterior, concrete flatwork, min call-out
- `sealcoating` — refresh rate, sealer coverage/gal, crack-fill linft
- `parking-lot-striping` — restripe per stall, new layout, ADA premium, linft rate
- `painting` — exterior, interior (by floor), paint coverage/gal
- `roofing` — asphalt per square, tear-off, flat-roof recoat
- `concrete` — flatwork pour, demo
- `landscaping` — sod install, mulch per yard

## What's NOT in the KB (yet)

- Region-specific rows (everything is `region='US'`). When you start serving customers outside DFW, add `region='CA'`, `region='NE'`, etc. — the lookup already supports a region parameter and falls back to 'US'.
- Material-specific brand pricing (Sherwin-Williams paint cost vs Behr, asphalt sealer brand differences). Could be added but raises the question of how to keep prices fresh — manufacturer datasheets shift.
- Labor productivity rates (sqft/hour by trade). Useful for "how long will this take" but absent today.
- Equipment costs (rental rates, fuel surcharges).

## How the AI uses it

The prompt pattern in `/voice/price` and `/api/ai/suggest-price`:

```
Materials / application-rate reference (industry-typical, use as ground truth):
[
  {"key":"paint_coverage_per_gal","label":"...","value_low":250,"value_mid":350,"value_high":400,"unit":"sqft/gal","source":"..."},
  ...
]
```

The system prompt instructs: "When materials_kb context is provided, use those rates as ground truth instead of guessing application/coverage rates." So if a user asks for an exterior paint quote on 3,200 sqft, Q knows to compute `gallons = sqft / 350` (mid coverage), not invent a coverage rate.

## How to apply

When the user asks "how do we improve quoting accuracy" / "can the AI know about [material/rate]", the answer is usually: add a row to `materials_seed.json` with the relevant numbers and source, commit. The AI picks it up automatically on the next deploy.
