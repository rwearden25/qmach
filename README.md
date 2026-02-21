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
| GET | /api/quotes | List all quotes (supports ?search=) |
| GET | /api/quotes/:id | Get single quote |
| POST | /api/quotes | Create quote |
| PUT | /api/quotes/:id | Update quote |
| DELETE | /api/quotes/:id | Delete quote |
| GET | /api/stats | Quote stats + revenue by type |
| POST | /api/ai/suggest-price | AI pricing (low/mid/high) |
| POST | /api/ai/generate-narrative | AI quote narrative |
| POST | /api/ai/chat | AI chat assistant |
| GET | /api/config | Returns Mapbox token to frontend |
| GET | /health | Health check |
