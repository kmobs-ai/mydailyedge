"use strict";

// =========================
// Lightweight error reporter — POSTs uncaught exceptions to api/log.php.
// Per-session capped at 5 reports so a single broken loop doesn't spam.
// =========================
const APP_VERSION = "0.4.5";
let _errorReportCount = 0;
function reportFrontendError(kind, message, extras = {}) {
  if (_errorReportCount >= 5) return;
  _errorReportCount++;
  try {
    const payload = JSON.stringify({
      kind, message,
      source: extras.source || "",
      line: extras.line || 0,
      col: extras.col || 0,
      stack: extras.stack || "",
      url: location.href,
      userAgent: navigator.userAgent || "",
      v: APP_VERSION,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("api/log.php", new Blob([payload], { type: "application/json" }));
    } else {
      fetch("api/log.php", { method: "POST", body: payload, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
    }
  } catch {}
}
window.addEventListener("error", (e) => {
  reportFrontendError("error", String(e.message || ""), { source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason || {};
  reportFrontendError("unhandled-rejection", reason.message || String(reason), { stack: reason.stack });
});


const STORE_KEY = "dailyedge.v1";
const API_BASE = "api";
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const money = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = value => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));
// DEMO_SYMBOLS / DEMO_CLEANUP_VERSION / DEFAULT_PROFILE all live in lib/portfolio-math.js
// — that script must be loaded BEFORE app.js (see index.html). One source of truth.
const DEMO_SYMBOLS = PortfolioMath.DEMO_SYMBOLS;
const DEMO_CLEANUP_VERSION = PortfolioMath.DEMO_CLEANUP_VERSION;
const CHART_RANGES = [["24h","24H"],["7d","7D"],["1m","1M"],["6m","6M"],["ytd","YTD"],["all","ALL"]];
const DEFAULT_PROFILE = PortfolioMath.DEFAULT_PROFILE;

const seedState = {
  selectedSymbol: null, selectedTaskId: null, selectedSnapshotId: null,
  taskFilter: "all", newsFilter: "all", alertFilter: "active",
  chartMode: "asset", chartRange: "1m", chartStyle: "area", overviewRange: "90d", overviewBenchmarks: [],
  apiKey: "", assets: [], trades: [], tasks: [], news: [], snapshots: [], priceHistory: {},
  profile: { ...DEFAULT_PROFILE }, demoCleanupVersion: DEMO_CLEANUP_VERSION
};

let state = loadState();
let auth = { checked: false, configured: false, authenticated: false, registrationOpen: false, marketDataConfigured: false, marketDataProvider: "", newsDataConfigured: false, user: null, error: "", csrfToken: "" };
let serverStateVersion = 0;
let pushState = { supported: false, permission: 'default', subscribed: false, vapidPublicKey: '', subscriptions: [] };
let pendingConflict = null;
let syncTimer = null;
let suppressSync = false;

function addDays(dateString, days) { const d = new Date(`${dateString}T00:00:00`); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function loadState() { const stored = localStorage.getItem(STORE_KEY); if (!stored) return structuredClone(seedState); try { return migrateState({ ...structuredClone(seedState), ...JSON.parse(stored) }); } catch { return structuredClone(seedState); } }

// migrateState / removeDemoData live in lib/portfolio-math.js — wrappers here for callsite compatibility.
function migrateState(nextState) { return PortfolioMath.migrateState(nextState); }
function removeDemoData(nextState) { return PortfolioMath.removeDemoData(nextState); }

function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); scheduleServerSave(); }

async function apiRequest(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  // Attach CSRF token on any mutating verb when we have one
  if (method !== "GET" && auth.csrfToken && !headers["X-CSRF-Token"]) {
    headers["X-CSRF-Token"] = auth.csrfToken;
  }
  const response = await fetch(`${API_BASE}/${path}`, { credentials: "same-origin", headers, ...options, method });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.data = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

function scheduleServerSave() { if (suppressSync || !auth.configured || !auth.authenticated) return; clearTimeout(syncTimer); syncTimer = setTimeout(saveServerState, 700); }
// Serial queue for state-saves. Each save waits for any in-flight save to finish
// before reading serverStateVersion, which prevents the classic optimistic-concurrency
// race where two saves capture the same stale version concurrently and the second
// gets a 409. With this queue, single-tab activity never sees a 409 — the only
// remaining 409 is a real multi-device conflict (e.g. another tab/device saved).
let _syncQueue = Promise.resolve();
let _consecutive409Count = 0;

function saveServerState(force = false) {
  // Defer the actual save behind any prior in-flight save in the queue.
  const task = _syncQueue.then(async () => {
    if (!auth.configured || !auth.authenticated) return;
    try {
      // versionToSend is read HERE (after the prior save finished) so it sees the
      // most recent version returned by the server.
      const versionToSend = force ? "force" : serverStateVersion;
      const result = await apiRequest("state.php", {
        method: "PUT",
        body: JSON.stringify({ state, version: versionToSend })
      });
      if (typeof result.version === "number") serverStateVersion = result.version;
      _consecutive409Count = 0;
      pendingConflict = null;
      renderConflictBanner();
      setAuthMessage("Synced to MySQL.");
    } catch (e) {
      if (e.status === 409 && e.data) {
        // Real conflict — another tab/device pushed a newer version. First couple of
        // times, auto-resolve by refreshing our view of the server version and
        // retrying once with that fresh number (covers any straggler race we missed).
        // If it keeps happening, surface the banner so the user can decide.
        _consecutive409Count++;
        const incomingServerVersion = e.data.serverVersion ?? 0;
        if (_consecutive409Count <= 1 && Number.isFinite(incomingServerVersion)) {
          console.warn(`[sync] transient 409 (server v${incomingServerVersion}, client v${e.data.clientVersion ?? "?"}). Refreshing version and retrying.`);
          serverStateVersion = incomingServerVersion;
          // Retry immediately — but go through the queue so we don't stack races.
          saveServerState(false);
          return;
        }
        pendingConflict = {
          serverVersion: incomingServerVersion,
          clientVersion: e.data.clientVersion ?? serverStateVersion,
          message: e.message
        };
        renderConflictBanner();
        setAuthMessage(e.message);
        return;
      }
      setAuthMessage(e.message);
    }
  });
  // Swallow rejections so a single error doesn't break the chain for subsequent saves.
  _syncQueue = task.catch(() => {});
  return task;
}
async function loadServerState() {
  const r = await apiRequest("state.php");
  if (typeof r.version === "number") serverStateVersion = r.version;
  if (r.state) {
    suppressSync = true;
    state = migrateState({ ...structuredClone(seedState), ...r.state });
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    suppressSync = false;
  } else {
    await saveServerState();
  }
  pendingConflict = null;
  renderConflictBanner();
}

async function refreshAuthStatus() {
  try { const r = await apiRequest("status.php"); auth = { checked: true, configured: Boolean(r.configured), authenticated: Boolean(r.authenticated), registrationOpen: Boolean(r.registrationOpen), marketDataConfigured: Boolean(r.marketDataConfigured), marketDataProvider: r.marketDataProvider || "", newsDataConfigured: Boolean(r.newsDataConfigured), user: r.user || null, error: "", csrfToken: r.csrfToken || "", isAdmin: Boolean(r.isAdmin) }; }
  catch (e) { auth = { checked: true, configured: Boolean(e.data?.configured), authenticated: false, registrationOpen: false, marketDataConfigured: false, marketDataProvider: "", newsDataConfigured: false, user: null, error: e.message, csrfToken: "", isAdmin: false }; }
}

function setAuthMessage(msg) { const n = document.getElementById("authMessage"); if (n) n.textContent = msg || ""; }
function setAssetLookupStatus(msg, tone = "") { const n = document.getElementById("assetLookupStatus"); if (!n) return; n.textContent = msg; n.classList.toggle("green", tone === "green"); n.classList.toggle("red", tone === "red"); }

function updateAuthGate() {
  const gate = document.getElementById("authGate"); if (!gate) return;
  if (auth.configured && !auth.authenticated) { gate.hidden = false; document.getElementById("showRegisterBtn").hidden = !auth.registrationOpen; setAuthMessage(auth.error || (auth.registrationOpen ? "Use your account, or create the first private account for this install." : "Registration is closed. Sign in with the existing account.")); }
  else { gate.hidden = true; }
}

function getAsset(symbol = state.selectedSymbol) { return state.assets.find(a => a.symbol === symbol) || state.assets[0]; }
function getTrades(symbol) { if (!symbol) return []; return state.trades.filter(t => t.symbol === symbol); }
function formatQuantity(value, type) { return Number(value || 0).toFixed(type === "crypto" ? 5 : 2); }
function averageCost(pos) { return pos?.quantity ? pos.cost / pos.quantity : Number(pos?.price || 0); }

// Pure math lives in lib/portfolio-math.js (tested by tests/portfolio-math.test.js).
// These wrappers pass current `state.trades` / `state.assets` so callers stay unchanged.
function buildLots(symbol) { return PortfolioMath.buildLotsFromTrades(state.trades, symbol); }
function positionFor(asset) { return PortfolioMath.positionForAsset(asset, state.trades); }
function portfolio() { return PortfolioMath.portfolioFromState(state); }
function estimateTax(params) { return PortfolioMath.estimateTaxFromTrades(params, state.trades); }

function render() { saveState(); renderClock(); renderTopState(); updateAuthGate(); renderOverview(); renderPortfolio(); renderTasks(); renderIntel(); renderHistory(); renderProfile(); renderInvitations(); renderAlerts(); renderPushStatus(); renderUserChip(); hydrateSelects(); renderConflictBanner(); renderAlertBanner(); }
function renderClock() { document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); document.getElementById("overviewTitle").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }); }

function renderTopState() {
  // The user chip handles auth visuals now; this stays as a no-op stub for callers.
}



// =========================
// Tiny SVG visualizations
// =========================

/**
 * Render a small inline sparkline into an SVG element.
 * @param {SVGElement} svg     the <svg> node to populate
 * @param {Array<number|{value,label,date}>} data ordered oldest-to-newest values
 * @param {string} color       stroke color (also used for fill at low opacity)
 * @param {Object} opts        { format?: fn for tooltip value }
 */
function renderSparkline(svg, data, color, opts = {}) {
  if (!svg) return;
  const raw = (data || []).map(d => (typeof d === "object" && d !== null) ? d : { value: d });
  const points = raw.filter(d => Number.isFinite(d.value));
  if (points.length < 2) { svg.innerHTML = ""; svg.removeAttribute("data-spark"); return; }
  const w = 100, h = 28;
  const values = points.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (points.length - 1);
  const coords = points.map((p, i) => [i * stepX, h - 2 - ((p.value - min) / range) * (h - 4)]);
  const line = coords.map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`)).join("");
  const area = `${line} L${w},${h} L0,${h} Z`;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = `
    <path d="${area}" fill="${color}" opacity="0.18"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"></path>
    <circle class="spark-hover-marker" cx="0" cy="0" r="0" style="display:none"></circle>`;
  // Stash data + colors so the tooltip handler can reconstruct values per cursor position
  svg.__sparkData = points;
  svg.__sparkColor = color;
  svg.__sparkFormat = opts.format || (v => Number(v || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  if (!svg.__sparkBound) {
    svg.addEventListener("mousemove", handleSparkHover);
    svg.addEventListener("mouseleave", hideSparkTooltip);
    svg.addEventListener("touchstart", handleSparkHover, { passive: true });
    svg.addEventListener("touchmove", handleSparkHover, { passive: true });
    svg.addEventListener("touchend", hideSparkTooltip);
    svg.__sparkBound = true;
  }
}

let _sparkTooltipEl = null;
function ensureSparkTooltip() {
  if (_sparkTooltipEl) return _sparkTooltipEl;
  const tip = document.createElement("div");
  tip.className = "spark-tooltip";
  tip.innerHTML = `<div class="spark-tooltip-date"></div><div class="spark-tooltip-value"></div>`;
  document.body.appendChild(tip);
  _sparkTooltipEl = tip;
  return tip;
}
function handleSparkHover(event) {
  const svg = event.currentTarget;
  const data = svg.__sparkData;
  if (!data || data.length < 2) return;
  const rect = svg.getBoundingClientRect();
  const ev = event.touches && event.touches[0] ? event.touches[0] : event;
  const xRatio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const idx = Math.round(xRatio * (data.length - 1));
  const point = data[idx];
  if (!point) return;
  const tip = ensureSparkTooltip();
  const formatFn = svg.__sparkFormat || (v => v);
  tip.querySelector(".spark-tooltip-date").textContent = point.label || point.date || "";
  tip.querySelector(".spark-tooltip-value").textContent = formatFn(point.value);
  // Position the tip just above the cursor
  tip.style.left = `${ev.clientX}px`;
  tip.style.top = `${rect.top - 4}px`;
  tip.classList.add("visible");

  // Marker dot follows the hovered data point
  const marker = svg.querySelector(".spark-hover-marker");
  if (marker) {
    const w = 100, h = 28;
    const values = data.map(p => p.value);
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const cx = idx * (w / (data.length - 1));
    const cy = h - 2 - ((point.value - min) / range) * (h - 4);
    marker.setAttribute("cx", cx.toFixed(2));
    marker.setAttribute("cy", cy.toFixed(2));
    marker.setAttribute("r", "2.2");
    marker.style.display = "";
  }
}
function hideSparkTooltip(event) {
  if (_sparkTooltipEl) _sparkTooltipEl.classList.remove("visible");
  const marker = event && event.currentTarget && event.currentTarget.querySelector && event.currentTarget.querySelector(".spark-hover-marker");
  if (marker) marker.style.display = "none";
}

/**
 * Render a donut chart. Segments share radius; values are summed for percentages.
 * @param {Element} container target div
 * @param {Array<{label, value, color}>} segments
 * @param {Object} opts { size?: 120, thickness?: 14, centerLabel?, centerSub? }
 */
function renderDonut(container, segments, opts = {}) {
  if (!container) return;
  const size = opts.size || 120;
  const thickness = opts.thickness || 14;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const total = segments.reduce((s, x) => s + Math.max(0, Number(x.value) || 0), 0);
  if (!total) {
    container.innerHTML = `<div class="donut-empty" style="width:${size}px;height:${size}px;border:${thickness}px solid var(--line2);border-radius:50%;"></div>`;
    return;
  }
  const C = 2 * Math.PI * r;
  const arcs = [];
  let cumulative = 0;
  for (const seg of segments) {
    const v = Math.max(0, Number(seg.value) || 0);
    const len = (v / total) * C;
    arcs.push({ color: seg.color, len, offset: cumulative });
    cumulative += len;
  }
  const centerLabelHTML = opts.centerLabel ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-center">${opts.centerLabel}</text>` : "";
  const centerSubHTML = opts.centerSub ? `<text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-center-sub">${opts.centerSub}</text>` : "";

  // Render with each arc starting at zero length; then in the next frame set the real lengths so
  // the CSS transition on stroke-dasharray animates the sweep in.
  container.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut-svg">
    ${arcs.map(a => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${a.color}" stroke-width="${thickness}" stroke-dasharray="0 ${C.toFixed(2)}" stroke-dashoffset="${(-a.offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`).join("")}
    ${centerLabelHTML}${centerSubHTML}
  </svg>`;
  requestAnimationFrame(() => {
    const circles = container.querySelectorAll("svg.donut-svg circle");
    arcs.forEach((a, i) => {
      const c = circles[i];
      if (c) c.setAttribute("stroke-dasharray", `${a.len.toFixed(2)} ${(C - a.len).toFixed(2)}`);
    });
  });
}

function renderHeroSparklines(port) {
  // Pull series from server-side snapshotsCache. Ordered oldest → newest.
  const snaps = (snapshotsCache && snapshotsCache.length ? snapshotsCache : state.snapshots || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const today = todayISO();
  const valueSeries  = snaps.map(s => ({ date: s.date, value: Number(s.portfolio?.value || 0) }));
  const gainSeries   = snaps.map(s => ({ date: s.date, value: Number(s.portfolio?.gain || 0) }));
  // Always include today's live values as the last point so the spark visually catches the latest move.
  valueSeries.push({ date: today, value: port.value });
  gainSeries.push({ date: today, value: port.gain });

  const accent = "#e8d5b0";
  const upGreen = "#67aa7d";
  const dnRed = "#c95c50";
  renderSparkline(document.getElementById("sparkValue"), valueSeries, accent);
  renderSparkline(document.getElementById("sparkInvested"), gainSeries, port.gain >= 0 ? upGreen : dnRed);
}

function renderAllocation(port) {
  const container = document.getElementById("allocationDonut");
  const legend = document.getElementById("allocationLegend");
  const classLegend = document.getElementById("allocationClassLine");
  if (!container) return;

  const positions = port.positions.filter(p => p.value > 0).sort((a, b) => b.value - a.value);
  if (!positions.length) {
    container.innerHTML = empty("No positions yet");
    if (legend) legend.innerHTML = "";
    if (classLegend) classLegend.innerHTML = "";
    return;
  }

  const topN = 5;
  const top = positions.slice(0, topN);
  const otherValue = positions.slice(topN).reduce((s, p) => s + p.value, 0);
  const segments = top.map(p => ({ label: p.symbol, value: p.value, color: p.color || "#e8d5b0" }));
  if (otherValue > 0) segments.push({ label: "Other", value: otherValue, color: "#5f5e5a" });

  const total = port.value || segments.reduce((s, x) => s + x.value, 0);
  renderDonut(container, segments, {
    size: 130,
    thickness: 16,
    centerLabel: money(total),
    centerSub: `${positions.length} holdings`,
  });

  if (legend) {
    legend.innerHTML = segments.map(s => `
      <div class="allocation-legend-row">
        <span class="allocation-swatch" style="background:${s.color}"></span>
        <span class="allocation-label">${s.label}</span>
        <span class="allocation-pct mono">${total ? ((s.value / total) * 100).toFixed(1) : "0.0"}%</span>
      </div>`).join("");
  }

  // Asset-class one-liner: e.g. "Crypto 85.1% · Stocks 14.9%"
  if (classLegend) {
    const byClass = {};
    for (const p of positions) {
      const k = (p.type || "other").toLowerCase();
      byClass[k] = (byClass[k] || 0) + p.value;
    }
    const order = Object.entries(byClass).sort((a, b) => b[1] - a[1]);
    classLegend.innerHTML = order.map(([cls, val]) => `<span><strong>${cls.charAt(0).toUpperCase() + cls.slice(1)}</strong> ${total ? ((val / total) * 100).toFixed(1) : "0.0"}%</span>`).join(" · ");
  }
}



// Benchmark price series (SPY, BTC) — lazy-fetched from server, cached client-side per range.
const benchmarkCache = {}; // { "90d|SPY,BTC": { SPY: [...], BTC: [...] } }
async function loadBenchmarks(range, symbols) {
  if (!auth.configured || !auth.authenticated) return {};
  if (!symbols || !symbols.length) return {};
  const sortedSyms = symbols.slice().sort().join(",");
  const key = `${range}|${sortedSyms}`;
  if (benchmarkCache[key]) return benchmarkCache[key];
  try {
    const r = await apiRequest(`benchmarks.php?range=${encodeURIComponent(range)}&symbols=${encodeURIComponent(sortedSyms)}`);
    benchmarkCache[key] = r.series || {};
    return benchmarkCache[key];
  } catch (e) {
    console.warn("[benchmarks] fetch failed:", e.message);
    return {};
  }
}

const BENCHMARK_COLORS = { SPY: "#6c9dcc", BTC: "#e8d5b0", ETH: "#9c82ce" };

// =========================
// Overview performance chart (TradingView Lightweight Charts)
// =========================
const overviewChartState = { instance: null, series: null, benchmarkSeries: {}, resizeObserver: null, lastKey: null };

function destroyOverviewChart() {
  if (overviewChartState.resizeObserver) {
    try { overviewChartState.resizeObserver.disconnect(); } catch {}
    overviewChartState.resizeObserver = null;
  }
  if (overviewChartState.instance) {
    try { overviewChartState.instance.remove(); } catch {}
    overviewChartState.instance = null;
    overviewChartState.series = null;
    overviewChartState.benchmarkSeries = {};
  }
}

function filterSnapshotsByRange(snaps, range) {
  if (!snaps || !snaps.length) return [];
  const sorted = snaps.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (range === "all") return sorted;
  const today = new Date();
  let from;
  if (range === "7d")        { from = new Date(today); from.setDate(from.getDate() - 7); }
  else if (range === "30d")  { from = new Date(today); from.setDate(from.getDate() - 30); }
  else if (range === "ytd")  { from = new Date(today.getFullYear(), 0, 1); }
  else                        { from = new Date(today); from.setDate(from.getDate() - 90); }
  const cutoff = from.toISOString().slice(0, 10);
  return sorted.filter(s => String(s.date) >= cutoff);
}

async function renderOverviewPerformance(port) {
  const container = document.getElementById("overviewPerfChart");
  const empty = document.getElementById("overviewPerfEmpty");
  const summary = document.getElementById("overviewPerfSummary");
  if (!container) return;

  document.querySelectorAll("[data-overview-range]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.overviewRange === (state.overviewRange || "90d"));
  });
  const activeBenchmarks = (state.overviewBenchmarks || []).slice();
  document.querySelectorAll("[data-benchmark]").forEach(btn => {
    btn.classList.toggle("active", activeBenchmarks.includes(btn.dataset.benchmark));
  });
  const normalize = activeBenchmarks.length > 0;

  const snaps = (snapshotsCache && snapshotsCache.length ? snapshotsCache : state.snapshots || []);
  const filtered = filterSnapshotsByRange(snaps, state.overviewRange || "90d");
  const todayIso = todayISO();
  const portPoints = filtered
    .filter(s => Number.isFinite(Number(s.portfolio?.value)))
    .map(s => ({ time: Math.floor(new Date(`${s.date}T16:00:00Z`).getTime() / 1000), value: Number(s.portfolio.value) }));
  const dedup = new Map();
  for (const p of portPoints) dedup.set(p.time, p.value);
  const liveTime = Math.floor(new Date(`${todayIso}T16:00:00Z`).getTime() / 1000);
  if (!dedup.has(liveTime) && Number.isFinite(port.value)) dedup.set(liveTime, port.value);
  let series = [...dedup.entries()].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);

  if (series.length < 2) {
    destroyOverviewChart();
    container.innerHTML = "";
    if (empty) { empty.hidden = false; empty.textContent = snaps.length ? "Not enough data in this range — pick a wider window or wait for tomorrow's snapshot." : "Snapshots will populate this chart once you've used the app for at least two distinct days."; }
    if (summary) summary.innerHTML = "";
    return;
  }
  if (empty) empty.hidden = true;

  const startVal = series[0].value;
  const endVal = series[series.length - 1].value;
  const move = endVal - startVal;
  const movePct = startVal ? (move / startVal) * 100 : 0;

  // Fetch benchmark series if needed
  let benchmarkSeries = {};
  if (activeBenchmarks.length) {
    benchmarkSeries = await loadBenchmarks(state.overviewRange || "90d", activeBenchmarks);
  }

  // Build summary header — show portfolio + each active benchmark's % move
  const summaryParts = [`<span class="perf-stat ${move >= 0 ? "up" : "dn"}"><strong>${money(move)} ${pct(movePct)}</strong></span>`];
  const benchPctForSummary = {};
  for (const sym of activeBenchmarks) {
    const data = benchmarkSeries[sym] || [];
    if (data.length < 2) continue;
    const startB = data[0].close;
    const endB = data[data.length - 1].close;
    if (!startB) continue;
    const pctB = ((endB - startB) / startB) * 100;
    benchPctForSummary[sym] = pctB;
    summaryParts.push(`<span class="perf-stat ${pctB >= 0 ? "up" : "dn"}">${sym} <strong>${pct(pctB)}</strong></span>`);
  }
  if (summary) {
    summary.classList.remove("up", "dn");
    summary.innerHTML = `<span class="overview-perf-summary-row">${summaryParts.join("")}</span>`;
  }

  if (typeof window.LightweightCharts === "undefined") {
    container.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#6b6b7b;font-family:DM Mono,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Loading chart engine…</div>`;
    setTimeout(() => renderOverviewPerformance(port), 250);
    return;
  }

  // The chart's measurement unit changes when normalizing — fully rebuild if mode flipped.
  const mode = normalize ? "norm" : "dollars";
  if (overviewChartState.lastKey !== mode) {
    destroyOverviewChart();
    overviewChartState.lastKey = mode;
  }

  if (!overviewChartState.instance) {
    container.innerHTML = "";
    const LWC = window.LightweightCharts;
    const inst = LWC.createChart(container, {
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#9b9baa", fontFamily: "DM Mono, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(40,40,47,.45)" }, horzLines: { color: "rgba(40,40,47,.45)" } },
      rightPriceScale: { borderColor: "#1e1e25", scaleMargins: { top: 0.16, bottom: 0.08 } },
      timeScale: { borderColor: "#1e1e25", timeVisible: false, secondsVisible: false, rightOffset: 2, barSpacing: 8 },
      crosshair: { mode: 1, vertLine: { color: "rgba(232,213,176,.4)", width: 1, style: 2, labelBackgroundColor: "#e8d5b0" }, horzLine: { color: "rgba(232,213,176,.4)", width: 1, style: 2, labelBackgroundColor: "#e8d5b0" } },
      handleScale: { axisPressedMouseMove: true, mouseWheel: false, pinch: true },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      autoSize: true,
    });
    overviewChartState.instance = inst;
    if (normalize) {
      overviewChartState.series = inst.addLineSeries({
        color: "#e8d5b0",
        lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      });
    } else {
      overviewChartState.series = inst.addAreaSeries({
        topColor: "rgba(232,213,176,.32)",
        bottomColor: "rgba(232,213,176,0)",
        lineColor: "#e8d5b0",
        lineWidth: 2,
        priceFormat: { type: "price", precision: 0, minMove: 1 },
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      });
    }
    overviewChartState.benchmarkSeries = {};
    if (typeof ResizeObserver !== "undefined") {
      overviewChartState.resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (overviewChartState.instance) overviewChartState.instance.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
        }
      });
      overviewChartState.resizeObserver.observe(container);
    }
  }

  // Update portfolio series (normalized or absolute)
  try {
    let data = series;
    if (normalize) {
      const base = series[0].value || 1;
      data = series.map(p => ({ time: p.time, value: +(100 * p.value / base).toFixed(3) }));
    }
    overviewChartState.series.setData(data);

    // Remove benchmark series that are no longer active
    for (const sym of Object.keys(overviewChartState.benchmarkSeries)) {
      if (!activeBenchmarks.includes(sym)) {
        try { overviewChartState.instance.removeSeries(overviewChartState.benchmarkSeries[sym]); } catch {}
        delete overviewChartState.benchmarkSeries[sym];
      }
    }

    // Add / update benchmark series. Each is a dashed line in its color.
    for (const sym of activeBenchmarks) {
      const raw = benchmarkSeries[sym] || [];
      if (raw.length < 2) continue;
      // Clamp benchmark dates to the portfolio window so they line up visually
      const portStart = series[0].time;
      const portEnd = series[series.length - 1].time;
      const points = raw
        .map(r => ({ time: Math.floor(new Date(`${r.date}T16:00:00Z`).getTime() / 1000), value: r.close }))
        .filter(p => p.time >= portStart - 86400 && p.time <= portEnd + 86400);
      if (points.length < 2) continue;
      const base = points[0].value || 1;
      const normData = points.map(p => ({ time: p.time, value: +(100 * p.value / base).toFixed(3) }));

      if (!overviewChartState.benchmarkSeries[sym]) {
        overviewChartState.benchmarkSeries[sym] = overviewChartState.instance.addLineSeries({
          color: BENCHMARK_COLORS[sym] || "#6c9dcc",
          lineWidth: 1.5,
          lineStyle: 2,  // dashed
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
      }
      overviewChartState.benchmarkSeries[sym].setData(normData);
    }

    overviewChartState.instance.timeScale().fitContent();
  } catch (e) {
    console.warn("[overview-perf] setData failed", e);
  }
}


// =========================
// Position heatmap (squarified treemap)
// =========================
// squarifyTreemap lives in lib/portfolio-math.js — wrapper preserves the old call signature.
function squarifyTreemap(items, w, h) { return PortfolioMath.squarifyTreemap(items, w, h); }

function heatmapColor(pct, maxAbs) {
  if (!Number.isFinite(pct) || maxAbs <= 0) return "rgba(40,40,47,0.6)";
  const intensity = Math.min(1, Math.abs(pct) / maxAbs);
  const opacity = 0.18 + intensity * 0.62; // 0.18 → 0.80
  return pct >= 0
    ? `rgba(103,170,125,${opacity.toFixed(3)})`
    : `rgba(201,92,80,${opacity.toFixed(3)})`;
}

function renderHeatmap(port) {
  const canvas = document.getElementById("overviewHeatmap");
  if (!canvas) return;
  const positions = (port.positions || []).filter(p => p.value > 0 && p.quantity > 0);
  if (!positions.length) {
    canvas.classList.remove("heatmap-list");
    canvas.innerHTML = `<div class="heatmap-empty">No positions yet</div>`;
    return;
  }

  // Roll everything below the top N into a single "Other +X" tile for legibility.
  const TOP_N = 8;
  const sorted = positions.slice().sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, TOP_N);
  const overflow = sorted.slice(TOP_N);
  let items = top.map(p => ({ value: p.value, symbol: p.symbol, pct: Number(p.dayChangePct) || 0, name: p.name || p.symbol }));
  if (overflow.length) {
    const otherValue = overflow.reduce((s, p) => s + p.value, 0);
    // Value-weighted average % change for the "Other" bucket
    const weightedPct = overflow.reduce((s, p) => s + (Number(p.dayChangePct) || 0) * p.value, 0) / (otherValue || 1);
    items.push({ value: otherValue, symbol: `Other +${overflow.length}`, pct: weightedPct, name: `${overflow.length} smaller positions` });
  }

  // Mobile: render as a vertical list of horizontal bars instead of a treemap.
  if (window.innerWidth <= 780) {
    canvas.classList.add("heatmap-list");
    const maxAbs = Math.max(...items.map(i => Math.abs(i.pct))) || 1;
    canvas.innerHTML = items.map(it => {
      const tone = it.pct >= 0 ? "up" : "dn";
      const fill = Math.max(2, Math.min(50, (Math.abs(it.pct) / maxAbs) * 50));
      const pctLabel = `${it.pct >= 0 ? "+" : ""}${it.pct.toFixed(2)}%`;
      return `<div class="heatmap-tile size-sm" data-select-asset="${it.symbol.startsWith("Other") ? "" : it.symbol}" title="${it.symbol} · ${money(it.value)} · ${pctLabel} today">
        <span class="heatmap-ticker">${it.symbol}</span>
        <span class="heatmap-bar-track">
          <span class="heatmap-bar-fill" style="width:${fill.toFixed(1)}%;background:${heatmapColor(it.pct, maxAbs)}"></span>
        </span>
        <span class="heatmap-pct ${tone}">${pctLabel}</span>
      </div>`;
    }).join("");
    return;
  }
  canvas.classList.remove("heatmap-list");

  // Desktop: squarified treemap
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(0, Math.floor(rect.width));
  const h = Math.max(0, Math.floor(rect.height));
  if (w < 40 || h < 40) { setTimeout(() => renderHeatmap(port), 80); return; }

  const tiles = squarifyTreemap(items, w, h);
  const maxAbs = Math.max(...items.map(i => Math.abs(i.pct))) || 1;

  canvas.innerHTML = tiles.map(t => {
    if (!t || t.w < 4 || t.h < 4) return "";
    const area = t.w * t.h;
    const size = area > 9000 ? "size-lg" : (area > 3000 ? "size-md" : "size-sm");
    const showPct = t.w >= 56 && t.h >= 32;
    const showTicker = t.w >= 30 && t.h >= 18;
    const pctLabel = `${t.item.pct >= 0 ? "+" : ""}${t.item.pct.toFixed(2)}%`;
    const isOther = t.item.symbol.startsWith("Other");
    return `<div class="heatmap-tile ${size}"
                 ${isOther ? "" : `data-select-asset="${t.item.symbol}"`}
                 title="${t.item.symbol} · ${money(t.item.value)} · ${pctLabel} today"
                 style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${t.w.toFixed(1)}px;height:${t.h.toFixed(1)}px;background:${heatmapColor(t.item.pct, maxAbs)}">
              ${showTicker ? `<span class="heatmap-ticker">${t.item.symbol}</span>` : ""}
              ${showPct ? `<span class="heatmap-pct">${pctLabel}</span>` : ""}
            </div>`;
  }).join("");
}

// Re-render on resize since the layout depends on the canvas pixel size.
let _heatmapResizeBound = false;

function exportOverviewPerfChart() {
  if (!overviewChartState.instance) {
    alert("Chart isn't ready yet. Wait a moment and try again.");
    return;
  }
  try {
    const canvas = overviewChartState.instance.takeScreenshot();
    canvas.toBlob(blob => {
      if (!blob) { alert("Couldn't generate the image."); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mydailyedge-performance-${todayISO()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  } catch (e) {
    console.warn("[export] failed", e);
    alert(`Couldn't export the chart: ${e.message}`);
  }
}

function bindHeatmapResize() {
  if (_heatmapResizeBound) return;
  _heatmapResizeBound = true;
  let raf = 0;
  window.addEventListener("resize", () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { try { renderHeatmap(portfolio()); } catch {} });
  });
}

function renderMovers(positions) {
  // Use Number.isFinite + a permissive filter — even tiny moves are interesting,
  // and exact-zero is rare unless the asset has no previousClose set.
  const ranked = positions
    .filter(p => p.quantity > 0 && Number.isFinite(p.dayChangePct))
    .slice()
    .sort((a, b) => b.dayChangePct - a.dayChangePct);
  const winners = ranked.filter(p => p.dayChangePct > 0).slice(0, 3);
  const losers  = ranked.filter(p => p.dayChangePct < 0).slice(-3).reverse();
  const node = document.getElementById("overviewMovers");
  if (!node) return;

  if (!winners.length && !losers.length) {
    node.innerHTML = empty(positions.length
      ? "No movement yet today"
      : "Add a position to track movers");
    return;
  }

  const all = [...winners, ...losers];
  const maxAbs = Math.max(...all.map(p => Math.abs(p.dayChangePct))) || 1;

  // Divergent bar — fill extends right from center for winners, left from center for losers.
  // Each side reaches 50% of the track at the maximum |%| in the set, so the biggest
  // mover on each side fills its half.
  const bar = pos => {
    const isUp = pos.dayChangePct >= 0;
    const fillPct = Math.max(2, Math.min(50, (Math.abs(pos.dayChangePct) / maxAbs) * 50));
    return `
      <div class="mover-bar-row" data-select-asset="${pos.symbol}">
        <span class="mover-ticker">${pos.symbol}</span>
        <span class="mover-track">
          <span class="mover-fill ${isUp ? "up" : "dn"}" style="width:${fillPct.toFixed(1)}%"></span>
        </span>
        <span class="mover-pct mono ${isUp ? "up" : "dn"}">${pct(pos.dayChangePct)}</span>
      </div>`;
  };

  node.innerHTML = `
    ${winners.map(bar).join("")}
    ${losers.map(bar).join("")}`;
}

// Overview "Today's spotlight" — the single most consequential thing about the
// portfolio right now. Prefer a freshly triggered alert; otherwise the biggest
// percentage mover; otherwise nothing.
function pickOverviewSpotlight(port) {
  const fresh = (alertsCache || []).filter(a => a.status === "triggered" && a.triggeredAt && (Date.now() - new Date(a.triggeredAt).getTime()) < 1000 * 60 * 60 * 24);
  if (fresh.length) {
    const a = fresh.slice().sort((x, y) => String(y.triggeredAt).localeCompare(String(x.triggeredAt)))[0];
    return { kind: "alert", alert: a };
  }
  const positions = (port.positions || []).filter(p => p.quantity > 0 && Number.isFinite(p.dayChangePct));
  if (!positions.length) return null;
  const biggest = positions.slice().sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct))[0];
  if (!biggest || Math.abs(biggest.dayChangePct) < 0.5) return null; // skip if nothing moved
  return { kind: "mover", position: biggest };
}

function renderOverview() {
  const port = portfolio();
  const openTasks = state.tasks.filter(t => !t.done);
  const todayTasks = openTasks.filter(t => t.due && t.due <= todayISO());
  document.getElementById("dailyBrief").textContent = `${port.dayPnl >= 0 ? "Portfolio is higher" : "Portfolio is lower"} today with ${todayTasks.length} time-sensitive tasks and ${state.news.length} intel items in the queue.`;

  // Spotlight card
  const spotEl = document.getElementById("overviewSpotlight");
  if (spotEl) {
    const pick = pickOverviewSpotlight(port);
    if (pick && pick.kind === "alert") {
      const a = pick.alert;
      spotEl.hidden = false;
      spotEl.innerHTML = `<div class="section-hero-card dn" data-tab="alerts">
        <div class="section-hero-tag">Alert triggered · ${a.symbol} · ${a.triggeredAt ? a.triggeredAt.replace("T", " ").slice(0, 16) : "just now"}</div>
        <h3 class="section-hero-headline">${escapeHtml(describeCondition(a))}</h3>
        <p class="section-hero-lede">${a.triggeredPrice ? `Hit ${money2(Number(a.triggeredPrice))}. ` : ""}Open Alerts to dismiss or pause.</p>
        <div class="section-hero-foot"><span>${a.notifyEmail ? "Email sent" : ""}${a.notifyEmail && a.notifyPush ? " · " : ""}${a.notifyPush ? "Push delivered" : ""}</span><span class="grow"></span><span>Tap to review →</span></div>
      </div>`;
    } else if (pick && pick.kind === "mover") {
      const p = pick.position;
      const sideCls = p.dayChangePct >= 0 ? "up" : "dn";
      const sign = p.dayChangePct >= 0 ? "+" : "";
      const port_value_share = port.value ? (p.value / port.value * 100) : 0;
      spotEl.hidden = false;
      spotEl.innerHTML = `<div class="section-hero-card ${sideCls}" data-select-asset="${p.symbol}" data-tab="portfolio">
        <div class="section-hero-tag">Spotlight · Biggest mover · <span class="${sideCls}">${pct(p.dayChangePct)}</span></div>
        <h3 class="section-hero-headline">${p.symbol} · ${money2(Number(p.price || 0))}</h3>
        <p class="section-hero-lede">${escapeHtml(p.name || p.symbol)} · ${port_value_share.toFixed(1)}% of portfolio${p.targetWeight ? ` (target ${p.targetWeight}%)` : ""}.</p>
        <div class="section-hero-foot"><span class="${sideCls}">${sign}${money(p.dayChangePct / 100 * (p.previousClose || p.price || 0) * (p.quantity || 0))} today</span><span class="grow"></span><span>Open position →</span></div>
      </div>`;
    } else {
      spotEl.hidden = true;
      spotEl.innerHTML = "";
    }
  }

  document.getElementById("overviewSummary").innerHTML = [
    metric("Portfolio Value", money(port.value), `${pct(port.dayPct)} today`, port.dayPnl >= 0 ? "up" : "dn", "sparkValue"),
    metric("Invested Capital", money(port.cost), `${money(port.gain)} total P&L`, port.gain >= 0 ? "up" : "dn", "sparkInvested"),
    metric("Open Tasks", openTasks.length, `${todayTasks.length} due now`, todayTasks.length ? "accent" : "", "")
  ].join("");
  document.getElementById("overviewPortfolio").innerHTML = port.positions.sort((a, b) => b.value - a.value).map(p => positionMini(p, port.value)).join("");
  document.getElementById("overviewTasks").innerHTML = state.tasks.filter(t => !t.done).sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 5).map(t => compactRow(t.title, `${t.priority || "Medium"} | ${t.due || "No due date"}`, t.priority === "High" ? "accent" : "")).join("") || empty("No open tasks");
  document.getElementById("overviewIntel").innerHTML = state.news.slice(0, 5).map((item, i) => newsMini(item, i)).join("") || empty("No intel yet");
  const overviewSnaps = (snapshotsCache && snapshotsCache.length ? snapshotsCache : state.snapshots) || [];
  document.getElementById("overviewHistory").innerHTML = overviewSnaps.slice(0, 5).map(s => compactRow(s.title, `${money(s.portfolio.value)} | ${pct(s.portfolio.dayPct)}`, s.portfolio.dayPnl >= 0 ? "green" : "red")).join("") || empty("Capture your first snapshot");
  renderMovers(port.positions);
  renderHeroSparklines(port);
  renderAllocation(port);
  renderOverviewPerformance(port);
  renderHeatmap(port);
  bindHeatmapResize();
}

function metric(label, value, sub, tone = "", sparkId = "") {
  const spark = sparkId ? `<svg id="${sparkId}" class="metric-spark" preserveAspectRatio="none" viewBox="0 0 100 28"></svg>` : "";
  return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${tone}">${value}</div>${spark}<div class="metric-sub">${sub}</div></div>`;
}
function positionMini(pos, total) {
  const w = total ? (pos.value / total) * 100 : 0;
  const dirCls = pos.dayChangePct >= 0 ? "up" : "dn";
  // Price-led headline (matches the Portfolio tab); value + day-% move to the meta line.
  return `<div class="position-item" data-select-asset="${pos.symbol}"><div class="row-top"><div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div><div class="price-block"><div class="mono">${money2(pos.price)}</div></div></div><div class="row-meta"><span class="muted mono">${money(pos.value)} val</span><span class="mono ${dirCls}">${pct(pos.dayChangePct)} today</span></div><div class="alloc-track"><div class="alloc-fill" style="width:${Math.min(100, w)}%;background:${pos.color}"></div></div></div>`;
}
function compactRow(title, meta, tone = "") { return `<div class="activity-row"><div><div>${title}</div><div class="muted mono">${meta}</div></div><span class="dot ${tone === "green" || tone === "committed" ? "green" : "accent"}"></span></div>`; }
function newsMini(item, index) { return `<div class="activity-row"><span class="news-num">${String(index + 1).padStart(2, "0")}</span><div><div>${item.title}</div><div class="muted mono">${item.symbol} | ${item.source} | ${item.date}</div></div></div>`; }
function empty(text) { return `<div class="empty">${text}</div>`; }
function cleanUrl(url) { const v = String(url || "").trim(); if (!v) return ""; try { const p = new URL(v); return p.protocol === "http:" || p.protocol === "https:" ? p.href : ""; } catch { return ""; } }

function renderPortfolio() {
  const port = portfolio();
  const selectedAsset = getAsset();
  const selected = selectedAsset ? positionFor(selectedAsset) : null;
  const posCount = port.positions.length;
  document.getElementById("positionCount").textContent = `${posCount} assets`;
  // New value-first section header (replaces the implicit "Portfolio" title).
  // Big mono number on top, eyebrow names the section, sub-line summarizes day + total P&L.
  const head = document.getElementById("portfolioHead");
  if (head) {
    document.getElementById("portfolioHeadCount").textContent = `${posCount} position${posCount === 1 ? "" : "s"}`;
    document.getElementById("portfolioHeadValue").textContent = money2(port.value);
    const daySign = port.dayPnl >= 0 ? "+" : "";
    const gainSign = port.gain >= 0 ? "+" : "";
    document.getElementById("portfolioHeadSub").innerHTML = `
      <span class="${port.dayPnl >= 0 ? "up" : "dn"}">${daySign}${money(port.dayPnl)} today</span>
      <span class="sep">&middot;</span>
      <span class="${port.dayPct >= 0 ? "up" : "dn"}">${pct(port.dayPct)}</span>
      <span class="sep">&middot;</span>
      <span class="${port.gain >= 0 ? "up" : "dn"}">${gainSign}${money(port.gain)} total</span>
      <span class="sep">&middot;</span>
      <span class="${port.gainPct >= 0 ? "up" : "dn"}">${pct(port.gainPct)}</span>`;
  }
  // Value + day/total P&L now live in the new #portfolioHead at the top of the view.
  // Keep only the allocation stack here so the sidebar still shows the per-position weight bar.
  document.getElementById("portfolioSummary").innerHTML = `<div class="alloc-stack">${allocationPieces(port)}</div>`;
  // Position row: per-share current price is the headline (matches what users see in their broker app);
  // day-% lives in the sub-meta beside shares and total position value.
  document.getElementById("positionList").innerHTML = posCount ? port.positions.sort((a, b) => b.value - a.value).map(pos => `
    <div class="position-item ${pos.symbol === selected.symbol ? "active" : ""}" data-select-asset="${pos.symbol}">
      <div class="row-top">
        <div class="asset-title-row"><span class="dot" style="background:${pos.color}"></span><div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div></div>
        <div class="price-block"><div class="mono">${money2(pos.price)}</div></div>
      </div>
      <div class="row-meta">
        <span class="muted mono">${pos.quantity.toFixed(pos.type === "crypto" ? 4 : 2)} units</span>
        <span class="muted mono">${money(pos.value)} val</span>
        <span class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)} today</span>
      </div>
      <div class="row-meta pnl-row">
        <span class="${pos.gain >= 0 ? "up" : "dn"} mono">P&L ${money(pos.gain)} (${pct(pos.gainPct)})</span>
        <span class="muted mono">${port.value ? (pos.value / port.value * 100).toFixed(1) : "0.0"}% of total</span>
      </div>
    </div>`).join("") : `<div class="summary-card"><div class="empty">No positions yet</div><button class="btn btn-primary full" data-open-modal="assetModal">Add Position</button></div>`;
  if (selected) renderAssetDetail(selected); else renderEmptyPortfolioDetail();
  renderChart(port, selected);
}

function allocationPieces(port) { if (!port.value) return `<div class="alloc-piece" style="width:100%;background:var(--line2)"></div>`; return port.positions.filter(p => p.value > 0).sort((a, b) => b.value - a.value).map(p => `<div class="alloc-piece" title="${p.symbol}" style="width:${Math.max(1, p.value / port.value * 100)}%;background:${p.color}"></div>`).join(""); }
function renderEmptyPortfolioDetail() {
  document.getElementById("assetDetailHead").innerHTML = `<div><p class="hero-eyebrow">Portfolio setup</p><div class="asset-title">Add your first position</div><p class="hero-greeting">Use Lookup to connect a ticker to live market data, then enter your shares, average cost, and purchase date.</p></div><button class="btn btn-primary" data-open-modal="assetModal">Add Position</button>`;
  document.getElementById("lotsList").innerHTML = empty("No lots yet"); document.getElementById("taxPreview").innerHTML = empty("No tax estimate yet"); document.getElementById("activityList").innerHTML = empty("No activity yet");
}

function renderAssetDetail(pos) {
  document.getElementById("assetDetailHead").innerHTML = `
    <div>
      <p class="hero-eyebrow">Selected position</p>
      <div class="asset-title-row"><span class="dot" style="width:8px;height:34px;border-radius:2px;background:${pos.color}"></span><div><div class="asset-title">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div></div>
      <div class="kmetrics">
        ${km(money(pos.value), "Market value")}
        ${km(pos.quantity.toFixed(pos.type === "crypto" ? 5 : 2), "Quantity")}
        ${km(money(pos.cost), "Cost basis")}
        ${km(money(pos.gain), "Unrealized")}
        ${km(`${pos.targetWeight || 0}%`, "Target")}
        ${km(pos.marketDataLinked === false ? "Manual" : "Live", "Market data")}
      </div>
    </div>
    <div class="asset-actions">
      <div class="price-block"><div class="summary-value">${money2(pos.price)}</div><div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)} today</div></div>
      <div class="toolbar-row"><button class="btn btn-primary" type="button" data-edit-asset="${pos.symbol}">Edit Holding</button><button class="btn btn-ghost" type="button" data-open-modal="tradeModal">Add Trade</button></div>
    </div>`;
  document.getElementById("lotsList").innerHTML = pos.lots.map(lot => `<div class="lot-row"><div><div>${formatQuantity(lot.remaining, pos.type)} units</div><div class="muted">Bought ${lot.date}</div></div><div class="price-block"><div>${money2(lot.unitCost)}</div><div class="muted">${money(lot.remaining * lot.unitCost)}</div></div></div>`).join("") || `<div class="empty">No open lots</div><button class="btn btn-primary full" data-open-modal="tradeModal">Add Lot</button>`;
  const previewQty = Math.min(pos.quantity, pos.quantity * .2 || 0);
  const tax = estimateTax({ symbol: pos.symbol, quantity: previewQty, price: pos.price, date: todayISO(), shortRate: 24, longRate: 15 });
  document.getElementById("taxPreview").innerHTML = previewQty ? `${metric("Potential Sale", money(tax.proceeds), `${formatQuantity(previewQty, pos.type)} units`, "")}<div class="db-row"><span>Estimated gain</span><span class="${tax.gain >= 0 ? "up" : "dn"}">${money(tax.gain)}</span></div><div class="db-row"><span>Estimated federal tax</span><span class="accent">${money(tax.tax)}</span></div><div class="modal-note">Preview assumes selling 20% of the current position using FIFO lots.</div>` : empty("No quantity available");
  document.getElementById("activityList").innerHTML = getTrades(pos.symbol).sort(byDateDesc).map(trade => `<div class="activity-row"><div><div>${trade.action.toUpperCase()} ${formatQuantity(trade.quantity, pos.type)} @ ${money2(trade.price)}</div><div class="muted">${trade.date} | ${trade.memo || "No memo"}</div></div><div class="activity-actions"><span class="${trade.action === "sell" ? "red" : "green"}">${trade.action === "sell" ? "-" : "+"}${money(Number(trade.quantity) * Number(trade.price))}</span><button class="cell-link danger-link" type="button" data-delete-trade="${trade.id}">Delete</button></div></div>`).join("") || empty("No activity");
}

function km(value, label) { return `<div class="km"><div class="km-val">${value}</div><div class="km-lbl">${label}</div></div>`; }
function historyFor(symbol, range = state.chartRange) { return state.priceHistory?.[range]?.[symbol]?.points || []; }

function fallbackHistory(pos, range = state.chartRange) {
  if (!pos) return [];
  const countByRange = { "24h": 12, "7d": 8, "1m": 12, "6m": 14, ytd: 12, all: 16 };
  const count = countByRange[range] || 12;
  const start = Number(pos.previousClose || pos.price || 0) || 1;
  const end = Number(pos.price || start);
  return Array.from({ length: count }, (_, i) => { const t = count === 1 ? 1 : i / (count - 1); const wobble = Math.sin(i * 1.7) * end * .01; return { timestamp: Date.now() / 1000 - (count - i) * 86400, price: start + (end - start) * t + wobble }; });
}

function assetChartSeries(pos) {
  const pricePoints = historyFor(pos.symbol);
  const source = pricePoints.length > 1 ? pricePoints : fallbackHistory(pos);
  return { value: source.map(p => ({ x: p.timestamp, y: Number(p.price || 0) * pos.quantity })), cost: source.map(p => ({ x: p.timestamp, y: pos.cost })), stale: pricePoints.length <= 1 };
}

function portfolioChartSeries(port) {
  const positions = port.positions.filter(p => p.quantity > 0);
  if (!positions.length) return { value: [], cost: [], stale: true };
  const timelines = positions.map(pos => ({ pos, points: historyFor(pos.symbol).length > 1 ? historyFor(pos.symbol) : fallbackHistory(pos) }));
  const timestamps = [...new Set(timelines.flatMap(item => item.points.map(p => p.timestamp)))].sort((a, b) => a - b);
  const lastPrices = new Map();
  const value = timestamps.map(timestamp => {
    let total = 0;
    for (const item of timelines) {
      const exact = item.points.find(p => p.timestamp === timestamp);
      if (exact) lastPrices.set(item.pos.symbol, Number(exact.price || 0));
      const price = lastPrices.get(item.pos.symbol) || Number(item.pos.price || 0);
      total += price * item.pos.quantity;
    }
    return { x: timestamp, y: total };
  });
  return { value, cost: value.map(p => ({ x: p.x, y: port.cost })), stale: timelines.some(item => historyFor(item.pos.symbol).length <= 1) };
}

const chartState = { instance: null, valueSeries: null, costSeries: null, candleSeries: null, resizeObserver: null, tooltip: null, lastDataKey: null };

function ensureChartTooltip(container) {
  if (chartState.tooltip && container.contains(chartState.tooltip)) return chartState.tooltip;
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  Object.assign(tip.style, { position: "absolute", pointerEvents: "none", padding: "8px 10px", background: "rgba(17,17,20,.92)", border: "1px solid #28282f", borderRadius: "4px", color: "#dedee7", fontFamily: "DM Mono, monospace", fontSize: "11px", letterSpacing: ".04em", lineHeight: "1.4", whiteSpace: "nowrap", transform: "translate(-50%, -110%)", transition: "opacity .12s", opacity: "0", zIndex: "10" });
  container.appendChild(tip);
  chartState.tooltip = tip;
  return tip;
}

function buildCandlesFromValueSeries(values) {
  if (values.length < 2) return [];
  const bucketCount = Math.min(60, Math.max(8, Math.floor(values.length / 4)));
  const buckets = Array.from({ length: bucketCount }, () => []);
  values.forEach((point, i) => { const idx = Math.min(bucketCount - 1, Math.floor((i / values.length) * bucketCount)); buckets[idx].push(point); });
  return buckets.filter(b => b.length > 0).map(bucket => {
    const ys = bucket.map(p => p.y);
    const time = Math.floor(bucket[Math.floor(bucket.length / 2)].x);
    return { time, open: ys[0], close: ys[ys.length - 1], high: Math.max(...ys), low: Math.min(...ys) };
  });
}

function dedupeAndSortByTime(points) {
  const map = new Map();
  for (const p of points) { if (!Number.isFinite(p.value) || !Number.isFinite(p.time)) continue; map.set(p.time, p); }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function destroyChart() {
  if (chartState.resizeObserver) { try { chartState.resizeObserver.disconnect(); } catch {} chartState.resizeObserver = null; }
  if (chartState.instance) { try { chartState.instance.remove(); } catch {} chartState.instance = null; chartState.valueSeries = null; chartState.costSeries = null; chartState.candleSeries = null; }
}

function renderChart(port, selected) {
  document.querySelectorAll("[data-chart-range]").forEach(b => b.classList.toggle("active", b.dataset.chartRange === state.chartRange));
  document.querySelectorAll("[data-chart-mode]").forEach(b => b.classList.toggle("active", b.dataset.chartMode === state.chartMode));
  document.querySelectorAll("[data-chart-style]").forEach(b => b.classList.toggle("active", b.dataset.chartStyle === state.chartStyle));
  const container = document.getElementById("portfolioChart");
  const emptyMsg = document.getElementById("chartEmptyMsg");
  if (!container) return;
  const chart = state.chartMode === "portfolio" ? portfolioChartSeries(port) : (selected ? assetChartSeries(selected) : { value: [], cost: [], stale: true });
  const valuesRaw = chart.value.filter(p => Number.isFinite(p.y));
  const costsRaw = chart.cost.filter(p => Number.isFinite(p.y));
  const modeLabel = state.chartMode === "portfolio" ? "Portfolio" : (selected?.symbol || "Asset");
  const rangeLabel = CHART_RANGES.find(([id]) => id === state.chartRange)?.[1] || "1M";
  if (valuesRaw.length < 2) {
    destroyChart();
    container.innerHTML = "";
    if (emptyMsg) { emptyMsg.hidden = false; emptyMsg.textContent = state.assets.length ? "No chart history yet for this view. Click Refresh to fetch live history." : "Add a position from the Portfolio tab to see your chart light up."; }
    const moveLabel = document.getElementById("chartMoveLabel"); if (moveLabel) moveLabel.textContent = "";
    return;
  }
  if (emptyMsg) emptyMsg.hidden = true;
  if (typeof window.LightweightCharts === "undefined") {
    container.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#6b6b7b;font-family:DM Mono,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Loading chart engine…</div>`;
    setTimeout(() => renderChart(port, selected), 250);
    return;
  }
  const valuePoints = dedupeAndSortByTime(valuesRaw.map(p => ({ time: Math.floor(p.x), value: p.y })));
  const costPoints = dedupeAndSortByTime(costsRaw.map(p => ({ time: Math.floor(p.x), value: p.y })));
  const start = valuePoints[0]?.value || 0;
  const end = valuePoints[valuePoints.length - 1]?.value || 0;
  const move = end - start; const movePct = start ? (move / start) * 100 : 0;
  const moveLabel = document.getElementById("chartMoveLabel");
  if (moveLabel) { moveLabel.textContent = `${modeLabel} · ${rangeLabel} · ${money(move)} ${pct(movePct)}`; moveLabel.classList.toggle("up", move >= 0); moveLabel.classList.toggle("dn", move < 0); }
  const dataKey = `${state.chartMode}|${state.chartStyle}|${state.chartRange}|${selected?.symbol || ""}`;
  const styleChanged = chartState.lastDataKey?.split("|")[1] !== state.chartStyle;
  if (!chartState.instance || styleChanged) {
    destroyChart();
    container.innerHTML = "";
    const LWC = window.LightweightCharts;
    const opts = {
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#9b9baa", fontFamily: "DM Mono, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(40,40,47,.45)" }, horzLines: { color: "rgba(40,40,47,.45)" } },
      rightPriceScale: { borderColor: "#1e1e25", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: "#1e1e25", timeVisible: state.chartRange === "24h" || state.chartRange === "7d", secondsVisible: false, rightOffset: 2, barSpacing: 8 },
      crosshair: { mode: 1, vertLine: { color: "rgba(232,213,176,.5)", width: 1, style: 2, labelBackgroundColor: "#e8d5b0" }, horzLine: { color: "rgba(232,213,176,.4)", width: 1, style: 2, labelBackgroundColor: "#e8d5b0" } },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      autoSize: true
    };
    const instance = LWC.createChart(container, opts);
    if (state.chartStyle === "candle") {
      chartState.candleSeries = instance.addCandlestickSeries({ upColor: "#67aa7d", downColor: "#c95c50", borderVisible: false, wickUpColor: "#67aa7d", wickDownColor: "#c95c50", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      chartState.costSeries = instance.addLineSeries({ color: "rgba(232,213,176,.6)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    } else if (state.chartStyle === "line") {
      chartState.valueSeries = instance.addLineSeries({ color: "#67aa7d", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "#67aa7d", crosshairMarkerBackgroundColor: "#0a0a0b" });
      chartState.costSeries = instance.addLineSeries({ color: "rgba(232,213,176,.6)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    } else {
      chartState.valueSeries = instance.addAreaSeries({ topColor: "rgba(103,170,125,.32)", bottomColor: "rgba(103,170,125,0)", lineColor: "#67aa7d", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "#67aa7d", crosshairMarkerBackgroundColor: "#0a0a0b" });
      chartState.costSeries = instance.addLineSeries({ color: "rgba(232,213,176,.6)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    }
    const tooltip = ensureChartTooltip(container);
    instance.subscribeCrosshairMove(param => {
      if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) { tooltip.style.opacity = "0"; return; }
      const targetSeries = chartState.valueSeries || chartState.candleSeries;
      const data = param.seriesData.get(targetSeries);
      if (!data) { tooltip.style.opacity = "0"; return; }
      const v = data.close ?? data.value ?? 0;
      const costData = chartState.costSeries ? param.seriesData.get(chartState.costSeries) : null;
      const c = costData?.value;
      const dt = new Date((typeof param.time === "number" ? param.time : 0) * 1000);
      const dateStr = state.chartRange === "24h" || state.chartRange === "7d" ? dt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : dt.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      tooltip.innerHTML = `<div style="color:#f1f1f5;font-size:12px;margin-bottom:2px;">${money2(v)}</div>${c != null ? `<div style="color:#e8d5b0;">Cost: ${money2(c)}</div>` : ""}<div style="color:#6b6b7b;margin-top:2px;">${dateStr}</div>`;
      tooltip.style.left = `${param.point.x}px`; tooltip.style.top = `${param.point.y}px`; tooltip.style.opacity = "1";
    });
    chartState.instance = instance;
  }
  try {
    if (state.chartStyle === "candle" && chartState.candleSeries) { const candles = buildCandlesFromValueSeries(valuePoints.map(p => ({ x: p.time, y: p.value }))); chartState.candleSeries.setData(candles); }
    else if (chartState.valueSeries) chartState.valueSeries.setData(valuePoints);
    if (chartState.costSeries && costPoints.length) chartState.costSeries.setData(costPoints);
    else if (chartState.costSeries) chartState.costSeries.setData([]);
    chartState.instance.timeScale().fitContent();
  } catch (e) { console.warn("[chart] data update failed", e); }
  chartState.lastDataKey = dataKey;
  if (!chartState.resizeObserver && typeof ResizeObserver !== "undefined") {
    chartState.resizeObserver = new ResizeObserver(entries => { for (const entry of entries) { if (chartState.instance) chartState.instance.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height }); } });
    chartState.resizeObserver.observe(container);
  }
}

// Priority -> color class used by .item-bar and .filter-ct
function taskPriorityClass(p) {
  const v = String(p || "Medium").toLowerCase();
  if (v === "high") return "hi";
  if (v === "low") return "lo";
  return "md";
}

// Pick the most urgent open task to spotlight in the section hero.
// Order of preference: overdue+high -> overdue -> due-today+high -> due-today
// -> high priority -> any open task.
function pickTaskHero(tasks) {
  const open = tasks.filter(t => !t.done);
  if (!open.length) return null;
  const today = todayISO();
  const overdue = open.filter(t => t.due && t.due < today);
  const overdueHi = overdue.find(t => t.priority === "High");
  if (overdueHi) return { task: overdueHi, urgency: "overdue" };
  if (overdue.length) return { task: overdue.sort((a,b) => String(a.due).localeCompare(String(b.due)))[0], urgency: "overdue" };
  const dueToday = open.filter(t => t.due === today);
  const dueTodayHi = dueToday.find(t => t.priority === "High");
  if (dueTodayHi) return { task: dueTodayHi, urgency: "due-today" };
  if (dueToday.length) return { task: dueToday[0], urgency: "due-today" };
  const hi = open.find(t => t.priority === "High");
  if (hi) return { task: hi, urgency: "high" };
  return { task: open[0], urgency: "open" };
}

function renderTasks() {
  const all = state.tasks || [];
  const openTasks = all.filter(t => !t.done);
  const doneTasks = all.filter(t => t.done);
  const today = todayISO();
  const overdueCount = openTasks.filter(t => t.due && t.due < today).length;
  const dueTodayCount = openTasks.filter(t => t.due === today).length;
  const highCount = openTasks.filter(t => t.priority === "High").length;
  const mediumCount = openTasks.filter(t => t.priority === "Medium").length;
  const lowCount = openTasks.filter(t => t.priority === "Low").length;
  const filter = state.taskFilter || "all";

  // Section identity strip (eyebrow + title already in HTML; only sub-line updates).
  const subEl = document.getElementById("tasksSub");
  if (subEl) {
    const subParts = [`${openTasks.length} open`];
    if (dueTodayCount) subParts.push(`${dueTodayCount} due today`);
    if (overdueCount) subParts.push(`${overdueCount} overdue`);
    if (doneTasks.length) subParts.push(`${doneTasks.length} done`);
    subEl.textContent = subParts.join(" · ");
  }
  const cnt = document.getElementById("taskCount"); if (cnt) cnt.textContent = String(openTasks.length);

  // Hero — most urgent open task.
  const heroEl = document.getElementById("tasksHero");
  const heroPick = pickTaskHero(all);
  if (heroEl) {
    if (heroPick) {
      const t = heroPick.task;
      const pCls = taskPriorityClass(t.priority);
      const tagLabel = heroPick.urgency === "overdue" ? "Overdue" : heroPick.urgency === "due-today" ? "Due today" : t.priority === "High" ? "High priority" : "Up next";
      const sideCls = pCls === "hi" ? "dn" : pCls === "md" ? "warn" : "neu";
      const tagParts = ["Up next", tagLabel === "Up next" ? null : tagLabel, t.priority ? `${t.priority} priority` : null].filter(Boolean).join(" · ");
      heroEl.hidden = false;
      heroEl.innerHTML = `<div class="section-hero-card ${sideCls}" data-select-task="${t.id}">
        <div class="section-hero-tag">${tagParts}</div>
        <h3 class="section-hero-headline">${t.title}</h3>
        <p class="section-hero-lede">${t.notes ? escapeHtml(t.notes) : (t.symbol ? `Linked to ${t.symbol}.` : "Tag a decision or block of work to clear today.")}</p>
        <div class="section-hero-foot">
          <span>${t.priority || "Medium"} priority</span>
          ${t.symbol ? `<span class="sep">·</span><span>${t.symbol}</span>` : ""}
          ${t.due ? `<span class="sep">·</span><span>Due ${t.due}${t.due < today ? " (overdue)" : t.due === today ? " (today)" : ""}</span>` : ""}
          <span class="grow"></span>
          <button type="button" class="news-act" data-toggle-task="${t.id}" aria-label="Mark done"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
        </div>
      </div>`;
    } else {
      heroEl.hidden = true;
      heroEl.innerHTML = "";
    }
  }

  // Filter pill counts + active state.
  const setCt = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = String(n); };
  setCt("taskCtAll", openTasks.length);
  setCt("taskCtHigh", highCount);
  setCt("taskCtMed", mediumCount);
  setCt("taskCtLow", lowCount);
  setCt("taskCtDone", doneTasks.length);
  document.querySelectorAll("[data-task-filter]").forEach(b => b.classList.toggle("active", b.dataset.taskFilter === filter));

  // Optional left-rail panel still gets stats (kept for backwards compat with old HTML).
  const stats = document.getElementById("taskStats");
  if (stats) stats.innerHTML = `
    <div class="db-row"><span>Open</span><span>${openTasks.length}</span></div>
    <div class="db-row"><span>High priority</span><span class="accent">${highCount}</span></div>
    <div class="db-row"><span>Completed</span><span class="green">${doneTasks.length}</span></div>`;
  const filters = document.getElementById("taskFilters");
  if (filters) filters.innerHTML = `<div class="nav-item ${filter === "high" ? "active" : ""}" data-task-filter="high"><span class="nav-name">High Priority</span><span class="nav-count">${highCount}</span></div>`;

  // List rows — priority color bar on the left, checkbox, title, sub-meta.
  const filtered = filterTasks(filter).sort((a, b) =>
    Number(!!a.done) - Number(!!b.done) || String(a.due || "9999").localeCompare(String(b.due || "9999"))
  );
  const list = document.getElementById("taskList");
  if (list) {
    list.innerHTML = filtered.length ? filtered.map(task => {
      const pCls = taskPriorityClass(task.priority);
      const dueOverdue = task.due && task.due < today && !task.done;
      const dueLabel = task.due ? (dueOverdue ? `Overdue ${task.due}` : task.due === today ? "Due today" : `Due ${task.due}`) : "No due date";
      const subBits = [dueLabel];
      if (task.symbol) subBits.push(task.symbol);
      if (task.priority) subBits.push(task.priority);
      return `<div class="list-row item-bar-row task-row ${task.id === state.selectedTaskId ? "selected" : ""} ${task.done ? "done" : ""}" data-select-task="${task.id}">
        <span class="item-bar bar-${pCls}"></span>
        <button class="check ${task.done ? "done" : ""}" data-toggle-task="${task.id}" aria-label="Toggle task"></button>
        <div class="item-content">
          <div class="item-title">${task.title}</div>
          <div class="item-sub">${subBits.map((b, i) => i === 0 ? `<span class="${dueOverdue ? 'dn' : ''}">${escapeHtml(b)}</span>` : `<span class="sep">·</span><span>${escapeHtml(b)}</span>`).join("")}</div>
        </div>
      </div>`;
    }).join("") : empty(filter === "done" ? "No completed tasks yet." : "No tasks in this filter.");
  }

  // Footer — running counts and a Mark all done action.
  const footer = document.getElementById("tasksFooter");
  if (footer) {
    if (all.length) {
      footer.hidden = false;
      footer.innerHTML = `<span><span class="news-foot-num">${openTasks.length}</span> open · <span class="news-foot-num">${doneTasks.length}</span> done</span>${openTasks.length ? `<button type="button" id="tasksMarkAllBtn">Mark all done</button>` : ""}`;
    } else {
      footer.hidden = true; footer.innerHTML = "";
    }
  }

  renderTaskDetail();
}

function filterTasks(filter) {
  const open = state.tasks.filter(t => !t.done);
  if (filter === "done") return state.tasks.filter(t => t.done);
  if (filter === "high") return open.filter(t => t.priority === "High");
  if (filter === "medium" || filter === "med") return open.filter(t => t.priority === "Medium" || !t.priority);
  if (filter === "low") return open.filter(t => t.priority === "Low");
  return open; // "all" (default) = all open
}

function renderTaskDetail() {
  const task = state.tasks.find(t => t.id === state.selectedTaskId) || state.tasks[0];
  const node = document.getElementById("taskDetail");
  if (!task) { node.innerHTML = empty("Select a task"); return; }
  node.innerHTML = `<div class="detail-card"><h2>${task.title}</h2><div class="row-meta"><span class="tag priority-${task.priority ? task.priority.toLowerCase() : "medium"}">${task.priority || "Medium"}</span>${task.symbol ? `<span class="tag stock">${task.symbol}</span>` : ""}</div><p>${task.notes || "No notes yet."}</p><div class="db-row"><span>Due</span><span>${task.due || "None"}</span></div><div class="db-row"><span>Status</span><span class="${task.done ? "green" : "accent"}">${task.done ? "Done" : "Open"}</span></div><div class="modal-actions"><button class="btn btn-primary" data-toggle-task="${task.id}">${task.done ? "Reopen" : "Complete"}</button><button class="btn btn-danger" data-delete-task="${task.id}">Delete</button></div></div>`;
}

function filterNews() {
  const filter = state.newsFilter || "all";
  const tickerFilter = state.newsTickerFilter || null; // single-ticker drilldown set by clicking trending pills / coverage map
  const tickers = new Set(state.assets.map(a => a.symbol).filter(Boolean));
  const cryptoTickers = new Set(["BTC","ETH","SOL","ADA","XRP","DOGE","AVAX","LINK","LTC","BCH"]);
  return (state.news || []).filter(item => {
    if (tickerFilter && effectiveNewsSymbol(item) !== tickerFilter) return false;
    if (filter === "all") return true;
    if (filter === "portfolio") return tickers.has(effectiveNewsSymbol(item));
    if (filter === "crypto") return ["theblock","coindesk","cointelegraph"].includes(item.sourceKey || "") || (item.category || "").toLowerCase() === "crypto" || cryptoTickers.has(String(item.symbol).toUpperCase());
    if (filter === "markets") return (item.category || "").toLowerCase() === "markets" || item.sourceKey === "yahoo";
    if (filter === "research") { const s = String(item.sentiment || "").toLowerCase(); return s !== "neutral" && s !== ""; }
    if (filter === "saved") return !!item.saved;
    if (filter === "unread") return !item.read;
    return true;
  });
}

function sourceLogoChip(item) { const key = (item.sourceKey || "").toLowerCase(); const label = item.source || "Source"; return `<span class="news-source ${key}">${label}</span>`; }

// =========================
// News intelligence (renderIntel + helpers)
// =========================

function newsSentimentClass(sentiment) {
  const s = String(sentiment || "neutral").toLowerCase();
  if (s.startsWith("pos") || s === "bullish" || s.includes("somewhat-bullish")) return "pos";
  if (s.startsWith("neg") || s === "bearish" || s.includes("somewhat-bearish") || s === "caution") return "neg";
  return "neu";
}

// Client-side keyword classifier — mirrors classify_sentiment() in api/market.php.
// Used as a fallback so news items cached before the server-side classifier deployed
// still show a real sentiment immediately instead of stuck at "Neutral" until refresh.
const NEWS_NEGATIVE_WORDS = ["miss","missed","misses","missing","cut","cuts","cutting","downgrade","downgrades","downgraded","underperform","underperforming","plunge","plunges","plunged","plunging","tumble","tumbles","tumbled","tumbling","fall","falls","fell","drop","drops","dropped","dropping","decline","declines","declined","declining","warning","concern","concerns","bubble","mania","crash","crashes","crashed","halt","halts","halted","investigation","lawsuit","fraud","bearish","sell-off","selloff","collapse","collapses","collapsed","bankrupt","bankruptcy","recession","slowdown","weak","weaker","weakest","sinking","sink","sinks","sank","sliding","slide","slides","slid","loss","losses","losing","slump","slumps","slumped","worry","worries","worried","risk","risks","risky","threat","threats","threatens","threatened"];
const NEWS_POSITIVE_WORDS = ["beat","beats","beating","beaten","rally","rallies","rallying","rallied","surge","surges","surging","surged","soar","soars","soaring","soared","raises","raised","raising","upgrade","upgrades","upgraded","outperform","outperforming","outperformed","strong","strongest","stronger","gain","gains","gaining","gained","record","breakout","breakouts","jumps","jumped","jumping","leaps","leaped","leaping","tops","topped","topping","positive","bullish","momentum","optimistic","optimism","growth","expand","expands","expanding","expanded","expansion","accelerate","accelerates","accelerating","accelerated","boost","boosts","boosted","boosting","rebound","rebounds","rebounded","rebounding","recovery","recovered","recovering","breakthrough"];
function clientClassifyTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return "Neutral";
  for (const w of NEWS_NEGATIVE_WORDS) { if (t.indexOf(w) !== -1) return "Negative"; }
  for (const w of NEWS_POSITIVE_WORDS) { if (t.indexOf(w) !== -1) return "Positive"; }
  return "Neutral";
}
// Authoritative news sentiment: trust the server's label if it's strong, otherwise
// re-classify the title client-side. Means a cached pre-deploy item still shows a
// useful color bar instead of being stuck at Neutral until the user clicks Refresh.
function getNewsSentiment(item) {
  const serverCls = newsSentimentClass(item && item.sentiment);
  if (serverCls !== "neu") return serverCls;
  return newsSentimentClass(clientClassifyTitle(item && item.title));
}

function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]); }

function formatRelDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return d.toISOString().slice(0,10);
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${Math.max(1, diffMin)}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toISOString().slice(0,10);
}

// Bookmark + external-link SVGs reused in hero + row. Outline style, currentColor stroke.
const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const ICON_OPEN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

// Pick the most consequential story to spotlight: prefer recent + strong-signal
// items on portfolio tickers, fall back to first portfolio story, then first story.
// Yahoo's per-ticker RSS tags every story in a ticker's feed with that ticker,
// even when the story is unrelated (INTC's feed returns generic market stories).
// Only honor the attribution when the headline actually references the symbol
// (whole word) or the company's distinctive name; otherwise treat as general
// market news ("MKT"). Keeps the coverage map + trending counts honest.
function effectiveNewsSymbol(item) {
  const sym = String((item && item.symbol) || "MKT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sym || sym === "MKT") return "MKT";
  const title = String((item && item.title) || "").toUpperCase();
  if (!title) return "MKT";
  if (new RegExp(`\\b${sym}\\b`).test(title)) return item.symbol;
  const asset = (state.assets || []).find(a => String(a.symbol).toUpperCase() === sym);
  if (asset && asset.name) {
    const namePart = (asset.name.split(/[\s,.]+/)[0] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (namePart.length >= 5 && title.includes(namePart)) return item.symbol;
  }
  return "MKT";
}

function pickNewsHero(news) {
  if (!news.length) return null;
  const tickers = new Set(state.assets.map(a => a.symbol));
  const sorted = news.slice().sort((a, b) =>
    String(b.publishedAt || b.date || "").localeCompare(String(a.publishedAt || a.date || ""))
  );
  return (
    sorted.find(n => tickers.has(effectiveNewsSymbol(n)) && getNewsSentiment(n) !== "neu") ||
    sorted.find(n => tickers.has(effectiveNewsSymbol(n))) ||
    sorted[0]
  );
}

function renderIntel() {
  const positions = portfolio().positions;
  const news = state.news || [];

  // API-key indicator (legacy element — only updated if present)
  const apiKeyInput = document.getElementById("apiKey");
  if (apiKeyInput) apiKeyInput.value = auth.configured ? (auth.marketDataConfigured ? `${auth.marketDataProvider || "Server quotes"} · multi-source RSS` : "Market data unavailable") : (state.apiKey ? "Browser fallback key saved" : "Backend not configured");

  // --- Per-ticker stats: story count + sentiment proportions ---
  const tickerStats = new Map();
  news.forEach(n => {
    const tk = effectiveNewsSymbol(n);
    if (!tickerStats.has(tk)) tickerStats.set(tk, { count: 0, pos: 0, neu: 0, neg: 0 });
    const s = tickerStats.get(tk);
    s.count++;
    const cls = getNewsSentiment(n);
    if (cls === "pos") s.pos++; else if (cls === "neg") s.neg++; else s.neu++;
  });

  // --- Coverage map (left sidebar): portfolio tickers with sentiment-proportion bars ---
  const coverageList = positions.map(p => {
    const stats = tickerStats.get(p.symbol) || { count: 0, pos: 0, neu: 0, neg: 0 };
    return { symbol: p.symbol, dayChangePct: p.dayChangePct, ...stats };
  });
  const coverageCount = document.getElementById("coverageCount"); if (coverageCount) coverageCount.textContent = String(coverageList.length);
  const coverageMap = document.getElementById("coverageMap");
  if (coverageMap) {
    coverageMap.innerHTML = coverageList.length ? coverageList.map(c => {
      const total = c.count || 1;
      const posPct = (c.pos / total) * 100;
      const neuPct = (c.neu / total) * 100;
      const negPct = (c.neg / total) * 100;
      const lean = c.pos > c.neg ? "lean positive" : c.neg > c.pos ? "lean negative" : "mixed";
      const isActive = state.newsTickerFilter === c.symbol;
      const midText = c.count === 0 ? "No coverage yet" : `${c.count} stor${c.count === 1 ? 'y' : 'ies'} &middot; ${lean}`;
      return `<div class="coverage-row${isActive ? ' active' : ''}" data-news-ticker="${c.symbol}">
        <div class="coverage-top"><span class="coverage-sym">${c.symbol}</span><span class="coverage-chg mono ${c.dayChangePct >= 0 ? 'up' : 'dn'}">${pct(c.dayChangePct)}</span></div>
        <div class="coverage-mid">${midText}</div>
        <div class="coverage-bar"><span class="neg" style="width:${negPct}%"></span><span class="neu" style="width:${neuPct}%"></span><span class="pos" style="width:${posPct}%"></span></div>
      </div>`;
    }).join("") : empty("Add positions to build coverage.");
  }

  // --- Trending tickers strip (top 6 by story count, excluding MKT) ---
  const trending = Array.from(tickerStats.entries())
    .filter(([tk]) => tk !== "MKT")
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6);
  const trendingEl = document.getElementById("newsTrending");
  if (trendingEl) {
    if (trending.length) {
      trendingEl.hidden = false;
      trendingEl.innerHTML = `<span class="trend-label">Trending</span>` + trending.map(([tk, s]) => {
        const dotColor = s.pos > s.neg ? "#67aa7d" : s.neg > s.pos ? "#c95c50" : "#888780";
        const isActive = state.newsTickerFilter === tk;
        return `<button type="button" class="news-pill${isActive ? ' active' : ''}" data-news-ticker="${tk}"><span class="news-pill-dot" style="background:${dotColor}"></span>${tk}<span class="news-pill-ct">${s.count}</span></button>`;
      }).join("");
    } else {
      trendingEl.hidden = true;
      trendingEl.innerHTML = "";
    }
  }

  // --- Filter tabs ---
  const filter = state.newsFilter || "all";
  document.querySelectorAll("[data-news-filter]").forEach(b => b.classList.toggle("active", b.dataset.newsFilter === filter));
  const savedCt = document.getElementById("newsSavedCt"); if (savedCt) savedCt.textContent = String(news.filter(n => n.saved).length);
  const unreadCt = document.getElementById("newsUnreadCt"); if (unreadCt) unreadCt.textContent = String(news.filter(n => !n.read).length);

  // --- Hero "Top story" card ---
  const heroEl = document.getElementById("newsHero");
  if (heroEl) {
    const hero = pickNewsHero(news);
    if (hero && !state.newsTickerFilter && filter === "all") {
      const cls = getNewsSentiment(hero);
      const signalLabel = cls === "pos" ? "Strong signal" : cls === "neg" ? "Caution signal" : null;
      const heroSym = effectiveNewsSymbol(hero);
      const tagText = ["Top story", signalLabel, heroSym !== "MKT" ? heroSym : null].filter(Boolean).join(" &middot; ");
      heroEl.hidden = false;
      heroEl.innerHTML = `<div class="news-hero-card ${cls} ${hero.read ? 'read' : ''}" data-news-id="${hero.id}">
        <div class="news-hero-tag">${tagText}</div>
        <h3 class="news-hero-headline">${escapeHtml(hero.title)}</h3>
        <div class="news-hero-foot">
          <span>${escapeHtml(hero.source || 'Source')}</span><span class="sep">&middot;</span>
          <span>${formatRelDate(hero.publishedAt || hero.date)}</span>
          <span class="grow"></span>
          <button type="button" class="news-act${hero.saved ? ' saved' : ''}" data-news-save="${hero.id}" aria-label="Save">${ICON_BOOKMARK}</button>
          ${cleanUrl(hero.url) ? `<a class="news-act" data-news-stop href="${cleanUrl(hero.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open">${ICON_OPEN}</a>` : ''}
        </div>
      </div>`;
    } else {
      heroEl.hidden = true;
      heroEl.innerHTML = "";
    }
  }

  // --- News list ---
  const filtered = filterNews();
  let feedHtml;
  if (filtered.length) {
    feedHtml = filtered.map(item => {
      const cls = getNewsSentiment(item);
      const sentLabel = cls === "pos" ? "Positive" : cls === "neg" ? "Negative" : "Neutral";
      const effSym = effectiveNewsSymbol(item);
      const showTicker = effSym !== "MKT";
      const url = cleanUrl(item.url);
      return `<article class="news-item ${item.read ? 'read' : ''}" data-news-id="${item.id}">
        <span class="news-sent-bar ${cls}"></span>
        <div class="news-content">
          <div class="news-top">
            <span class="news-tk ${showTicker ? '' : 'mkt'}">${showTicker ? effSym : 'MKT'}</span>
            <span class="news-meta">${escapeHtml(item.source || 'Source')}<span class="sep">&middot;</span>${formatRelDate(item.publishedAt || item.date)}<span class="sep">&middot;</span><span class="news-sent-label ${cls}">${sentLabel}</span></span>
            <span class="news-actions">
              <button type="button" class="news-act${item.saved ? ' saved' : ''}" data-news-save="${item.id}" aria-label="Save">${ICON_BOOKMARK}</button>
              ${url ? `<a class="news-act" data-news-stop href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Open">${ICON_OPEN}</a>` : ''}
            </span>
          </div>
          <p class="news-headline">${escapeHtml(item.title)}</p>
        </div>
      </article>`;
    }).join("");
  } else if (!news.length) {
    feedHtml = empty("Refresh Intel to pull headlines from The Block, CoinDesk, Cointelegraph, Yahoo Finance, and your tickers.");
  } else if (filter === "saved") {
    feedHtml = empty("No saved stories yet. Tap the bookmark on any story to save it.");
  } else if (filter === "unread") {
    feedHtml = empty("All caught up \u2014 every story has been read.");
  } else if (state.newsTickerFilter) {
    feedHtml = empty(`No stories for ${state.newsTickerFilter} in this view.`);
  } else {
    feedHtml = empty("No stories match this filter.");
  }
  document.getElementById("newsFeed").innerHTML = feedHtml;

  // --- Footer ---
  const footerEl = document.getElementById("newsFooter");
  if (footerEl) {
    if (news.length) {
      footerEl.hidden = false;
      const unread = news.filter(n => !n.read).length;
      const saved = news.filter(n => n.saved).length;
      const drillLabel = state.newsTickerFilter ? `Filtered by ${state.newsTickerFilter} \u00b7 <button type="button" id="newsClearTickerBtn">Clear</button>` : "";
      footerEl.innerHTML = `<span><span class="news-foot-num">${unread}</span> unread &middot; <span class="news-foot-num">${saved}</span> saved${drillLabel ? ` &middot; ${drillLabel}` : ''}</span><button type="button" id="newsMarkAllBtn">Mark all read</button>`;
    } else {
      footerEl.hidden = true;
      footerEl.innerHTML = "";
    }
  }
}


let snapshotsCache = [];
let tradeLookupCache = null;

let alertsCache = [];
let alertsLoading = false;

async function loadSnapshots() {
  if (!auth.configured || !auth.authenticated) { snapshotsCache = []; return; }
  try {
    const r = await apiRequest("snapshots.php?limit=180");
    snapshotsCache = Array.isArray(r.snapshots) ? r.snapshots : [];
  } catch (e) {
    setAuthMessage(e.message);
    return;
  }
  await backfillLocalSnapshots();
  await autoCaptureTodayIfMissing();
}

// Capture today's snapshot to the server if it doesn't already exist for this user.
// Idempotent: the snapshots table has a UNIQUE key on (user_id, snapshot_date), so
// the cron job (if configured) will still overwrite with EOD values later.
let _autoCaptureRunForSession = false;
async function autoCaptureTodayIfMissing() {
  if (_autoCaptureRunForSession) return;
  if (!auth.configured || !auth.authenticated) return;
  if (!state.assets || !state.assets.length) return; // nothing to snapshot
  const today = todayISO();
  const have = (snapshotsCache || []).some(s => String(s.date) === today);
  if (have) { _autoCaptureRunForSession = true; return; }

  try {
    const port = portfolio();
    const positions = port.positions.map(p => ({ symbol: p.symbol, value: p.value, cost: p.cost, dayChangePct: p.dayChangePct, gain: p.gain }));
    positions.sort((a, b) => b.value - a.value);
    const openTasks = state.tasks.filter(t => !t.done);
    const dueTasks = openTasks.filter(t => t.due && t.due <= today);
    const report = `Auto-snapshot at app load. Portfolio ${money(port.value)} · day ${pct(port.dayPct)} · total ${money(port.gain)}. Top: ${positions.slice(0, 3).map(p => p.symbol).join(", ") || "none"}.`;
    await apiRequest("snapshots.php", {
      method: "POST",
      body: JSON.stringify({
        action: "capture",
        date: today,
        portfolio: { value: port.value, cost: port.cost, dayPnl: port.dayPnl, dayPct: port.dayPct, gain: port.gain, gainPct: port.gainPct },
        positions,
        tasks: { open: openTasks.length, due: dueTasks.length },
        report,
      })
    });
    // Re-fetch so the local cache reflects the new row
    const r = await apiRequest("snapshots.php?limit=180");
    snapshotsCache = Array.isArray(r.snapshots) ? r.snapshots : snapshotsCache;
    _autoCaptureRunForSession = true;
    console.log("[snapshots] auto-captured today's snapshot");
  } catch (e) {
    console.warn("[snapshots] auto-capture failed:", e.message);
  }
}

async function backfillLocalSnapshots() {
  // One-shot migration: push any local state.snapshots[] entries to the server
  // that aren't already there (keyed on snapshot date). Successful pushes are
  // dropped from state.snapshots so we don't keep retrying. Failures are
  // logged silently and re-attempted on next load.
  if (!Array.isArray(state.snapshots) || !state.snapshots.length) return;
  const serverDates = new Set((snapshotsCache || []).map(s => String(s.date)));
  const toMigrate = state.snapshots.filter(s => s && s.date && !serverDates.has(String(s.date)));
  if (!toMigrate.length) {
    // Local is fully covered already — clear it to avoid future drift
    if (state.snapshots.length && snapshotsCache.length >= state.snapshots.length) {
      state.snapshots = [];
    }
    return;
  }
  let pushed = 0;
  for (const snap of toMigrate) {
    try {
      await apiRequest("snapshots.php", {
        method: "POST",
        body: JSON.stringify({
          action: "capture",
          date: snap.date,
          portfolio: snap.portfolio || {},
          positions: snap.positions || [],
          tasks: snap.tasks || { open: 0, due: 0 },
          report: snap.report || "",
        })
      });
      pushed++;
    } catch (e) {
      // Skip on failure; keep the local copy so we can retry next load
      console.warn("[snapshots] backfill failed for", snap.date, e.message);
    }
  }
  if (pushed > 0) {
    // Re-fetch so snapshotsCache reflects the merged set, then drop migrated entries
    try {
      const r = await apiRequest("snapshots.php?limit=180");
      snapshotsCache = Array.isArray(r.snapshots) ? r.snapshots : snapshotsCache;
    } catch {}
    const newServerDates = new Set(snapshotsCache.map(s => String(s.date)));
    state.snapshots = state.snapshots.filter(s => !newServerDates.has(String(s.date)));
    saveState();
    setAuthMessage(`Migrated ${pushed} local snapshot${pushed === 1 ? "" : "s"} to server.`);
  }
}

async function loadAlerts() {
  if (!auth.configured || !auth.authenticated) { alertsCache = []; return; }
  alertsLoading = true;
  try {
    const r = await apiRequest("alerts.php");
    alertsCache = Array.isArray(r.alerts) ? r.alerts : [];
  } catch (e) {
    setAuthMessage(e.message);
  } finally {
    alertsLoading = false;
  }
}

function unacknowledgedTriggered() {
  return alertsCache.filter(a => a.status === "triggered");
}

function renderAlertBanner() {
  const triggered = unacknowledgedTriggered();
  let banner = document.getElementById("alertBanner");
  if (!triggered.length) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "alertBanner";
    banner.className = "alert-banner";
    document.body.prepend(banner);
  }
  const sample = triggered[0];
  const more = triggered.length - 1;
  banner.innerHTML = `
    <div class="alert-banner-inner">
      <div class="alert-banner-text">
        <strong>Price alert.</strong>
        ${sample.symbol} ${sample.direction.replace("_", " ")} ${sample.threshold} \u2014 hit at ${money2(sample.triggeredPrice || 0)}.
        ${more > 0 ? `<span class="muted">+${more} more triggered</span>` : ""}
      </div>
      <div class="alert-banner-actions">
        <button class="btn btn-ghost" type="button" data-tab="alerts">View</button>
        <button class="btn btn-primary" type="button" id="alertBannerAck">Dismiss All</button>
      </div>
    </div>`;
  document.getElementById("alertBannerAck").onclick = async () => {
    for (const a of triggered) {
      try { await apiRequest("alerts.php", { method: "POST", body: JSON.stringify({ action: "acknowledge", id: a.id }) }); } catch (e) { /* keep going */ }
    }
    await loadAlerts();
    render();
  };
}

function filterAlerts(filter) {
  if (filter === "active")    return alertsCache.filter(a => a.status === "active");
  if (filter === "triggered") return alertsCache.filter(a => a.status === "triggered" || a.status === "dismissed");
  if (filter === "paused")    return alertsCache.filter(a => a.status === "paused");
  return alertsCache;
}

function describeCondition(a) {
  if (a.direction === "above") return `Price \u2265 ${money2(a.threshold)}`;
  if (a.direction === "below") return `Price \u2264 ${money2(a.threshold)}`;
  if (a.direction === "pct_up") return `Gain \u2265 ${a.threshold}% from ${money2(a.baseline || 0)}`;
  if (a.direction === "pct_down") return `Drop \u2265 ${a.threshold}% from ${money2(a.baseline || 0)}`;
  return a.direction;
}

// Pick the alert to spotlight: most recent triggered (last 24h preferred), else
// the imminent active one (closest current price to threshold), else first active.
function pickAlertHero(alerts) {
  if (!alerts.length) return null;
  const triggered = alerts.filter(a => a.status === "triggered");
  if (triggered.length) {
    return triggered.slice().sort((a, b) => String(b.triggeredAt || "").localeCompare(String(a.triggeredAt || "")))[0];
  }
  const active = alerts.filter(a => a.status === "active");
  if (!active.length) return null; // nothing active or triggered -> no spotlight worth showing
  // Imminence = relative gap between current price and threshold (smaller = closer)
  const withGap = active.map(a => {
    const asset = (state.assets || []).find(s => s.symbol === a.symbol);
    const cur = asset ? Number(asset.price || 0) : 0;
    const thr = Number(a.threshold || 0);
    const gap = cur > 0 && thr > 0 ? Math.abs(cur - thr) / cur : Infinity;
    return { a, gap };
  }).sort((x, y) => x.gap - y.gap);
  return withGap[0].a;
}

function renderAlerts() {
  const all = alertsCache || [];
  const active = all.filter(a => a.status === "active");
  const triggered = all.filter(a => a.status === "triggered");
  const paused = all.filter(a => a.status === "paused");
  const filter = state.alertFilter || "active";

  // Identity strip
  const subEl = document.getElementById("alertsSub");
  if (subEl) {
    const today = todayISO();
    const trigToday = triggered.filter(a => String(a.triggeredAt || "").slice(0, 10) === today).length;
    const parts = [`${active.length} active`];
    parts.push(`${trigToday} triggered today`);
    parts.push("evaluated every 15 min");
    subEl.textContent = parts.join(" · ");
  }
  const cnt = document.getElementById("alertCount"); if (cnt) cnt.textContent = String(all.length);

  // Hero
  const heroEl = document.getElementById("alertsHero");
  const hero = pickAlertHero(all);
  if (heroEl) {
    if (hero) {
      const sideCls = hero.status === "triggered" ? "dn" : hero.status === "active" ? "up" : "neu";
      const tagLabel = hero.status === "triggered" ? "Triggered" : hero.status === "active" ? "Imminent" : hero.status === "paused" ? "Paused" : "Watch";
      const asset = (state.assets || []).find(s => s.symbol === hero.symbol);
      const curPrice = asset ? Number(asset.price || 0) : null;
      const stamp = hero.triggeredAt ? hero.triggeredAt.replace("T", " ").slice(0, 16) : hero.createdAt ? `Created ${String(hero.createdAt).slice(0, 10)}` : "";
      heroEl.hidden = false;
      heroEl.innerHTML = `<div class="section-hero-card ${sideCls}" data-alert-id="${hero.id}">
        <div class="section-hero-tag">${tagLabel} · ${hero.symbol}${stamp ? " · " + escapeHtml(stamp) : ""}</div>
        <h3 class="section-hero-headline">${escapeHtml(describeCondition(hero))}</h3>
        <p class="section-hero-lede">${curPrice ? `Current ${money2(curPrice)}. Threshold ${money2(Number(hero.threshold || 0))}.` : `Threshold ${money2(Number(hero.threshold || 0))}.`}${hero.note ? ` ${escapeHtml(hero.note)}` : ""}</p>
        <div class="section-hero-foot">
          ${hero.notifyEmail ? `<span>Email</span>` : ""}${hero.notifyEmail && hero.notifyPush ? `<span class="sep">·</span>` : ""}${hero.notifyPush ? `<span>Push</span>` : ""}
          <span class="grow"></span>
          ${hero.status === "active" ? `<button class="news-act" data-alert-action="pause" data-alert-id="${hero.id}" aria-label="Pause"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>` : ""}
          ${hero.status === "triggered" ? `<button class="news-act" data-alert-action="acknowledge" data-alert-id="${hero.id}" aria-label="Dismiss"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ""}
        </div>
      </div>`;
    } else {
      heroEl.hidden = true; heroEl.innerHTML = "";
    }
  }

  // Filter pill counts + active state.
  const setCt = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = String(n); };
  setCt("alertCtActive", filterAlerts("active").length);
  setCt("alertCtTrig", filterAlerts("triggered").length);
  setCt("alertCtPaused", filterAlerts("paused").length);
  setCt("alertCtAll", all.length);
  document.querySelectorAll("[data-alert-filter]").forEach(b => b.classList.toggle("active", b.dataset.alertFilter === filter));

  // Sidebar nav (legacy) still gets a populated list for compat.
  const navEl = document.getElementById("alertFilters");
  if (navEl) navEl.innerHTML = [["active","Active"],["triggered","Triggered"],["paused","Paused"],["all","All"]].map(([id, label]) => `<div class="nav-item ${filter === id ? "active" : ""}" data-alert-filter="${id}"><span class="nav-name">${label}</span><span class="nav-count">${filterAlerts(id).length}</span></div>`).join("");

  // List rows — status color bar on the left, ticker, condition, sub-meta, actions.
  const list = document.getElementById("alertsList");
  if (!list) return;
  const items = filterAlerts(filter);
  if (!items.length) {
    list.innerHTML = empty(all.length ? "No alerts in this filter." : (auth.authenticated ? "No alerts yet. Click Add Alert to create one." : "Sign in to set price alerts."));
  } else {
    list.innerHTML = items.map(a => {
      const sideCls = a.status === "triggered" ? "dn" : a.status === "active" ? "up" : "neu";
      const stamp = a.triggeredAt ? `Triggered ${a.triggeredAt.replace("T", " ").slice(0, 16)}` : a.createdAt ? `Created ${String(a.createdAt).slice(0, 10)}` : "";
      const asset = (state.assets || []).find(s => s.symbol === a.symbol);
      const curPrice = asset ? Number(asset.price || 0) : null;
      return `<div class="alert-row item-bar-row status-${a.status}">
        <span class="item-bar bar-${sideCls}"></span>
        <div class="item-content">
          <div class="item-top">
            <span class="item-tk">${a.symbol}</span>
            <span class="item-name">${escapeHtml(describeCondition(a))}</span>
            <span class="item-price">${curPrice ? money2(curPrice) : money2(Number(a.threshold || 0))}</span>
          </div>
          <div class="item-sub">
            <span class="alert-status-pill ${a.status}">${a.status}</span>
            ${a.notifyEmail ? `<span class="sep">·</span><span>Email</span>` : ""}
            ${a.notifyPush ? `<span class="sep">·</span><span>Push</span>` : ""}
            ${stamp ? `<span class="sep">·</span><span>${escapeHtml(stamp)}</span>` : ""}
            ${a.note ? `<span class="sep">·</span><span>${escapeHtml(a.note)}</span>` : ""}
          </div>
        </div>
        <div class="alert-actions">
          ${a.status === "active" ? `<button class="btn btn-ghost" data-alert-action="pause" data-alert-id="${a.id}">Pause</button>` : ""}
          ${a.status === "paused" ? `<button class="btn btn-ghost" data-alert-action="resume" data-alert-id="${a.id}">Resume</button>` : ""}
          ${a.status === "triggered" ? `<button class="btn btn-ghost" data-alert-action="acknowledge" data-alert-id="${a.id}">Dismiss</button>` : ""}
          ${a.status === "triggered" || a.status === "dismissed" ? `<button class="btn btn-ghost" data-alert-action="reset" data-alert-id="${a.id}">Reset</button>` : ""}
          <button class="btn btn-danger" data-alert-action="delete" data-alert-id="${a.id}">Delete</button>
        </div>
      </div>`;
    }).join("");
  }

  // Footer
  const footer = document.getElementById("alertsFooter");
  if (footer) {
    if (all.length) {
      footer.hidden = false;
      const trigCount = filterAlerts("triggered").length;
      footer.innerHTML = `<span><span class="news-foot-num">${active.length}</span> active · <span class="news-foot-num">${trigCount}</span> triggered</span>${active.length ? `<button type="button" id="alertsPauseAllBtn">Pause all</button>` : ""}`;
    } else {
      footer.hidden = true; footer.innerHTML = "";
    }
  }
}

async function handleAlertAction(action, id) {
  try {
    await apiRequest("alerts.php", { method: "POST", body: JSON.stringify({ action, id }) });
    await loadAlerts();
    render();
  } catch (e) {
    setAuthMessage(e.message);
  }
}

async function submitAlertForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  // For pct_up/pct_down, baseline defaults to current quote of the symbol if user left it blank
  const symbol = (data.symbol || "").trim().toUpperCase();
  let baseline = data.baseline ? Number(data.baseline) : null;
  if ((data.direction === "pct_up" || data.direction === "pct_down") && !baseline) {
    const asset = state.assets.find(a => a.symbol === symbol);
    baseline = asset ? Number(asset.price || 0) : null;
  }
  const payload = {
    action: "create",
    symbol,
    direction: data.direction,
    threshold: Number(data.threshold || 0),
    baseline,
    note: (data.note || "").trim() || null,
    notifyEmail: !!data.notifyEmail,
    notifyPush: !!data.notifyPush
  };
  try {
    await apiRequest("alerts.php", { method: "POST", body: JSON.stringify(payload) });
    await loadAlerts();
    closeModals();
    render();
  } catch (e) {
    setAuthMessage(e.message);
  }
}

function renderProfile() {
  const form = document.getElementById("profileForm"); const account = document.getElementById("profileAccount");
  if (!form || !account) return;
  const profile = { ...DEFAULT_PROFILE, ...(state.profile || {}) };
  if (!form.matches(":focus-within")) {
    form.elements.displayName.value = profile.displayName;
    form.elements.email.value = auth.user?.email || "";
    form.elements.baseCurrency.value = profile.baseCurrency;
    form.elements.timeZone.value = profile.timeZone;
    form.elements.investingStyle.value = profile.investingStyle;
    form.elements.notes.value = profile.notes;
  }
  const port = portfolio();
  account.innerHTML = `<div class="profile-stat"><span>Account</span><strong>${auth.authenticated ? "Signed in" : "Local"}</strong></div><div class="profile-stat"><span>Email</span><strong>${auth.user?.email || "Not signed in"}</strong></div><div class="profile-stat"><span>Created</span><strong>${auth.user?.created_at ? String(auth.user.created_at).slice(0, 10) : "Not available"}</strong></div><div class="profile-stat"><span>Portfolio value</span><strong>${money(port.value)}</strong></div><div class="profile-stat"><span>Holdings</span><strong>${port.positions.length}</strong></div><div class="profile-stat"><span>Saved profile</span><strong>${profile.displayName ? profile.displayName : "Add your name"}</strong></div>`;
}

function renderHistory() {
  const snaps = (snapshotsCache && snapshotsCache.length) ? snapshotsCache : (state.snapshots || []);
  const cnt = document.getElementById("historyCount"); if (cnt) cnt.textContent = String(snaps.length);

  // Identity strip
  const subEl = document.getElementById("historySub");
  if (subEl) {
    if (snaps.length) {
      const earliest = snaps.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      subEl.textContent = `${snaps.length} snapshot${snaps.length === 1 ? "" : "s"} since ${earliest.date} · captured daily`;
    } else {
      subEl.textContent = "No snapshots yet · captured daily after market close";
    }
  }

  // Hero — latest snapshot summary.
  const heroEl = document.getElementById("historyHero");
  if (heroEl) {
    const latest = snaps.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (latest) {
      const sideCls = latest.portfolio.dayPnl >= 0 ? "up" : "dn";
      const totalCls = latest.portfolio.gain >= 0 ? "up" : "dn";
      const daySign = latest.portfolio.dayPnl >= 0 ? "+" : "";
      const totalSign = latest.portfolio.gain >= 0 ? "+" : "";
      heroEl.hidden = false;
      heroEl.innerHTML = `<div class="section-hero-card ${sideCls}" data-select-snapshot="${latest.id}">
        <div class="section-hero-tag">Latest snapshot · ${latest.date}</div>
        <h3 class="section-hero-headline section-hero-headline-mono">${money2(latest.portfolio.value)} · <span class="${sideCls}">${pct(latest.portfolio.dayPct)}</span></h3>
        <p class="section-hero-lede"><span class="${sideCls}">${daySign}${money(latest.portfolio.dayPnl)} day</span> · <span class="${totalCls}">${totalSign}${money(latest.portfolio.gain)} total unrealized</span></p>
        <div class="section-hero-foot">
          <span>${(latest.tasks && latest.tasks.open) || 0} task${(latest.tasks && latest.tasks.open) === 1 ? "" : "s"} open</span>
          ${(latest.tasks && latest.tasks.due) ? `<span class="sep">·</span><span class="dn">${latest.tasks.due} due</span>` : ""}
        </div>
      </div>`;
    } else {
      heroEl.hidden = true; heroEl.innerHTML = "";
    }
  }

  // List rows — P&L-direction color bar on the left.
  const list = document.getElementById("historyList");
  if (list) {
    list.innerHTML = snaps.length ? snaps.map(snap => {
      const sideCls = (snap.portfolio.dayPnl || 0) >= 0 ? "up" : "dn";
      const d = new Date(`${snap.date}T00:00:00`);
      const dow = isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { weekday: "short" }).toUpperCase();
      const pnlSign = (snap.portfolio.dayPnl || 0) >= 0 ? "+" : "";
      return `<div class="snapshot-row item-bar-row ${snap.id === state.selectedSnapshotId ? "selected" : ""}" data-select-snapshot="${snap.id}">
        <span class="item-bar bar-${sideCls}"></span>
        <div class="item-content">
          <div class="item-top">
            <span class="item-tk">${dow}</span>
            <span class="item-name">${escapeHtml(snap.title || snap.date)}</span>
            <span class="item-price">${money(snap.portfolio.value)}</span>
          </div>
          <div class="item-sub">
            <span class="${sideCls}">${pnlSign}${money(snap.portfolio.dayPnl)} (${pct(snap.portfolio.dayPct)})</span>
            ${snap.tasks && snap.tasks.open ? `<span class="sep">·</span><span>${snap.tasks.open} task${snap.tasks.open === 1 ? "" : "s"}</span>` : ""}
          </div>
        </div>
      </div>`;
    }).join("") : empty("Snapshots are taken automatically once a day after market close. Capture Today to record one manually.");
  }

  // Footer
  const footer = document.getElementById("historyFooter");
  if (footer) {
    if (snaps.length) {
      footer.hidden = false;
      footer.innerHTML = `<span><span class="news-foot-num">${snaps.length}</span> snapshot${snaps.length === 1 ? "" : "s"}</span>`;
    } else {
      footer.hidden = true; footer.innerHTML = "";
    }
  }

  // Detail panel (unchanged behavior; preserves the existing report card).
  const snap = snaps.find(s => s.id === state.selectedSnapshotId) || snaps[0];
  const node = document.getElementById("historyDetail");
  if (!node) return;
  if (!snap) { node.innerHTML = `<div class="report"><p class="muted">Capture a snapshot to store daily portfolio value, open tasks, and a short report.</p></div>`; return; }
  node.innerHTML = `<article class="report"><h1>${snap.title || snap.date}</h1><div class="report-grid">${metric("Value", money(snap.portfolio.value), "Portfolio")}${metric("Today", money(snap.portfolio.dayPnl), pct(snap.portfolio.dayPct), snap.portfolio.dayPnl >= 0 ? "green" : "red")}${metric("Total P&L", money(snap.portfolio.gain), pct(snap.portfolio.gainPct), snap.portfolio.gain >= 0 ? "green" : "red")}${metric("Open Tasks", (snap.tasks && snap.tasks.open) || 0, `${(snap.tasks && snap.tasks.due) || 0} due`, "")}</div><section class="report-section"><h2>Daily Report</h2><p>${snap.report || ""}</p></section><section class="report-section"><h2>Positions</h2>${(snap.positions || []).map(pos => `<div class="db-row"><span>${pos.symbol}</span><span>${money(pos.value)} | ${pct(pos.dayChangePct)}</span></div>`).join("")}</section></article>`;
}

function captureSnapshot() {
  const port = portfolio();
  const positions = port.positions.map(p => ({ symbol: p.symbol, value: p.value, dayChangePct: p.dayChangePct, gain: p.gain }));
  const openTasks = state.tasks.filter(t => !t.done);
  const dueTasks = openTasks.filter(t => t.due && t.due <= todayISO());
  const report = `Portfolio closed at ${money(port.value)} with ${money(port.dayPnl)} of daily movement (${pct(port.dayPct)}). Total unrealized P&L is ${money(port.gain)}. The biggest positions are ${positions.sort((a, b) => b.value - a.value).slice(0, 3).map(p => p.symbol).join(", ")}. There are ${openTasks.length} open tasks, ${dueTasks.length} due now,.`;
  const snap = { id: uid(), date: todayISO(), title: new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }), portfolio: { value: port.value, cost: port.cost, dayPnl: port.dayPnl, dayPct: port.dayPct, gain: port.gain, gainPct: port.gainPct }, positions, tasks: { open: openTasks.length, due: dueTasks.length }, ideas: state.ideas.map(({ title, stage }) => ({ title, stage })), report };
  state.snapshots.unshift(snap); state.selectedSnapshotId = snap.id; switchTab("history"); render();
}

function hydrateSelects() {
  const options = state.assets.map(a => `<option value="${a.symbol}">${a.symbol} - ${a.name}</option>`).join("");

  // taxAsset is still a <select>
  const tax = document.getElementById("taxAsset");
  if (tax && tax.tagName === "SELECT") { tax.innerHTML = options; tax.value = state.selectedSymbol; }

  // tradeAsset is now an <input list="tradeAssetList"> — populate the datalist instead
  const list = document.getElementById("tradeAssetList");
  if (list) {
    list.innerHTML = state.assets.map(a => `<option value="${a.symbol}">${a.symbol} — ${a.name}</option>`).join("");
  }

  const taskAsset = document.getElementById("taskAsset"); if (taskAsset) taskAsset.innerHTML = `<option value="">None</option>${options}`;
  document.querySelector("#tradeForm [name='date']").value ||= todayISO();
  document.querySelector("#taxForm [name='date']").value ||= todayISO();
  document.querySelector("#assetForm [name='purchaseDate']").value ||= todayISO();
}

function resetAssetForm() {
  const form = document.getElementById("assetForm"); form.reset();
  form.elements.mode.value = "create"; form.elements.originalSymbol.value = ""; form.elements.symbol.disabled = false;
  form.elements.purchaseDate.value = todayISO(); form.elements.fees.value = "0";
  document.getElementById("assetModalTitle").textContent = "Position";
  const delBtn = document.getElementById("deletePositionBtn"); if (delBtn) delBtn.hidden = true;
  setAssetLookupStatus("Lookup connects the asset to server-side market data for future refreshes.");
}

function fillAssetForm(symbol) {
  const form = document.getElementById("assetForm"); const asset = state.assets.find(a => a.symbol === symbol); if (!asset) return;
  const pos = positionFor(asset);
  form.elements.mode.value = "edit"; form.elements.originalSymbol.value = asset.symbol; form.elements.symbol.value = asset.symbol; form.elements.symbol.disabled = false;
  form.elements.name.value = asset.name || asset.symbol; form.elements.type.value = asset.type || "stock";
  form.elements.price.value = Number(asset.price || 0).toFixed(asset.type === "crypto" ? 2 : 4);
  form.elements.targetWeight.value = asset.targetWeight || ""; form.elements.color.value = asset.color || "#e8d5b0";
  form.elements.quantity.value = pos.quantity ? String(Number(pos.quantity.toFixed(asset.type === "crypto" ? 6 : 4))) : "0";
  form.elements.costPrice.value = Number(averageCost(pos) || 0).toFixed(asset.type === "crypto" ? 2 : 4);
  form.elements.purchaseDate.value = pos.lots[0]?.date || todayISO();
  form.elements.fees.value = "0"; form.elements.notes.value = asset.notes || "";
  document.getElementById("assetModalTitle").textContent = `Edit ${asset.symbol}`;
  const delBtn = document.getElementById("deletePositionBtn"); if (delBtn) delBtn.hidden = false;
  setAssetLookupStatus("Editing replaces this holding's current lots with the quantity and average cost entered here.");
}

function switchTab(tab) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const target = document.getElementById(`${tab}View`); if (!target) return;
  target.classList.add("active");
  document.querySelectorAll(".t-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
}

function openModal(id) {
  if (id === "assetModal") resetAssetForm();
  if (id === "tradeModal") {
    tradeLookupCache = null;
    setTradeLookupStatus("Type a ticker and click Lookup to fetch live name and price. New tickers will be added to your portfolio automatically.");
    const tradeForm = document.getElementById("tradeForm");
    if (tradeForm) {
      tradeForm.elements.name.value = "";
      tradeForm.elements.type.value = "stock";
    }
  }
  document.getElementById(id).classList.add("open"); document.getElementById(id).setAttribute("aria-hidden", "false");
  if (id === "tradeModal" && state.selectedSymbol) {
    const t = document.getElementById("tradeAsset");
    if (t) t.value = state.selectedSymbol;
    const tradeForm = document.getElementById("tradeForm");
    const existing = state.assets.find(a => a.symbol === state.selectedSymbol);
    if (tradeForm && existing) {
      tradeForm.elements.name.value = existing.name || existing.symbol;
      tradeForm.elements.type.value = existing.type || "stock";
    }
  }
}

function openAssetEditor(symbol) { resetAssetForm(); fillAssetForm(symbol); document.getElementById("assetModal").classList.add("open"); document.getElementById("assetModal").setAttribute("aria-hidden", "false"); }
function closeModals() { document.querySelectorAll(".modal-overlay").forEach(m => { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); }); }

function upsertAsset(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const symbol = data.symbol.trim().toUpperCase();
  const originalSymbol = (data.originalSymbol || symbol).trim().toUpperCase();
  const isEdit = data.mode === "edit";
  const existing = state.assets.find(a => a.symbol === (isEdit ? originalSymbol : symbol)) || state.assets.find(a => a.symbol === symbol);
  const marketLinked = data.type !== "cash" && data.type !== "other";
  const purchaseDate = data.purchaseDate || todayISO();
  const quantity = Number(data.quantity || 0);
  const costPrice = Number(data.costPrice || data.price || 0);
  const fees = Number(data.fees || 0);
  const asset = { symbol, name: data.name.trim(), type: data.type, price: Number(data.price || 0), previousClose: existing?.price || Number(data.price || 0), targetWeight: Number(data.targetWeight || 0), color: data.color || "#e8d5b0", notes: data.notes.trim(), marketDataSymbol: symbol, marketDataProvider: marketLinked ? "server" : "manual", marketDataLinked: marketLinked, quoteUpdatedAt: existing?.quoteUpdatedAt || null };
  if (existing) {
    Object.assign(existing, asset);
    if (originalSymbol !== symbol) {
      state.trades.forEach(t => { if (t.symbol === originalSymbol) t.symbol = symbol; });
      state.tasks.forEach(t => { if (t.symbol === originalSymbol) t.symbol = symbol; });
      state.news.forEach(n => { if (n.symbol === originalSymbol) n.symbol = symbol; });
    }
  } else state.assets.push(asset);
  if (isEdit) state.trades = state.trades.filter(t => t.symbol !== originalSymbol && t.symbol !== symbol);
  if (quantity > 0 && costPrice > 0) state.trades.push({ id: uid(), symbol, action: "buy", quantity, price: costPrice, fees, date: purchaseDate, memo: isEdit ? "Manual holding update" : (data.notes.trim() || "Initial position entry") });
  state.selectedSymbol = symbol;
}


function setTradeLookupStatus(message, tone = "") {
  const node = document.getElementById("tradeLookupStatus");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("green", tone === "green");
  node.classList.toggle("red", tone === "red");
}

async function lookupTradeAsset() {
  const symbolInput = document.getElementById("tradeAsset");
  const nameInput = document.getElementById("tradeAssetName");
  const typeSelect = document.getElementById("tradeAssetType");
  const priceInput = document.querySelector("#tradeForm [name='price']");
  if (!symbolInput) {
    console.warn("[trade-lookup] tradeAsset input not found in DOM");
    return;
  }
  const symbol = (symbolInput.value || "").trim().toUpperCase();
  if (!symbol) {
    setTradeLookupStatus("Enter a ticker first.", "red");
    symbolInput.focus();
    return;
  }

  // If it's already in the portfolio, fill from local state — no API call needed.
  const existing = state.assets.find(a => a.symbol === symbol);
  if (existing) {
    tradeLookupCache = null;
    symbolInput.value = symbol;
    if (nameInput) nameInput.value = existing.name || symbol;
    if (typeSelect) typeSelect.value = existing.type || "stock";
    if (priceInput && !priceInput.value) {
      priceInput.value = Number(existing.price || 0).toFixed(existing.type === "crypto" ? 2 : 4);
    }
    setTradeLookupStatus(`Using ${symbol} from your portfolio — current price ${money2(existing.price)}.`, "green");
    return;
  }

  if (!auth.configured || !auth.authenticated) {
    setTradeLookupStatus("Sign in before using server-side lookup. You can still enter the trade manually.", "red");
    return;
  }

  setTradeLookupStatus(`Looking up ${symbol}…`);
  try {
    const result = await apiRequest(`market.php?type=lookup&symbol=${encodeURIComponent(symbol)}`, { method: "GET", headers: {} });
    const asset = result.asset;
    tradeLookupCache = asset;
    symbolInput.value = asset.symbol || symbol;
    if (nameInput) nameInput.value = asset.name || symbol;
    if (typeSelect) typeSelect.value = asset.assetType || "stock";
    if (priceInput && asset.price) {
      priceInput.value = Number(asset.price).toFixed(asset.assetType === "crypto" ? 2 : 4);
    }
    setTradeLookupStatus(`Found ${asset.symbol || symbol} (${asset.name || asset.assetType}). Saving the trade will add it to your portfolio.`, "green");
  } catch (e) {
    tradeLookupCache = null;
    setTradeLookupStatus(e.message, "red");
  }
}

async function lookupAssetMarketData() {
  const form = document.getElementById("assetForm"); const symbolInput = form.elements.symbol;
  const symbol = symbolInput.value.trim().toUpperCase();
  if (!symbol) { setAssetLookupStatus("Enter a ticker first.", "red"); symbolInput.focus(); return; }
  if (!auth.configured || !auth.authenticated) { setAssetLookupStatus("Sign in before using server-side lookup.", "red"); return; }
  setAssetLookupStatus(`Looking up ${symbol}...`);
  try {
    const result = await apiRequest(`market.php?type=lookup&symbol=${encodeURIComponent(symbol)}`, { method: "GET", headers: {} });
    const asset = result.asset;
    form.elements.symbol.value = asset.symbol || symbol;
    form.elements.name.value = asset.name || asset.symbol || symbol;
    form.elements.type.value = asset.assetType || "stock";
    form.elements.price.value = asset.price ? Number(asset.price).toFixed(asset.assetType === "crypto" ? 2 : 4) : "";
    if (!form.elements.costPrice.value && asset.price) form.elements.costPrice.value = Number(asset.price).toFixed(asset.assetType === "crypto" ? 2 : 4);
    setAssetLookupStatus(`Linked ${asset.symbol || symbol} through ${asset.provider || auth.marketDataProvider || "market data"}. Enter your shares and cost basis, then save.`, "green");
  } catch (e) { setAssetLookupStatus(e.message, "red"); }
}

function recordTrade(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const symbol = ((data.symbol || state.selectedSymbol) || "").trim().toUpperCase();
  if (!symbol) return;

  const userName = (data.name || "").trim();
  const userType = (data.type || "").trim().toLowerCase();

  // If the asset isn't in the portfolio yet, create it. Prefer the form values
  // (which the user may have just edited after a lookup), then fall back to the
  // cached lookup, then to sensible manual defaults using the trade price.
  let asset = state.assets.find(a => a.symbol === symbol);
  if (!asset) {
    const looked = tradeLookupCache && (tradeLookupCache.symbol || "").toUpperCase() === symbol ? tradeLookupCache : null;
    const tradePrice = Number(data.price || 0);
    const linked = !!looked;
    asset = {
      symbol,
      name: userName || looked?.name || symbol,
      type: userType || looked?.assetType || "stock",
      price: Number(looked?.price || tradePrice),
      previousClose: Number(looked?.previousClose || tradePrice),
      targetWeight: 0,
      color: "#e8d5b0",
      notes: "",
      marketDataSymbol: symbol,
      marketDataProvider: linked ? (looked.provider || "server") : "manual",
      marketDataLinked: linked,
      quoteUpdatedAt: linked ? new Date().toISOString() : null,
    };
    state.assets.push(asset);
  } else {
    // If the user edited name/type, propagate the change to the existing asset.
    let touched = false;
    if (userName && userName !== asset.name) { asset.name = userName; touched = true; }
    if (userType && userType !== asset.type) { asset.type = userType; touched = true; }
    if (touched) { /* state.assets was mutated in place; saveState() runs after render */ }
  }
  tradeLookupCache = null;

  state.trades.push({
    id: uid(), symbol,
    action: data.action,
    quantity: Number(data.quantity || 0),
    price: Number(data.price || 0),
    fees: Number(data.fees || 0),
    date: data.date,
    memo: (data.memo || "").trim(),
  });
  state.selectedSymbol = symbol;
}

function addTask(form) { const d = Object.fromEntries(new FormData(form).entries()); const t = { id: uid(), title: d.title.trim(), priority: d.priority, due: d.due, symbol: d.symbol, notes: d.notes.trim(), done: false }; state.tasks.unshift(t); state.selectedTaskId = t.id; }
async function refreshLiveData(silent = false) {
  if (auth.configured && !auth.authenticated) { if (!silent) alert("Sign in before refreshing server-side market data."); return; }
  if (auth.configured && auth.authenticated) {
        try {
      const symbols = state.assets.filter(i => i.marketDataLinked !== false && i.type !== "cash" && i.type !== "other").map(a => a.marketDataSymbol || a.symbol).join(",");
      if (!symbols) { render(); return; }
      const result = await apiRequest(`market.php?type=quotes&symbols=${encodeURIComponent(symbols)}`, { method: "GET", headers: {} });
      for (const quote of result.quotes || []) {
        const asset = state.assets.find(i => (i.marketDataSymbol || i.symbol) === quote.symbol || i.symbol === quote.symbol);
        if (asset && quote.price) {
          asset.previousClose = quote.previousClose || asset.price; asset.price = quote.price;
          asset.marketDataLinked = true; asset.marketDataProvider = quote.provider || auth.marketDataProvider || "server";
          if (quote.name && (!asset.name || asset.name === asset.symbol)) asset.name = quote.name;
          asset.quoteUpdatedAt = new Date().toISOString();
        }
      }
      await refreshChartHistory(state.chartRange, true);
      await refreshNews();
      // Re-capture today with the fresh quote data so the snapshot reflects latest prices
      _autoCaptureRunForSession = false;
      await loadSnapshots();
      render();
    } catch (e) { if (!silent) alert(e.message); render(); }
    return;
  }
  if (!state.apiKey) { if (!silent) alert("Configure the server-side Alpha Vantage key in api/config.php, or save a browser fallback key in local mode."); return; }
    for (const asset of state.assets.filter(i => i.type !== "crypto" && i.type !== "cash")) {
    try {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(asset.symbol)}&apikey=${encodeURIComponent(state.apiKey)}`;
      const result = await fetch(url).then(r => r.json());
      const quote = result["Global Quote"];
      const price = Number(quote?.["05. price"]); const previousClose = Number(quote?.["08. previous close"]);
      if (price) { asset.previousClose = previousClose || asset.price; asset.price = price; }
    } catch {}
  }
  await refreshNews(); render();
}

async function refreshChartHistory(range = state.chartRange, silent = false) {
  if (!auth.configured || !auth.authenticated) return;
  const symbols = state.assets.filter(i => i.marketDataLinked !== false && i.type !== "cash" && i.type !== "other").map(a => a.marketDataSymbol || a.symbol).join(",");
  if (!symbols) return;
  try {
    const result = await apiRequest(`market.php?type=history&range=${encodeURIComponent(range)}&symbols=${encodeURIComponent(symbols)}`, { method: "GET", headers: {} });
    state.priceHistory ||= {}; state.priceHistory[range] ||= {};
    for (const series of result.history || []) {
      const asset = state.assets.find(i => (i.marketDataSymbol || i.symbol) === series.symbol || i.symbol === series.symbol);
      if (!asset) continue;
      state.priceHistory[range][asset.symbol] = { provider: series.provider, updatedAt: new Date().toISOString(), points: Array.isArray(series.points) ? series.points : [] };
    }
  } catch (e) { if (!silent) alert(e.message); }
}

async function refreshNews() {
  if (auth.configured && auth.authenticated) {
    try {
      const symbols = state.assets.filter(a => a.marketDataLinked !== false && a.type !== "cash" && a.type !== "other").map(a => a.marketDataSymbol || a.symbol).join(",");
      const result = await apiRequest(`market.php?type=news&sources=all&symbols=${encodeURIComponent(symbols)}`, { method: "GET", headers: {} });
      if (Array.isArray(result.news)) {
        // Preserve read/saved state across refreshes by URL (server hands out fresh
        // random IDs each fetch, so we re-key on the canonical content URL).
        const oldByKey = new Map((state.news || []).map(n => [n.url || n.title, n]));
        state.news = result.news.map(n => {
          const key = n.url || n.title;
          const old = oldByKey.get(key);
          return { ...n, read: !!(old && old.read), saved: !!(old && old.saved) };
        });
        setAuthMessage(result.provider ? `Intel refreshed via ${result.provider}.` : "Intel refreshed.");
      }
    } catch (e) { setAuthMessage(e.message); }
    return;
  }
  if (!state.apiKey) return;
  try {
    const tickers = state.assets.filter(a => a.type !== "cash" && a.type !== "other").map(a => a.symbol).join(",");
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&apikey=${encodeURIComponent(state.apiKey)}`;
    const result = await fetch(url).then(r => r.json());
    if (Array.isArray(result.feed)) {
      const oldByKey = new Map((state.news || []).map(n => [n.url || n.title, n]));
      state.news = result.feed.slice(0, 25).map(item => {
        const url = item.url || "";
        const old = oldByKey.get(url || item.title);
        const base = { id: uid(), symbol: item.ticker_sentiment?.[0]?.ticker || "MKT", title: item.title, source: item.source || "Alpha Vantage", sourceKey: "alphavantage", url, date: String(item.time_published || todayISO()).slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), sentiment: item.overall_sentiment_label || "Neutral" };
        return { ...base, read: !!(old && old.read), saved: !!(old && old.saved) };
      });
    }
  } catch { alert("News refresh failed. Check the API key, rate limit, or browser network permissions."); }
}

document.addEventListener("click", event => {
  const tab = event.target.closest("[data-tab]")?.dataset.tab; if (tab) switchTab(tab);
  const modal = event.target.closest("[data-open-modal]")?.dataset.openModal; if (modal) openModal(modal);
  if (event.target.closest("[data-close-modal]") || event.target.classList.contains("modal-overlay")) closeModals();
  const chartMode = event.target.closest("[data-chart-mode]")?.dataset.chartMode;
  if (chartMode) { state.chartMode = chartMode; render(); }
  const chartRange = event.target.closest("[data-chart-range]")?.dataset.chartRange;
  if (chartRange) { state.chartRange = chartRange; render(); refreshChartHistory(chartRange, true).then(render); }
  const chartStyle = event.target.closest("[data-chart-style]")?.dataset.chartStyle;
  if (chartStyle) { state.chartStyle = chartStyle; render(); }
  const alertFilter = event.target.closest("[data-alert-filter]")?.dataset.alertFilter;
  if (alertFilter) { state.alertFilter = alertFilter; render(); }

  const alertActionEl = event.target.closest("[data-alert-action]");
  if (alertActionEl) {
    const action = alertActionEl.dataset.alertAction;
    const id = Number(alertActionEl.dataset.alertId);
    if (id) {
      if (action === "delete" && !confirm("Delete this alert?")) return;
      handleAlertAction(action, id);
    }
  }

  const inviteActionEl = event.target.closest("[data-invite-action]");
  if (inviteActionEl) {
    const action = inviteActionEl.dataset.inviteAction;
    const id = Number(inviteActionEl.dataset.inviteId);
    if (id) {
      if (action === "revoke") {
        if (confirm("Revoke this invitation? The link will stop working.")) {
          revokeInvitation(id).then(() => { renderInvitations(); }).catch(err => alert(err.message));
        }
      } else if (action === "resend") {
        resendInvitation(id).then(r => { renderInvitations(); alert(r.emailSent ? "Invitation re-sent." : "Re-send failed; check email config."); }).catch(err => alert(err.message));
      }
    }
  }

  const overviewRange = event.target.closest("[data-overview-range]")?.dataset.overviewRange;
  if (overviewRange) { state.overviewRange = overviewRange; saveState(); renderOverviewPerformance(portfolio()); return; }

  const benchmarkToggle = event.target.closest("[data-benchmark]")?.dataset.benchmark;
  if (benchmarkToggle) {
    const list = state.overviewBenchmarks || [];
    const idx = list.indexOf(benchmarkToggle);
    if (idx >= 0) list.splice(idx, 1); else list.push(benchmarkToggle);
    state.overviewBenchmarks = list;
    saveState();
    renderOverviewPerformance(portfolio());
    return;
  }

  const newsFilter = event.target.closest("[data-news-filter]")?.dataset.newsFilter;
  if (newsFilter) { state.newsFilter = newsFilter; state.newsTickerFilter = null; render(); }
  // News ticker drilldown (trending pill / coverage map row click)
  const newsTicker = event.target.closest("[data-news-ticker]")?.dataset.newsTicker;
  if (newsTicker) {
    event.preventDefault();
    state.newsTickerFilter = state.newsTickerFilter === newsTicker ? null : newsTicker;
    render();
    return;
  }
  // External link inside a news row — let the default <a> behavior run, do not toggle read.
  if (event.target.closest("[data-news-stop]")) return;
  // Save / bookmark toggle on a news item
  const newsSaveId = event.target.closest("[data-news-save]")?.dataset.newsSave;
  if (newsSaveId) {
    event.preventDefault();
    event.stopPropagation();
    const target = (state.news || []).find(n => n.id === newsSaveId);
    if (target) { target.saved = !target.saved; render(); }
    return;
  }
  // Clicking anywhere else on a news row marks it as read (and is the future expand-preview surface).
  const newsRow = event.target.closest(".news-item, .news-hero-card");
  if (newsRow) {
    const id = newsRow.dataset.newsId;
    const target = (state.news || []).find(n => n.id === id);
    if (target && !target.read) { target.read = true; render(); }
    return;
  }
  // Footer actions
  if (event.target.closest("#newsMarkAllBtn")) {
    (state.news || []).forEach(n => { n.read = true; });
    render();
    return;
  }
  // Tasks: Mark all done
  if (event.target.closest("#tasksMarkAllBtn")) {
    (state.tasks || []).forEach(t => { t.done = true; });
    render();
    return;
  }
  // Alerts: Pause all active
  if (event.target.closest("#alertsPauseAllBtn")) {
    (async () => {
      const active = (alertsCache || []).filter(a => a.status === "active");
      for (const a of active) {
        try { await apiRequest("alerts.php", { method: "POST", body: JSON.stringify({ action: "pause", id: a.id }) }); } catch {}
      }
      await loadAlerts(); render();
    })();
    return;
  }
  if (event.target.closest("#newsClearTickerBtn")) {
    state.newsTickerFilter = null;
    render();
    return;
  }
  const symbol = event.target.closest("[data-select-asset]")?.dataset.selectAsset;
  if (symbol) { state.selectedSymbol = symbol; render(); }
  const editAsset = event.target.closest("[data-edit-asset]")?.dataset.editAsset;
  if (editAsset) openAssetEditor(editAsset);
  const taskFilter = event.target.closest("[data-task-filter]")?.dataset.taskFilter;
  if (taskFilter) { state.taskFilter = taskFilter; render(); }
  const taskId = event.target.closest("[data-select-task]")?.dataset.selectTask;
  if (taskId) { state.selectedTaskId = taskId; render(); }
  const toggleTaskId = event.target.closest("[data-toggle-task]")?.dataset.toggleTask;
  if (toggleTaskId) { const t = state.tasks.find(i => i.id === toggleTaskId); if (t) t.done = !t.done; render(); }
  const deleteTaskId = event.target.closest("[data-delete-task]")?.dataset.deleteTask;
  if (deleteTaskId) { state.tasks = state.tasks.filter(t => t.id !== deleteTaskId); state.selectedTaskId = state.tasks[0]?.id || null; render(); }
  const deleteTradeId = event.target.closest("[data-delete-trade]")?.dataset.deleteTrade;
  if (deleteTradeId && confirm("Delete this portfolio activity entry? This changes the holding quantity and tax lots.")) { state.trades = state.trades.filter(t => t.id !== deleteTradeId); render(); }
  const snapId = event.target.closest("[data-select-snapshot]")?.dataset.selectSnapshot;
  if (snapId) { state.selectedSnapshotId = snapId; render(); }
  if (event.target.closest("#portfolioRefreshBtn")) refreshLiveData();
  if (event.target.closest("#overviewPerfExportBtn")) { event.preventDefault(); exportOverviewPerfChart(); }
  if (event.target.closest("#tradeLookupBtn")) { event.preventDefault(); lookupTradeAsset(); }
});

document.getElementById("assetForm").addEventListener("submit", e => { e.preventDefault(); upsertAsset(e.currentTarget); e.currentTarget.reset(); setAssetLookupStatus("Lookup connects the asset to server-side market data for future refreshes."); closeModals(); render(); });
document.getElementById("deletePositionBtn").addEventListener("click", () => {
  const form = document.getElementById("assetForm");
  const symbol = (form.elements.originalSymbol.value || form.elements.symbol.value || "").toUpperCase();
  if (!symbol) return;
  const tradeCount = state.trades.filter(t => t.symbol === symbol).length;
  const msg = tradeCount
    ? `Delete position ${symbol}? This also removes ${tradeCount} trade entr${tradeCount === 1 ? "y" : "ies"} and tax-lot history. This cannot be undone.`
    : `Delete position ${symbol}? This cannot be undone.`;
  if (!confirm(msg)) return;
  state.assets = state.assets.filter(a => a.symbol !== symbol);
  state.trades = state.trades.filter(t => t.symbol !== symbol);
  if (state.selectedSymbol === symbol) state.selectedSymbol = state.assets[0]?.symbol || null;
  closeModals();
  render();
});
document.getElementById("assetLookupBtn").addEventListener("click", lookupAssetMarketData);
document.getElementById("tradeForm").addEventListener("submit", e => { e.preventDefault(); recordTrade(e.currentTarget); e.currentTarget.reset(); closeModals(); render(); });
document.getElementById("taskForm").addEventListener("submit", e => { e.preventDefault(); addTask(e.currentTarget); e.currentTarget.reset(); closeModals(); render(); });
document.getElementById("alertForm").addEventListener("submit", e => { e.preventDefault(); submitAlertForm(e.currentTarget).then(() => e.currentTarget.reset()); });

// Show/hide baseline field based on direction
document.getElementById("alertDirection").addEventListener("change", e => {
  const isPct = e.target.value === "pct_up" || e.target.value === "pct_down";
  const row = document.querySelector(".alert-baseline-row");
  if (row) row.hidden = !isPct;
});
document.getElementById("profileForm").addEventListener("submit", e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  state.profile = { displayName: d.displayName.trim(), baseCurrency: d.baseCurrency, timeZone: d.timeZone.trim() || DEFAULT_PROFILE.timeZone, investingStyle: d.investingStyle, notes: d.notes.trim() };
  const m = document.getElementById("profileMessage"); if (m) m.textContent = "Profile saved to your synced workspace."; render();
});
document.getElementById("taxForm").addEventListener("submit", e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries()); const result = estimateTax(d);
  document.getElementById("taxEstimateOutput").innerHTML = `${metric("Estimated Gain", money(result.gain), `${money(result.proceeds)} proceeds`, result.gain >= 0 ? "green" : "red")}<div class="db-row"><span>Cost basis</span><span>${money(result.basis)}</span></div><div class="db-row"><span>Federal estimate</span><span class="accent">${money(result.tax)}</span></div>${result.remaining > 0 ? `<div class="modal-note">Not enough open lots for ${result.remaining.toFixed(4)} units.</div>` : ""}${result.rows.map(r => `<div class="db-row"><span>${r.qty.toFixed(4)} from ${r.date} (${r.term})</span><span>${money(r.gain)}</span></div>`).join("")}`;
});

document.getElementById("saveApiKeyBtn")?.addEventListener("click", () => {
  if (auth.configured) { alert(auth.newsDataConfigured ? "Server-side quotes, Alpha Vantage news, and Yahoo + RSS fallbacks are configured." : "Server-side Yahoo quotes and multi-source RSS are active. Add alpha_vantage_api_key in public_html/api/config.php later for sentiment-enhanced news."); return; }
  const key = prompt("Optional local fallback Alpha Vantage key. Prefer server-side config for production.", state.apiKey || "");
  if (key !== null) { state.apiKey = key.trim(); render(); }
});

document.getElementById("refreshDataBtn").addEventListener("click", refreshLiveData);
document.getElementById("refreshNewsBtn").addEventListener("click", async () => { await refreshNews(); render(); });
document.getElementById("captureSnapshotBtn")?.addEventListener("click", captureSnapshot);
document.getElementById("historySnapshotBtn").addEventListener("click", captureSnapshot);


async function logoutUser() {
  if (!auth.configured || !auth.authenticated) return;
  try { await apiRequest("auth.php", { method: "POST", body: JSON.stringify({ action: "logout" }) }); } catch (e) { /* fine, server may already have killed session */ }
  auth.authenticated = false;
  auth.user = null;
  auth.csrfToken = "";
  updateAuthGate();
  render();
}

function exportStateToFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `my-dailyedge-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function userMenuClose() {
  const menu = document.getElementById("userMenu");
  const chip = document.getElementById("userChip");
  if (menu) menu.hidden = true;
  if (chip) chip.setAttribute("aria-expanded", "false");
}

function userMenuOpen() {
  const menu = document.getElementById("userMenu");
  const chip = document.getElementById("userChip");
  if (menu) menu.hidden = false;
  if (chip) chip.setAttribute("aria-expanded", "true");
}

function setupUserChip() {
  // Use document-level event delegation so the handlers stay live even if
  // userChip / userMenu get re-rendered or aren't present on the first pass.
  document.addEventListener("click", (event) => {
    const chipEl = event.target.closest("#userChip");
    if (chipEl) {
      event.preventDefault();
      event.stopPropagation();
      if (!auth.configured) {
        alert(auth.error || "Backend storage is not configured yet.");
        return;
      }
      if (!auth.authenticated) {
        const gate = document.getElementById("authGate");
        if (gate) gate.hidden = false;
        return;
      }
      const menu = document.getElementById("userMenu");
      if (!menu) return;
      if (menu.hidden) userMenuOpen(); else userMenuClose();
      return;
    }

    const menuItem = event.target.closest("#userMenuProfile, #userMenuExport, #userMenuLogout");
    if (menuItem) {
      event.preventDefault();
      event.stopPropagation();
      userMenuClose();
      if (menuItem.id === "userMenuProfile") { switchTab("profile"); render(); }
      else if (menuItem.id === "userMenuExport") { exportStateToFile(); }
      else if (menuItem.id === "userMenuLogout") { logoutUser(); }
      return;
    }

    // Click outside the menu closes it
    const menu = document.getElementById("userMenu");
    if (menu && !menu.hidden && !menu.contains(event.target)) userMenuClose();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") userMenuClose();
  });
}

function renderUserChip() {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  const profile = state.profile || {};
  const fallback = (auth.user?.email || "").split("@")[0];
  const name = (profile.displayName || "").trim() || fallback || "Guest";
  const tokens = name.split(/[\s._-]+/).filter(Boolean);
  const initials = (tokens.length >= 2
      ? tokens[0][0] + tokens[1][0]
      : (name[0] || "?")
  ).toUpperCase();
  const avatar = chip.querySelector(".user-chip-avatar");
  const label = chip.querySelector(".user-chip-name");
  if (avatar) avatar.textContent = initials;
  if (label) label.textContent = name;
  chip.classList.toggle("user-chip-anon", !auth.authenticated);
}

document.getElementById("showRegisterBtn").addEventListener("click", () => { document.getElementById("loginForm").hidden = true; document.getElementById("registerForm").hidden = false; setAuthMessage("Create the first account, then disable registration in api/config.php."); });
document.getElementById("showLoginBtn").addEventListener("click", () => { document.getElementById("registerForm").hidden = true; document.getElementById("loginForm").hidden = false; setAuthMessage(""); });

document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    const result = await apiRequest("auth.php", { method: "POST", body: JSON.stringify({ action: "login", email: d.email, password: d.password }) });
    if (result.csrfToken) auth.csrfToken = result.csrfToken;
    await refreshAuthStatus();
    await loadServerState();
    await loadSnapshots();
    if (auth.isAdmin) await loadInvitations();
    updateAuthGate();
    render();
  }
  catch (err) { setAuthMessage(err.message); }
});

document.getElementById("registerForm").addEventListener("submit", async e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    const result = await apiRequest("auth.php", { method: "POST", body: JSON.stringify({ action: "register", email: d.email, password: d.password }) });
    if (result.csrfToken) auth.csrfToken = result.csrfToken;
    await refreshAuthStatus();
    await saveServerState();
    updateAuthGate();
    render();
  }
  catch (err) { setAuthMessage(err.message); }
});


function renderConflictBanner() {
  let banner = document.getElementById("conflictBanner");
  if (!pendingConflict) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "conflictBanner";
    banner.className = "conflict-banner";
    document.body.prepend(banner);
  }
  banner.innerHTML = `
    <div class="conflict-banner-inner">
      <div class="conflict-banner-text">
        <strong>Sync conflict.</strong> Your data was changed on another device. Reload to see the latest version, or push your local changes anyway.
      </div>
      <div class="conflict-banner-actions">
        <button class="btn btn-ghost" id="conflictReloadBtn" type="button">Reload</button>
        <button class="btn btn-primary" id="conflictForceBtn" type="button">Save Anyway</button>
      </div>
    </div>
  `;
  document.getElementById("conflictReloadBtn").onclick = async () => {
    pendingConflict = null;
    await loadServerState();
    render();
  };
  document.getElementById("conflictForceBtn").onclick = async () => {
    await saveServerState(true);
    render();
  };
}


// =====================
// Web push notifications
// =====================
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function refreshPushStatus() {
  pushState.supported = "serviceWorker" in navigator && "PushManager" in window;
  if (!pushState.supported) return;
  pushState.permission = Notification.permission;
  if (auth.configured && auth.authenticated) {
    try {
      const r = await apiRequest("push-subscribe.php");
      pushState.vapidPublicKey = r.vapidPublicKey || "";
      pushState.subscriptions = Array.isArray(r.subscriptions) ? r.subscriptions : [];
    } catch (e) { /* keep stale state */ }
  }
  // Determine if THIS device is subscribed
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        pushState.subscribed = !!sub;
      } else {
        pushState.subscribed = false;
      }
    } catch (e) {
      pushState.subscribed = false;
    }
  }
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported in this browser.");
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function enablePush() {
  if (!pushState.supported) {
    alert("This browser doesn't support push notifications.");
    return;
  }
  if (!pushState.vapidPublicKey) {
    alert("Push isn't set up on the server yet. Generate VAPID keys in cPanel and add them to api/config.php.");
    return;
  }
  const reg = await ensureServiceWorker();
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("You denied notification permission. Re-enable it in your browser settings to receive push alerts.");
    pushState.permission = perm;
    render();
    return;
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushState.vapidPublicKey),
    });
  }
  const json = sub.toJSON();
  await apiRequest("push-subscribe.php", {
    method: "POST",
    body: JSON.stringify({
      action: "subscribe",
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    }),
  });
  await refreshPushStatus();
  render();
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    try {
      await apiRequest("push-subscribe.php", { method: "POST", body: JSON.stringify({ action: "unsubscribe", endpoint }) });
    } catch (e) { /* fine — server-side row may already be gone */ }
  }
  await refreshPushStatus();
  render();
}

function renderPushStatus() {
  const node = document.getElementById("pushStatus");
  if (!node) return;
  if (!auth.authenticated) { node.innerHTML = ""; return; }
  if (!pushState.supported) {
    node.innerHTML = '<div class="modal-note">This browser does not support push notifications.</div>';
    return;
  }
  if (pushState.permission === "denied") {
    node.innerHTML = '<div class="modal-note">Notifications are blocked at the browser level. Allow them in your browser settings to receive push alerts.</div>';
    return;
  }
  if (!pushState.vapidPublicKey) {
    node.innerHTML = '<div class="modal-note">Server push is not configured yet. Run <code>api/cron/generate-vapid.php</code> on the server and paste the keys into config.php.</div>';
    return;
  }
  const subs = pushState.subscriptions.length;
  const thisDevice = pushState.subscribed ? "This device is subscribed." : "This device is not subscribed.";
  node.innerHTML = `
    <div class="push-status">
      <div class="push-status-row">
        <span class="muted mono">Push status</span>
        <span class="${pushState.subscribed ? "green" : "muted"} mono">${thisDevice}</span>
      </div>
      <div class="push-status-row">
        <span class="muted mono">Total devices</span>
        <span class="mono">${subs}</span>
      </div>
      <div class="toolbar-row" style="margin-top:10px;">
        ${pushState.subscribed
          ? '<button class="btn btn-ghost" id="pushDisableBtn" type="button">Disable on this device</button>'
          : '<button class="btn btn-primary" id="pushEnableBtn" type="button">Enable browser push</button>'}
      </div>
    </div>`;
  const enableBtn = document.getElementById("pushEnableBtn");
  if (enableBtn) enableBtn.onclick = () => enablePush().catch(e => alert(e.message));
  const disableBtn = document.getElementById("pushDisableBtn");
  if (disableBtn) disableBtn.onclick = () => disablePush().catch(e => alert(e.message));
}


// =====================
// Invitations (admin only)
// =====================
let invitationsCache = [];

async function loadInvitations() {
  if (!auth.configured || !auth.authenticated || !auth.isAdmin) { invitationsCache = []; return; }
  try {
    const r = await apiRequest("invitations.php");
    invitationsCache = Array.isArray(r.invitations) ? r.invitations : [];
  } catch (e) {
    setAuthMessage(e.message);
  }
}

async function createInvitation(email, note) {
  const result = await apiRequest("invitations.php", {
    method: "POST",
    body: JSON.stringify({ action: "create", email, note: note || null })
  });
  await loadInvitations();
  return result;
}

async function revokeInvitation(id) {
  await apiRequest("invitations.php", { method: "POST", body: JSON.stringify({ action: "revoke", id }) });
  await loadInvitations();
}

async function resendInvitation(id) {
  return await apiRequest("invitations.php", { method: "POST", body: JSON.stringify({ action: "resend", id }) });
}

function renderInvitations() {
  const node = document.getElementById("invitationsPanel");
  if (!node) return;
  if (!auth.isAdmin) { node.innerHTML = ""; return; }
  const items = invitationsCache;
  const counts = items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
  node.innerHTML = `
    <div class="cell-head" style="margin-top:36px;">
      <h2 class="cell-title">Beta invitations</h2>
      <span class="sec-badge">${items.length} total</span>
    </div>
    <p class="muted small" style="margin-bottom:14px;">Send a private-beta invite. The recipient gets an email with a one-time link that expires in 14 days.</p>
    <form id="inviteForm" class="invite-form">
      <div class="form-grid">
        <label class="wide">Email<input name="email" type="email" required placeholder="newuser@example.com"></label>
        <label class="wide">Note (optional)<input name="note" placeholder="Hey, beta-testing this finance app — would love your feedback" maxlength="500"></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" type="submit">Send Invitation</button>
        <span class="muted mono small" id="inviteFormStatus"></span>
      </div>
    </form>
    ${items.length ? `
      <div class="invitations-list">
        ${items.map(i => `
          <div class="invitation-row invitation-${i.status}">
            <div>
              <div class="invitation-email">${i.email}</div>
              <div class="invitation-meta">
                <span class="invitation-pill ${i.status}">${i.status}</span>
                ${i.acceptedAt ? `<span class="muted mono">accepted ${i.acceptedAt.slice(0, 10)}</span>` : ""}
                ${i.status === "pending" ? `<span class="muted mono">expires ${i.expiresAt.slice(0, 10)}</span>` : ""}
                ${i.status === "expired" ? `<span class="muted mono">expired ${i.expiresAt.slice(0, 10)}</span>` : ""}
                ${i.note ? `<span class="muted">${i.note}</span>` : ""}
              </div>
            </div>
            <div class="invitation-actions">
              ${i.status === "pending" ? `<button class="btn btn-ghost" type="button" data-invite-action="resend" data-invite-id="${i.id}">Resend</button>` : ""}
              ${i.status === "pending" || i.status === "expired" ? `<button class="btn btn-danger" type="button" data-invite-action="revoke" data-invite-id="${i.id}">Revoke</button>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    ` : "<div class='empty' style='padding:14px 0'>No invitations sent yet.</div>"}`;

  const form = document.getElementById("inviteForm");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const status = document.getElementById("inviteFormStatus");
      if (status) status.textContent = "Sending…";
      try {
        const result = await createInvitation(data.email.trim(), (data.note || "").trim());
        if (status) status.textContent = result.message || "Invitation sent.";
        form.reset();
        renderInvitations();
      } catch (err) {
        if (status) status.textContent = err.message;
      }
    };
  }
}

// =====================
// Invitation redemption (public ?invite= flow)
// =====================
let pendingInvite = null;

async function detectInviteToken() {
  const token = new URLSearchParams(window.location.search).get("invite");
  if (!token) return false;
  try {
    const r = await apiRequest(`invitations.php?token=${encodeURIComponent(token)}`);
    pendingInvite = { token, email: r.email, expiresAt: r.expiresAt };
    return true;
  } catch (e) {
    pendingInvite = { token, error: e.message };
    return true;
  }
}

function renderInviteRedeem() {
  const gate = document.getElementById("authGate");
  if (!pendingInvite || !gate) return;
  // Replace the auth panel's body with a redeem flow
  const panel = gate.querySelector(".auth-panel");
  if (!panel || panel.dataset.mode === "invite") return;
  panel.dataset.mode = "invite";
  if (pendingInvite.error) {
    panel.innerHTML = `
      <div class="wordmark auth-wordmark"><img class="wordmark-logo" src="logo.png" alt=""><span class="wordmark-text">My DailyEdge</span></div>
      <p class="hero-eyebrow">Invitation</p>
      <h1>Invitation unavailable</h1>
      <p class="auth-copy">${pendingInvite.error}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" id="inviteToLogin">Continue to sign in</button>
      </div>`;
    document.getElementById("inviteToLogin").onclick = () => {
      pendingInvite = null;
      panel.dataset.mode = "";
      // Strip ?invite= from URL
      const u = new URL(window.location.href);
      u.searchParams.delete("invite");
      window.history.replaceState({}, "", u.toString());
      // Force a normal auth render
      panel.innerHTML = "";
      window.location.reload();
    };
    gate.hidden = false;
    return;
  }

  panel.innerHTML = `
    <div class="wordmark auth-wordmark"><img class="wordmark-logo" src="logo.png" alt=""><span class="wordmark-text">My DailyEdge</span></div>
    <p class="hero-eyebrow">Private beta invitation</p>
    <h1>Welcome — set your password</h1>
    <p class="auth-copy">You've been invited to My DailyEdge. Pick a password to create your account.</p>
    <form id="inviteRedeemForm" class="auth-form">
      <label>Email<input type="email" value="${pendingInvite.email}" readonly disabled></label>
      <label>Password<input name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="At least 10 characters"></label>
      <div class="modal-actions">
        <button class="btn btn-primary" type="submit">Create Account</button>
      </div>
    </form>
    <div class="modal-note" id="inviteRedeemMessage"></div>`;
  gate.hidden = false;
  document.getElementById("inviteRedeemForm").onsubmit = async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    const msg = document.getElementById("inviteRedeemMessage");
    msg.textContent = "Creating account…";
    try {
      const result = await apiRequest("invitations.php", {
        method: "POST",
        body: JSON.stringify({ action: "redeem", token: pendingInvite.token, password })
      });
      if (result.csrfToken) auth.csrfToken = result.csrfToken;
      pendingInvite = null;
      panel.dataset.mode = "";
      // Clean the URL
      const u = new URL(window.location.href);
      u.searchParams.delete("invite");
      window.history.replaceState({}, "", u.toString());
      await refreshAuthStatus();
      await loadServerState();
      await loadSnapshots();
      await loadAlerts();
      gate.hidden = true;
      render();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
}

function setupMobileMenu() {
  const btn = document.getElementById("mobileMenuBtn"); const nav = document.getElementById("topbarCenter");
  if (!btn || !nav) return;
  function setOpen(open) { btn.setAttribute("aria-expanded", open ? "true" : "false"); nav.classList.toggle("open", open); document.body.style.overflow = open ? "hidden" : ""; }
  btn.addEventListener("click", () => setOpen(btn.getAttribute("aria-expanded") !== "true"));
  nav.addEventListener("click", e => { if (e.target.closest("[data-tab]")) setOpen(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") setOpen(false); });
  window.addEventListener("resize", () => { if (window.innerWidth > 780 && btn.getAttribute("aria-expanded") === "true") setOpen(false); });
}

async function initApp() {
  setupMobileMenu();
  setupUserChip();
  renderClock();
  await refreshAuthStatus();

  // If the URL has an ?invite= token, route into the redemption flow before anything else
  if (auth.configured && !auth.authenticated && await detectInviteToken()) {
    renderInviteRedeem();
    return;
  }

  if (auth.configured && auth.authenticated) {
    await loadServerState();
    await refreshChartHistory(state.chartRange, true);
    await loadAlerts();
    await loadSnapshots();
    if (auth.isAdmin) await loadInvitations();
  }
  await refreshPushStatus();
  render();
}


if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data && event.data.type === "navigate" && typeof event.data.url === "string") {
      const u = new URL(event.data.url, window.location.origin);
      const tab = u.searchParams.get("tab");
      if (tab) { switchTab(tab); render(); }
    }
  });
}


(function honorTabQueryParam() {
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (tab) document.addEventListener("DOMContentLoaded", () => switchTab(tab));
})();

setInterval(renderClock, 1000);
setInterval(() => { if (auth.configured && auth.authenticated && state.assets.length && !document.hidden) refreshLiveData(true); }, 300000);
setInterval(async () => { if (auth.configured && auth.authenticated && !document.hidden) { await loadAlerts(); renderAlerts(); renderAlertBanner(); } }, 60000);
initApp();
