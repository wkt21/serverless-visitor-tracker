# 🚀 Serverless Visitor Tracker

**Cloudflare Workers + KV** visitor counter for GitHub profiles and READMEs.

- SVG badge (Shields-style)
- Per-profile / per-repo counters
- Country aggregation (`CF-IPCountry` when available)
- Click-through map page (real visitor IP geo)
- Zero servers, free tier friendly

---

## Why serverless?

GitHub proxies README images through Camo. A pure badge hit often sees **GitHub’s IP**, not the viewer’s. This project handles that honestly:

| Signal | Source | Accuracy |
|--------|--------|----------|
| **View count** | Every badge load | Good (each Camo fetch counts) |
| **Country on badge hit** | `CF-IPCountry` | Often GitHub/proxy region |
| **Country on map click** | Visitor’s real request to `/map` | Approximate city/country via IP |

Use the **badge for counts** and the **map link for location insight**.

---

## Quick deploy (Cloudflare)

### 1. Prerequisites

- Cloudflare account ([dash.cloudflare.com](https://dash.cloudflare.com))
- Node.js 18+
- Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace

```bash
wrangler kv namespace create VISITORS
wrangler kv namespace create VISITORS --preview
```

Copy the `id` values into `wrangler.toml`.

### 3. Configure & deploy

```bash
git clone https://github.com/wkt21/serverless-visitor-tracker.git
cd serverless-visitor-tracker
# edit wrangler.toml → set kv ids + account_id if needed
npm install
npm run deploy
```

Your worker URL will look like:

```text
https://serverless-visitor-tracker.<your-subdomain>.workers.dev
```

---

## Embed in GitHub profile README

Replace `YOUR_WORKER` with your workers.dev URL:

```markdown
### 🌍 Visitors

[![Visitors](https://YOUR_WORKER/badge?id=wkt21&label=Profile%20Views&color=00FF41&bg=0D1117)](https://YOUR_WORKER/map?id=wkt21)

<!-- Optional: JSON stats for debugging -->
<!-- https://YOUR_WORKER/stats?id=wkt21 -->
```

**Parameters for `/badge`**

| Param | Default | Description |
|-------|---------|-------------|
| `id` | required | Counter key (e.g. `wkt21` or `wkt21/repo`) |
| `label` | `visitors` | Left-side text |
| `color` | `00FF41` | Count background (hex, no `#`) |
| `bg` | `0D1117` | Label background |
| `min` | `1` | Minimum digits (zero-pad) |
| `preview` | `0` | `1` = show count without incrementing |

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/badge?id=` | GET | SVG badge; increments unless `preview=1` |
| `/hit?id=` | GET | Increment only; returns JSON `{ count }` |
| `/stats?id=` | GET | JSON: count + top countries + recent |
| `/map?id=` | GET | HTML map page; records visitor geo on load |
| `/health` | GET | Health check |

---

## Local development

```bash
npm install
npm run dev
# http://127.0.0.1:8787/badge?id=test
```

---

## Privacy

- No cookies, no fingerprinting scripts on the badge
- Map page stores **hashed IP** (daily salt) + country/city from Cloudflare headers / optional geo lookup
- Do not store raw IPs long-term (this implementation hashes them)

---

## License

MIT · WKT12 / wkt21
