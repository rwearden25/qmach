# QUOTE machine 🗺️

Satellite-based quoting tool for trades — striping, roofing, painting, sealcoating, pressure washing, and more.

**Stack:** Node.js + Express · SQLite (better-sqlite3) · Mapbox GL JS · Claude AI · Railway

---

## Local Development

```bash
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and MAPBOX_TOKEN in .env
npm run dev      # uses nodemon
```

Open http://localhost:3000

---

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USER/quote-machine.git
git push -u origin main
```

### 2. Create Railway project

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your `quote-machine` repo
3. Railway auto-detects the Dockerfile

### 3. Add a Volume (for SQLite persistence)

In Railway dashboard:
- Go to your service → **Volumes** tab
- Add volume → mount path: `/data`
- This keeps your SQLite database across deployments

### 4. Set Environment Variables

In Railway dashboard → your service → **Variables**:

```
ANTHROPIC_API_KEY=sk-ant-...
MAPBOX_TOKEN=pk.eyJ1...
```

### 5. Get your Mapbox token

1. Sign up at https://account.mapbox.com
2. Create a token — use the default public scopes
3. Copy and paste as `MAPBOX_TOKEN`

Railway will auto-deploy on every push to `main`.

---

## Features

- **Satellite imagery** via Mapbox (same imagery source as Google Maps)
- **Draw tools** — polygon, line, rectangle directly on satellite map
- **Address search** with autocomplete
- **Auto measurement** — sq ft, linear ft, sq yards, acres
- **AI pricing** — Claude suggests market-rate pricing by job type
- **AI narrative** — generates professional quote cover letter
- **AI chat** — trades assistant for pricing questions
- **Save/load** — SQLite database with full quote history
- **Print** — clean print-ready quote sheet (PDF-able)
- **Share** — SMS, email, or copy-paste quote summary
- **Screenshot** — capture map with drawn polygon
- **Stats** — revenue totals, quote counts by project type
- **Mobile-first** — designed for phones and tablets on the job

---

## Project Structure

```
quote-machine/
├── server.js           # Express server, API routes
├── db/
│   └── database.js     # SQLite init + connection
├── public/
│   ├── index.html      # Main SPA
│   ├── css/app.css     # Styles
│   └── js/app.js       # Frontend logic
├── Dockerfile
├── railway.toml
└── .env.example
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | / | Marketing landing page |
| GET | /app | Authenticated map-based quoter |
| GET | /voice | Open voice-quote flow (guest-quota'd) |
| GET | /billing | Subscription management page |
| GET | /version | Build identifier (deploy verification) |
| GET | /health | Health check |
| GET | /api/quotes | List all quotes (supports ?search=) |
| GET | /api/quotes/:id | Get single quote |
| POST | /api/quotes | Create quote |
| PUT | /api/quotes/:id | Update quote |
| DELETE | /api/quotes/:id | Delete quote |
| GET | /api/stats | Quote stats + revenue by type |
| POST | /api/ai/suggest-price | AI pricing (low/mid/high) |
| POST | /api/ai/generate-narrative | AI quote narrative |
| POST | /api/ai/chat | AI chat assistant |
| POST | /api/voice/analyze | Voice → structured quote (open, guest-capped) |
| POST | /api/voice/price | Voice quote price refinement (open, daily-capped) |
| GET | /api/config | Returns Mapbox token to frontend |
| GET | /api/billing/status | Current user's plan + status (auth) |
| POST | /api/billing/checkout | Start Stripe Checkout (auth) |
| POST | /api/billing/portal | Open Stripe Customer Portal (auth) |
| POST | /api/stripe/webhook | Stripe webhook receiver (raw body, signed) |

---

## Stripe billing

The `/billing` page and `/api/billing/*` endpoints are inert until three env
vars are set on the Railway service:

```
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
```

Setup checklist:

1. **Create a Product + recurring Price in Stripe** (Dashboard → Product catalog
   → Create product → Recurring). Copy the `price_xxx` ID into
   `STRIPE_PRICE_PRO_MONTHLY`.
2. **Add a webhook endpoint** in Stripe Dashboard → Webhooks → Add endpoint:
   - URL: `https://YOUR_HOST/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.payment_failed`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. **Enable the Customer Portal** in Stripe Dashboard → Settings → Billing →
   Customer portal (default settings are fine).
4. (Optional) Set `APP_BASE_URL=https://pquote.ai` if Stripe redirects need
   to use a different host than the inbound request.

Billing is gated to **email-registered users only** — Google OAuth and
env-configured QMACH_USERS get a clear 403 from `/api/billing/checkout`
because they have no `users` table row to hang a Stripe customer off.

Local webhook testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
then paste the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.

---

## Voice quote security

`/voice` is open to guests, so it's defended by a 6-layer token-spend stack
(IP rate limit → IP quota → cookie quota → MAX of both → daily server cap →
Anthropic console cap). Full details, env vars (`VOICE_DAILY_CAP`,
`GUEST_COOKIE_SECRET`), and verification commands:
**[docs/voice-security.md](docs/voice-security.md)**.

You should also configure a monthly spend cap at
https://console.anthropic.com/settings/limits — that's the only layer that
can't be defeated by a bug in our own code.
