---
name: Promo asset workflow (video + hero images)
description: Where the recording infrastructure lives, how to refresh the promo video and hero satellite images, and what tools they depend on
type: reference
---

The two largest static assets in the repo are the landing-page promo video and the rotating hero-background slideshow images. Both are produced from outside-the-repo tooling so the production app stays a thin Express server.

## Promo video — `public/promo.webm`

**Pipeline location:** `C:\Users\Ross.Wearden\AppData\Local\Temp\pquote-browser-tests\`
- `record-promo.js` — Playwright script that drives /voice and /app end-to-end
- `node_modules/playwright`, `node_modules/ffmpeg-static` — dependencies
- `video-out/page@*.webm` — raw recordings before encoding

**To re-record:**
```bash
cd /tmp/pquote-browser-tests
rm -f video-out/*.webm
node record-promo.js
```
Output is auto-copied to `public/promo.webm`. Inspect with:
```bash
FFMPEG=$(node -e "console.log(require('ffmpeg-static'))")
"$FFMPEG" -i public/promo.webm 2>&1 | grep -i duration
```

**To re-encode with smoothing + section labels** (after a fresh recording):
```bash
SRC=$(ls /tmp/pquote-browser-tests/video-out/*.webm | head -1)
"$FFMPEG" -y -i "$SRC" -an \
  -vf "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,drawtext=text='VOICE QUOTE':x=(w-tw)/2:y=80:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=18:enable='between(t,1.5,5)',drawtext=text='MAP QUOTE':x=(w-tw)/2:y=80:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=18:enable='between(t,24,27.5)'" \
  -c:v libvpx-vp9 -b:v 700k -crf 32 public/promo.webm
```
Adjust the `between(t,X,Y)` ranges if section boundaries shift.

The script uses Mapbox token via `/api/config` (origin-gated — must call with `Origin: https://www.pquote.ai`). Pre-auths via `/api/auth/signup` creating `promo-<ts>@pquote-demo.example` with password `PromoDemo!2026`. Each recording adds one row; sweep with:
```sql
DELETE FROM users WHERE email LIKE 'promo-%@pquote-demo.example';
```

## Hero background images — `public/hero-bg/*.jpg`

Six satellite views of public commercial properties pulled from Mapbox Static Images API. Re-fetch them when imagery feels stale or when adding new locations.

**To regenerate (uses the same Mapbox token via `/api/config`):**
```bash
TOKEN=$(curl -s -H "Origin: https://www.pquote.ai" https://www.pquote.ai/api/config | node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ console.log(JSON.parse(s).mapboxToken); });")

# (lat, lng, zoom) — keep ALL public commercial. NEVER residential.
declare -A places=(
  [01-aac]="32.7905,-96.8103,17.3"
  [02-galleria]="32.9290,-96.8210,16.8"
  # ... etc, see existing list in commit history
)
W=1280; H=720
for name in "${!places[@]}"; do
  IFS=',' read -ra parts <<< "${places[$name]}"
  url="https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${parts[1]},${parts[0]},${parts[2]},0/${W}x${H}@2x?access_token=${TOKEN}"
  curl -s -o "public/hero-bg/${name}.jpg" "$url"
done

# Downscale + recompress to keep page weight under control
FFMPEG=$(cd /tmp/pquote-browser-tests && node -e "console.log(require('ffmpeg-static'))")
for f in public/hero-bg/*.jpg; do
  tmp="${f}.tmp.jpg"
  "$FFMPEG" -y -i "$f" -vf "scale=1600:900" -q:v 4 "$tmp"
  mv "$tmp" "$f"
done
```

**Mapbox Static API limits:** width × scale ≤ 1280 × 2 (2560px). `1600x900@2x` will return a 43-byte error JSON. Keep base size 1280x720 with `@2x`.

**Mapbox attribution:** technically required when caching their tiles as static assets. Not currently shown on the landing — flag for follow-up if/when Mapbox notices.

## When to refresh

- **Promo video:** when /voice or /app flows materially change (new step, renamed button, different end-state). Cosmetic CSS changes don't require a re-record.
- **Hero images:** rarely. Only if imagery feels stale or you want different commercial property types in rotation. Cycle interval is hardcoded to 10s in landing.html JS.
