/**
 * Serverless Visitor Tracker
 * Cloudflare Workers + KV
 *
 * Routes:
 *   GET /badge?id=...  → SVG badge (increments)
 *   GET /hit?id=...    → JSON increment
 *   GET /stats?id=...  → JSON stats
 *   GET /map?id=...    → HTML map + record geo
 *   GET /health
 */

const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/health") {
        return json({ ok: true, service: "serverless-visitor-tracker" });
      }
      if (path === "/badge") return await handleBadge(url, request, env);
      if (path === "/hit") return await handleHit(url, request, env);
      if (path === "/stats") return await handleStats(url, env);
      if (path === "/map") return await handleMap(url, request, env);
      if (path === "/" || path === "") {
        return json({
          service: "serverless-visitor-tracker",
          endpoints: ["/badge", "/hit", "/stats", "/map", "/health"],
          docs: "https://github.com/wkt21/serverless-visitor-tracker",
        });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function sanitizeId(raw) {
  const id = (raw || "").toString().trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_./-]+$/.test(id)) return null;
  return id;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getState(env, id) {
  const key = `v1:${id}`;
  const raw = await env.VISITORS.get(key);
  if (!raw) {
    return { count: 0, countries: {}, recent: [] };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { count: 0, countries: {}, recent: [] };
  }
}

async function saveState(env, id, state) {
  const key = `v1:${id}`;
  // Keep recent list short
  if (state.recent && state.recent.length > 50) {
    state.recent = state.recent.slice(-50);
  }
  await env.VISITORS.put(key, JSON.stringify(state));
}

function clientMeta(request) {
  const h = request.headers;
  // Cloudflare provides these on the edge
  const country = h.get("CF-IPCountry") || h.get("cf-ipcountry") || "XX";
  const city = h.get("CF-IPCity") || "";
  const ip = h.get("CF-Connecting-IP") || h.get("X-Forwarded-For")?.split(",")[0]?.trim() || "";
  return { country: country.toUpperCase(), city, ip };
}

async function increment(env, id, request, { recordGeo = false } = {}) {
  const state = await getState(env, id);
  state.count = (state.count || 0) + 1;

  const meta = clientMeta(request);
  if (meta.country && meta.country !== "XX" && meta.country !== "T1") {
    state.countries = state.countries || {};
    state.countries[meta.country] = (state.countries[meta.country] || 0) + 1;
  }

  if (recordGeo) {
    const day = new Date().toISOString().slice(0, 10);
    const hash = meta.ip ? (await sha256Hex(meta.ip + ":" + day)).slice(0, 16) : "anon";
    state.recent = state.recent || [];
    state.recent.push({
      t: new Date().toISOString(),
      country: meta.country,
      city: meta.city || undefined,
      hash,
    });
  }

  await saveState(env, id, state);
  return state;
}

async function handleHit(url, request, env) {
  const id = sanitizeId(url.searchParams.get("id") || env.DEFAULT_ID);
  if (!id) return json({ error: "invalid id" }, 400);
  const state = await increment(env, id, request, { recordGeo: false });
  return json({ id, count: state.count });
}

async function handleStats(url, env) {
  const id = sanitizeId(url.searchParams.get("id") || env.DEFAULT_ID);
  if (!id) return json({ error: "invalid id" }, 400);
  const state = await getState(env, id);
  const countries = Object.entries(state.countries || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([code, n]) => ({ code, count: n }));
  return json({
    id,
    count: state.count || 0,
    countries,
    recent: (state.recent || []).slice(-20).reverse(),
  });
}

async function handleBadge(url, request, env) {
  const id = sanitizeId(url.searchParams.get("id") || env.DEFAULT_ID);
  if (!id) return new Response("invalid id", { status: 400 });

  const preview = url.searchParams.get("preview") === "1";
  const label = (url.searchParams.get("label") || "visitors").slice(0, 32);
  const color = (url.searchParams.get("color") || "00FF41").replace(/[^0-9a-fA-F]/g, "").slice(0, 6) || "00FF41";
  const bg = (url.searchParams.get("bg") || "0D1117").replace(/[^0-9a-fA-F]/g, "").slice(0, 6) || "0D1117";
  const min = Math.min(12, Math.max(1, parseInt(url.searchParams.get("min") || "1", 10) || 1));

  let state;
  if (preview) {
    state = await getState(env, id);
  } else {
    state = await increment(env, id, request, { recordGeo: false });
  }

  const countStr = String(state.count || 0).padStart(min, "0");
  const svg = renderBadge(label, countStr, bg, color);

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
      "access-control-allow-origin": "*",
    },
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBadge(label, count, bg, color) {
  // Approximate widths (DejaVu-like)
  const charW = 7;
  const pad = 10;
  const labelW = Math.max(40, label.length * charW + pad * 2);
  const countW = Math.max(28, count.length * charW + pad * 2);
  const total = labelW + countW;
  const h = 20;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(count)}">
  <title>${escapeXml(label)}: ${escapeXml(count)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="${h}" fill="#${bg}"/>
    <rect x="${labelW}" width="${countW}" height="${h}" fill="#${color}"/>
    <rect width="${total}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${escapeXml(label)}</text>
    <text x="${labelW + countW / 2}" y="14" fill="#0D1117" font-weight="600">${escapeXml(count)}</text>
  </g>
</svg>`;
}

async function handleMap(url, request, env) {
  const id = sanitizeId(url.searchParams.get("id") || env.DEFAULT_ID);
  if (!id) return new Response("invalid id", { status: 400 });

  // Record real visitor (browser hit, not Camo)
  const state = await increment(env, id, request, { recordGeo: true });
  const countries = Object.entries(state.countries || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  const recent = (state.recent || []).slice(-15).reverse();

  const countryRows = countries
    .map(([code, n]) => `<tr><td>${escapeXml(code)}</td><td>${n}</td></tr>`)
    .join("") || "<tr><td colspan=2>No data yet</td></tr>";

  const recentRows = recent
    .map(
      (r) =>
        `<tr><td>${escapeXml(r.t || "")}</td><td>${escapeXml(r.country || "")}</td><td>${escapeXml(r.city || "—")}</td></tr>`
    )
    .join("") || "<tr><td colspan=3>No map visits yet</td></tr>";

  // Simple visual: CSS-based bar list (no external map API keys required)
  const maxC = countries.length ? countries[0][1] : 1;
  const bars = countries
    .map(([code, n]) => {
      const pct = Math.max(4, Math.round((n / maxC) * 100));
      return `<div class="bar"><span class="code">${escapeXml(code)}</span><span class="track"><i style="width:${pct}%"></i></span><span class="n">${n}</span></div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Visitors · ${escapeXml(id)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#00ff41; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); padding:2rem 1rem; }
    main { max-width:720px; margin:0 auto; }
    h1 { font-size:1.4rem; margin:0 0 .25rem; }
    .sub { color:var(--muted); margin-bottom:1.5rem; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:1.25rem; margin-bottom:1rem; }
    .count { font-size:2.5rem; font-weight:700; color:var(--accent); font-variant-numeric: tabular-nums; }
    .bar { display:grid; grid-template-columns: 48px 1fr 40px; gap:.5rem; align-items:center; margin:.35rem 0; font-size:.9rem; }
    .track { background:#21262d; border-radius:4px; height:10px; overflow:hidden; }
    .track i { display:block; height:100%; background:var(--accent); border-radius:4px; }
    .code { font-family: ui-monospace, monospace; color:var(--muted); }
    .n { text-align:right; font-variant-numeric: tabular-nums; }
    table { width:100%; border-collapse: collapse; font-size:.85rem; }
    th, td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--border); }
    th { color:var(--muted); font-weight:500; }
    footer { margin-top:2rem; color:var(--muted); font-size:.8rem; }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>🌍 Visitor map</h1>
    <p class="sub">Counter <code>${escapeXml(id)}</code> · recorded on this page load (real client, not GitHub Camo)</p>

    <div class="card">
      <div class="count">${state.count || 0}</div>
      <div class="sub">total hits (badge + map)</div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1rem">Countries</h2>
      ${bars || "<p class=sub>No country data yet</p>"}
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1rem">Recent map visits</h2>
      <table>
        <thead><tr><th>Time (UTC)</th><th>Country</th><th>City</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1rem">Country totals</h2>
      <table>
        <thead><tr><th>Code</th><th>Hits</th></tr></thead>
        <tbody>${countryRows}</tbody>
      </table>
    </div>

    <footer>
      Powered by <a href="https://github.com/wkt21/serverless-visitor-tracker">serverless-visitor-tracker</a>
      · IPs hashed daily · Approximate geo via edge headers
    </footer>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
