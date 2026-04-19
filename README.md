# Electricity Usage Dashboard

Personal electricity usage dashboard for Octopus Energy (Agile tariff), deployed to GitHub Pages.

## Features

- **Live Agile prices** — half-hourly prices colour-coded by tier (negative/cheap/mid/peak)
- **Consumption vs price overlay** — see when you used electricity and what it cost
- **30-day daily cost chart** with 30-day average reference line
- **Time-of-day heatmap** — identifies cheapest and most expensive hours across the week
- **Cost analysis** — peak usage percentage and potential savings from load-shifting
- **Monthly summary** — current month spend vs previous month with projected total

## Architecture

```
GitHub Actions (every 2h)
  → Python fetches Octopus API
  → Writes public/data/*.json
  → Vite builds React app
  → Deploys to GitHub Pages
```

Data files are generated at build time and never committed to git.

## Setup

### 1. Create GitHub repository

Create a public repo named `electricity-usage` on your GitHub account.

### 2. Get your Octopus API key

Log in at [octopus.energy](https://octopus.energy) → Account → Developer settings → Generate API key.

### 3. Add GitHub Secrets

In the repo: Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `OCTOPUS_API_KEY` | Your API key (starts with `sk_`) |
| `OCTOPUS_ACCOUNT_NUMBER` | Your account number (format: `A-XXXXXXXX`) |

MPAN, meter serial, tariff code, and region are auto-discovered from your account.

### 4. Enable GitHub Pages

Settings → Pages → Source: **GitHub Actions**

### 5. Push and deploy

```bash
git remote add origin git@github.com:YOUR_USERNAME/electricity-usage.git
git push -u origin main
```

The workflow triggers automatically on push and every 2 hours thereafter.
Your dashboard will be live at `https://YOUR_USERNAME.github.io/electricity-usage/`

## Local development

### Python data fetch (requires your API key)

```bash
pip install -r scripts/requirements.txt
OCTOPUS_API_KEY=sk_... OCTOPUS_ACCOUNT_NUMBER=A-... python scripts/fetch_data.py
```

### React dev server

```bash
npm install
npm run dev
# http://localhost:5173
```

Data files from the Python fetch are served by the Vite dev server from `public/data/`.

## Phase 2 (planned)

Battery optimisation analysis: identify optimal charge/discharge windows from Agile prices, estimate savings for different battery capacities.
