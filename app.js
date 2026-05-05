"use strict";

const STORE_KEY = "dailyedge.v1";
const API_BASE = "api";
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const money = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = value => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));
const DEMO_SYMBOLS = new Set(["NVDA", "AAPL", "VOO", "BTC", "TSLA"]);
const DEMO_CLEANUP_VERSION = 4;
const CHART_RANGES = [["24h","24H"],["7d","7D"],["1m","1M"],["6m","6M"],["ytd","YTD"],["all","ALL"]];
const DEFAULT_PROFILE = { displayName: "", baseCurrency: "USD", timeZone: "America/New_York", investingStyle: "Long-term", notes: "" };

const seedState = {
  selectedSymbol: null, selectedTaskId: null, selectedIdeaId: null, selectedSnapshotId: null,
  taskFilter: "open", ideaFilter: "all", newsFilter: "all",
  chartMode: "asset", chartRange: "1m", chartStyle: "area",
  apiKey: "", assets: [], trades: [], tasks: [], ideas: [], news: [], snapshots: [], priceHistory: {},
  profile: { ...DEFAULT_PROFILE }, demoCleanupVersion: DEMO_CLEANUP_VERSION
};

let state = loadState();
let auth = { checked: false, configured: false, authenticated: false, registrationOpen: false, marketDataConfigured: false, marketDataProvider: "", newsDataConfigured: false, user: null, error: "", csrfToken: "" };
let serverStateVersion = 0;
let pendingConflict = null;
let syncTimer = null;
let suppressSync = false;

function addDays(dateString, days) { const d = new Date(`${dateString}T00:00:00`); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function loadState() { const stored = localStorage.getItem(STORE_KEY); if (!stored) return structuredClone(seedState); try { return migrateState({ ...structuredClone(seedState), ...JSON.parse(stored) }); } catch { return structuredClone(seedState); } }

function migrateState(nextState) {
  nextState.priceHistory ||= {};
  nextState.chartMode ||= "asset"; nextState.chartRange ||= "1m"; nextState.chartStyle ||= "area"; nextState.newsFilter ||= "all";
  nextState.profile = { ...DEFAULT_PROFILE, ...(nextState.profile || {}) };
  const hasDemoAssets = Array.isArray(nextState.assets) && nextState.assets.some(a => DEMO_SYMBOLS.has(a.symbol));
  const hasDemoTradeIds = Array.isArray(nextState.trades) && nextState.trades.some(t => /^t[1-7]$/.test(String(t.id)));
  if (hasDemoAssets || hasDemoTradeIds || Number(nextState.demoCleanupVersion || 0) < DEMO_CLEANUP_VERSION) nextState = removeDemoData(nextState);
  return nextState;
}

function removeDemoData(nextState) {
  nextState.assets = (nextState.assets || []).filter(a => !DEMO_SYMBOLS.has(a.symbol));
  nextState.trades = (nextState.trades || []).filter(t => !DEMO_SYMBOLS.has(t.symbol) && !/^t[1-7]$/.test(String(t.id)));
  nextState.tasks = (nextState.tasks || []).filter(t => !String(t.id || "").startsWith("task-"));
  nextState.ideas = (nextState.ideas || []).filter(i => !String(i.id || "").startsWith("idea-"));
  nextState.news = (nextState.news || []).filter(n => n.source !== "Sample Intel");
  if (DEMO_SYMBOLS.has(nextState.selectedSymbol)) nextState.selectedSymbol = nextState.assets[0]?.symbol || null;
  nextState.selectedTaskId = nextState.tasks[0]?.id || null;
  nextState.selectedIdeaId = nextState.ideas[0]?.id || null;
  delete nextState.demoDataCleared;
  nextState.demoCleanupVersion = DEMO_CLEANUP_VERSION;
  return nextState;
}

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
async function saveServerState(force = false) {
  if (!auth.configured || !auth.authenticated) return;
  try {
    const versionToSend = force ? "force" : serverStateVersion;
    const result = await apiRequest("state.php", {
      method: "PUT",
      body: JSON.stringify({ state, version: versionToSend })
    });
    if (typeof result.version === "number") serverStateVersion = result.version;
    pendingConflict = null;
    renderConflictBanner();
    setAuthMessage("Synced to MySQL.");
  } catch (e) {
    if (e.status === 409 && e.data) {
      // Stash the conflict — frontend banner will let user resolve
      pendingConflict = {
        serverVersion: e.data.serverVersion ?? 0,
        clientVersion: e.data.clientVersion ?? serverStateVersion,
        message: e.message
      };
      renderConflictBanner();
      setAuthMessage(e.message);
      return;
    }
    setAuthMessage(e.message);
  }
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
  try { const r = await apiRequest("status.php"); auth = { checked: true, configured: Boolean(r.configured), authenticated: Boolean(r.authenticated), registrationOpen: Boolean(r.registrationOpen), marketDataConfigured: Boolean(r.marketDataConfigured), marketDataProvider: r.marketDataProvider || "", newsDataConfigured: Boolean(r.newsDataConfigured), user: r.user || null, error: "", csrfToken: r.csrfToken || "" }; }
  catch (e) { auth = { checked: true, configured: Boolean(e.data?.configured), authenticated: false, registrationOpen: false, marketDataConfigured: false, marketDataProvider: "", newsDataConfigured: false, user: null, error: e.message, csrfToken: "" }; }
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

function buildLots(symbol) {
  if (!symbol) return [];
  const lots = [];
  getTrades(symbol).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(trade => {
    const quantity = Number(trade.quantity || 0); const price = Number(trade.price || 0); const fees = Number(trade.fees || 0);
    if (trade.action === "buy" || trade.action === "deposit") lots.push({ id: trade.id, symbol, date: trade.date, quantity, remaining: quantity, cost: quantity * price + fees, unitCost: quantity ? (quantity * price + fees) / quantity : 0 });
    if (trade.action === "sell" || trade.action === "withdraw") {
      let r = quantity;
      for (const lot of lots) { if (r <= 0) break; const used = Math.min(lot.remaining, r); lot.remaining -= used; r -= used; }
    }
  });
  return lots.filter(l => l.remaining > 0.0000001);
}

function positionFor(asset) {
  if (!asset) return null;
  const lots = buildLots(asset.symbol);
  const quantity = lots.reduce((s, l) => s + l.remaining, 0);
  const cost = lots.reduce((s, l) => s + l.remaining * l.unitCost, 0);
  const value = quantity * Number(asset.price || 0);
  const dayChangePct = asset.previousClose ? ((asset.price - asset.previousClose) / asset.previousClose) * 100 : 0;
  const gain = value - cost; const gainPct = cost ? (gain / cost) * 100 : 0;
  return { ...asset, quantity, cost, value, dayChangePct, gain, gainPct, lots };
}

function portfolio() {
  const positions = state.assets.map(positionFor);
  const value = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const previousValue = positions.reduce((s, p) => s + p.quantity * Number(p.previousClose || p.price || 0), 0);
  const dayPnl = value - previousValue; const dayPct = previousValue ? (dayPnl / previousValue) * 100 : 0;
  const gain = value - cost; const gainPct = cost ? (gain / cost) * 100 : 0;
  return { positions, value, cost, dayPnl, dayPct, gain, gainPct };
}

function estimateTax({ symbol, quantity, price, date, shortRate, longRate }) {
  let remaining = Number(quantity || 0); const salePrice = Number(price || 0); const saleDate = new Date(`${date}T00:00:00`); const rows = [];
  buildLots(symbol).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(lot => {
    if (remaining <= 0) return;
    const qty = Math.min(lot.remaining, remaining);
    const proceeds = qty * salePrice; const basis = qty * lot.unitCost; const gain = proceeds - basis;
    const daysHeld = Math.round((saleDate - new Date(`${lot.date}T00:00:00`)) / 86400000);
    const term = daysHeld >= 365 ? "long" : "short";
    const tax = gain > 0 ? gain * ((term === "long" ? Number(longRate) : Number(shortRate)) / 100) : 0;
    rows.push({ qty, date: lot.date, unitCost: lot.unitCost, proceeds, basis, gain, term, tax });
    remaining -= qty;
  });
  return { rows, remaining, proceeds: rows.reduce((s, r) => s + r.proceeds, 0), basis: rows.reduce((s, r) => s + r.basis, 0), gain: rows.reduce((s, r) => s + r.gain, 0), tax: rows.reduce((s, r) => s + r.tax, 0) };
}

function render() { saveState(); renderClock(); renderTopState(); updateAuthGate(); renderOverview(); renderPortfolio(); renderTasks(); renderIntel(); renderIdeas(); renderHistory(); renderProfile(); hydrateSelects(); renderConflictBanner(); }
function renderClock() { document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); document.getElementById("overviewTitle").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }); }

function renderTopState() {
  if (!auth.checked) { document.getElementById("liveState").textContent = "Loading"; return; }
  if (auth.configured && auth.authenticated) { document.getElementById("liveState").textContent = auth.marketDataConfigured ? "Live Sync" : "Synced"; document.getElementById("authBtn").textContent = "LO"; document.getElementById("authBtn").title = auth.user?.email || "Log out"; return; }
  if (auth.configured) { document.getElementById("liveState").textContent = auth.error ? "Setup" : "Login"; document.getElementById("authBtn").textContent = "AC"; return; }
  document.getElementById("liveState").textContent = state.apiKey ? "Live API" : "Local"; document.getElementById("authBtn").textContent = "AC";
}

function renderOverview() {
  const port = portfolio();
  const openTasks = state.tasks.filter(t => !t.done);
  const todayTasks = openTasks.filter(t => t.due && t.due <= todayISO());
  const committedIdeas = state.ideas.filter(i => i.stage === "committed").length;
  document.getElementById("dailyBrief").textContent = `${port.dayPnl >= 0 ? "Portfolio is higher" : "Portfolio is lower"} today with ${todayTasks.length} time-sensitive tasks and ${state.news.length} intel items in the queue.`;
  document.getElementById("overviewSummary").innerHTML = [
    metric("Portfolio Value", money(port.value), `${pct(port.dayPct)} today`, port.dayPnl >= 0 ? "up" : "dn"),
    metric("Invested Capital", money(port.cost), `${money(port.gain)} total P&L`, port.gain >= 0 ? "up" : "dn"),
    metric("Open Tasks", openTasks.length, `${todayTasks.length} due now`, todayTasks.length ? "accent" : ""),
    metric("Ideas", state.ideas.length, `${committedIdeas} committed`, "accent")
  ].join("");
  document.getElementById("overviewPortfolio").innerHTML = port.positions.sort((a, b) => b.value - a.value).map(p => positionMini(p, port.value)).join("");
  document.getElementById("overviewTasks").innerHTML = state.tasks.filter(t => !t.done).sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 5).map(t => compactRow(t.title, `${t.category} | ${t.due || "No due date"}`, t.priority === "High" ? "accent" : "")).join("") || empty("No open tasks");
  document.getElementById("overviewIntel").innerHTML = state.news.slice(0, 5).map((item, i) => newsMini(item, i)).join("") || empty("No intel yet");
  document.getElementById("overviewIdeas").innerHTML = state.ideas.slice(0, 5).map(i => compactRow(i.title, `${i.stage} | impact ${i.impact}/5`, i.stage)).join("");
  document.getElementById("overviewHistory").innerHTML = state.snapshots.slice(0, 5).map(s => compactRow(s.title, `${money(s.portfolio.value)} | ${pct(s.portfolio.dayPct)}`, s.portfolio.dayPnl >= 0 ? "green" : "red")).join("") || empty("Capture your first snapshot");
}

function metric(label, value, sub, tone = "") { return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${tone}">${value}</div><div class="metric-sub">${sub}</div></div>`; }
function positionMini(pos, total) { const w = total ? (pos.value / total) * 100 : 0; return `<div class="position-item" data-select-asset="${pos.symbol}"><div class="row-top"><div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div><div class="price-block"><div class="mono">${money(pos.value)}</div><div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)}</div></div></div><div class="alloc-track"><div class="alloc-fill" style="width:${Math.min(100, w)}%;background:${pos.color}"></div></div></div>`; }
function compactRow(title, meta, tone = "") { return `<div class="activity-row"><div><div>${title}</div><div class="muted mono">${meta}</div></div><span class="dot ${tone === "green" || tone === "committed" ? "green" : "accent"}"></span></div>`; }
function newsMini(item, index) { return `<div class="activity-row"><span class="news-num">${String(index + 1).padStart(2, "0")}</span><div><div>${item.title}</div><div class="muted mono">${item.symbol} | ${item.source} | ${item.date}</div></div></div>`; }
function empty(text) { return `<div class="empty">${text}</div>`; }
function cleanUrl(url) { const v = String(url || "").trim(); if (!v) return ""; try { const p = new URL(v); return p.protocol === "http:" || p.protocol === "https:" ? p.href : ""; } catch { return ""; } }

function renderPortfolio() {
  const port = portfolio();
  const selectedAsset = getAsset();
  const selected = selectedAsset ? positionFor(selectedAsset) : null;
  const linkedCount = port.positions.filter(p => p.marketDataLinked !== false && p.type !== "cash" && p.type !== "other").length;
  const zeroLotCount = port.positions.filter(p => p.quantity <= 0).length;
  document.getElementById("positionCount").textContent = `${port.positions.length} assets`;
  document.getElementById("portfolioSummary").innerHTML = `
    <div class="summary-value">${money(port.value)}</div>
    <div class="summary-row">
      <div class="summary-stat"><strong class="${port.dayPnl >= 0 ? "up" : "dn"}">${money(port.dayPnl)}</strong><span>Today P&L</span></div>
      <div class="summary-stat"><strong class="${port.dayPct >= 0 ? "up" : "dn"}">${pct(port.dayPct)}</strong><span>Day return</span></div>
      <div class="summary-stat"><strong class="${port.gain >= 0 ? "up" : "dn"}">${money(port.gain)}</strong><span>All-time P&L</span></div>
    </div>
    <div class="alloc-stack">${allocationPieces(port)}</div>
    <div class="portfolio-health">
      <div class="health-card"><strong>${linkedCount}/${port.positions.length}</strong><span>Live linked</span></div>
      <div class="health-card"><strong>${zeroLotCount}</strong><span>Need lots</span></div>
      <div class="health-card"><strong>${auth.marketDataProvider || (auth.marketDataConfigured ? "Yahoo" : "Manual")}</strong><span>Quote source</span></div>
      <div class="health-card"><strong>${port.positions.length ? "5 min" : "Paused"}</strong><span>Auto refresh</span></div>
    </div>
    <div class="toolbar-row" style="margin-top:14px">
      <button class="btn btn-primary" id="portfolioRefreshBtn" type="button">Refresh Live</button>
      <button class="btn btn-ghost" id="clearDemoBtn" type="button">Clear Demo</button>
    </div>`;
  document.getElementById("positionList").innerHTML = port.positions.length ? port.positions.sort((a, b) => b.value - a.value).map(pos => `
    <div class="position-item ${pos.symbol === selected.symbol ? "active" : ""}" data-select-asset="${pos.symbol}">
      <div class="row-top">
        <div class="asset-title-row"><span class="dot" style="background:${pos.color}"></span><div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div></div>
        <div class="price-block"><div class="mono">${money(pos.value)}</div><div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)}</div></div>
      </div>
      <div class="row-meta">
        <span class="muted mono">${pos.quantity.toFixed(pos.type === "crypto" ? 4 : 2)} units</span>
        <span class="muted mono">${pos.quantity <= 0 ? "Add lot" : (pos.marketDataLinked === false ? "Manual" : "Live")}</span>
        <span class="muted mono">${port.value ? (pos.value / port.value * 100).toFixed(1) : "0.0"}%</span>
      </div>
      <div class="row-meta pnl-row">
        <span class="${pos.gain >= 0 ? "up" : "dn"} mono">P&L ${money(pos.gain)}</span>
        <span class="${pos.gainPct >= 0 ? "up" : "dn"} mono">${pct(pos.gainPct)}</span>
      </div>
    </div>`).join("") : `<div class="summary-card"><div class="empty">No positions yet</div><button class="btn btn-primary full" data-open-modal="assetModal">Add Position</button></div>`;
  if (selected) renderAssetDetail(selected); else renderEmptyPortfolioDetail();
  renderChart(port, selected);
  document.getElementById("connectionPanel").innerHTML = renderConnectionPanel(port);
}

function allocationPieces(port) { if (!port.value) return `<div class="alloc-piece" style="width:100%;background:var(--line2)"></div>`; return port.positions.filter(p => p.value > 0).sort((a, b) => b.value - a.value).map(p => `<div class="alloc-piece" title="${p.symbol}" style="width:${Math.max(1, p.value / port.value * 100)}%;background:${p.color}"></div>`).join(""); }
function renderConnectionPanel(port) { const linked = port.positions.filter(p => p.marketDataLinked !== false && p.type !== "cash" && p.type !== "other").length; return `<div class="connection-row"><span>Market quotes</span><span>${auth.marketDataProvider || (auth.marketDataConfigured ? "Yahoo Finance" : "Manual only")}</span></div><div class="connection-row"><span>Linked holdings</span><span>${linked}/${port.positions.length}</span></div><div class="connection-row"><span>Position news</span><span>${auth.newsDataConfigured ? "Alpha + Yahoo" : "Yahoo fallback"}</span></div><div class="connection-row"><span>RSS feeds</span><span>The Block · CoinDesk · Cointelegraph · Yahoo</span></div><div class="connection-row"><span>Brokerage import</span><span>Plaid or SnapTrade recommended</span></div>`; }

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

function renderTasks() {
  const filters = [["open", "Open"], ["today", "Today"], ["finance", "Finance"], ["done", "Done"]];
  document.getElementById("taskCount").textContent = String(state.tasks.length);
  document.getElementById("taskFilters").innerHTML = filters.map(([id, label]) => `<div class="nav-item ${state.taskFilter === id ? "active" : ""}" data-task-filter="${id}"><span class="nav-name">${label}</span><span class="nav-count">${filterTasks(id).length}</span></div>`).join("");
  document.getElementById("taskStats").innerHTML = `<div class="db-row"><span>Completed</span><span class="green">${state.tasks.filter(t => t.done).length}</span></div><div class="db-row"><span>Due now</span><span class="accent">${filterTasks("today").length}</span></div><div class="db-row"><span>Finance</span><span>${filterTasks("finance").length}</span></div>`;
  document.querySelectorAll("[data-task-filter]").forEach(b => b.classList.toggle("active", b.dataset.taskFilter === state.taskFilter));
  document.getElementById("taskList").innerHTML = filterTasks(state.taskFilter).sort((a, b) => Number(a.done) - Number(b.done) || String(a.due).localeCompare(String(b.due))).map(task => `<div class="list-row ${task.id === state.selectedTaskId ? "selected" : ""}" data-select-task="${task.id}"><button class="check ${task.done ? "done" : ""}" data-toggle-task="${task.id}" aria-label="Toggle task"></button><div><div class="${task.done ? "muted" : ""}">${task.title}</div><div class="row-meta"><span class="tag ${task.category.toLowerCase()}">${task.category}</span><span class="mono muted">${task.due || "No due date"}</span><span class="mono ${task.priority === "High" ? "accent" : "muted"}">${task.priority}</span></div></div></div>`).join("") || empty("No tasks in this filter");
  renderTaskDetail();
}

function filterTasks(filter) {
  if (filter === "done") return state.tasks.filter(t => t.done);
  if (filter === "today") return state.tasks.filter(t => !t.done && t.due && t.due <= todayISO());
  if (filter === "finance") return state.tasks.filter(t => !t.done && t.category === "Finance");
  return state.tasks.filter(t => !t.done);
}

function renderTaskDetail() {
  const task = state.tasks.find(t => t.id === state.selectedTaskId) || state.tasks[0];
  const node = document.getElementById("taskDetail");
  if (!task) { node.innerHTML = empty("Select a task"); return; }
  node.innerHTML = `<div class="detail-card"><h2>${task.title}</h2><div class="row-meta"><span class="tag ${task.category.toLowerCase()}">${task.category}</span><span class="tag">${task.priority}</span>${task.symbol ? `<span class="tag stock">${task.symbol}</span>` : ""}</div><p>${task.notes || "No notes yet."}</p><div class="db-row"><span>Due</span><span>${task.due || "None"}</span></div><div class="db-row"><span>Status</span><span class="${task.done ? "green" : "accent"}">${task.done ? "Done" : "Open"}</span></div><div class="modal-actions"><button class="btn btn-primary" data-toggle-task="${task.id}">${task.done ? "Reopen" : "Complete"}</button><button class="btn btn-danger" data-delete-task="${task.id}">Delete</button></div></div>`;
}

function filterNews() {
  const filter = state.newsFilter || "all";
  const tickers = new Set(state.assets.map(a => a.symbol).filter(Boolean));
  const cryptoTickers = new Set(["BTC","ETH","SOL","ADA","XRP","DOGE","AVAX","LINK","LTC","BCH"]);
  return state.news.filter(item => {
    if (filter === "all") return true;
    if (filter === "portfolio") return tickers.has(item.symbol);
    if (filter === "crypto") return ["theblock","coindesk","cointelegraph"].includes(item.sourceKey || "") || (item.category || "").toLowerCase() === "crypto" || cryptoTickers.has(String(item.symbol).toUpperCase());
    if (filter === "markets") return (item.category || "").toLowerCase() === "markets" || item.sourceKey === "yahoo";
    if (filter === "research") { const s = String(item.sentiment || "").toLowerCase(); return s !== "neutral" && s !== ""; }
    return true;
  });
}

function sourceLogoChip(item) { const key = (item.sourceKey || "").toLowerCase(); const label = item.source || "Source"; return `<span class="news-source ${key}">${label}</span>`; }

function renderIntel() {
  const positions = portfolio().positions;
  document.getElementById("watchCount").textContent = String(positions.length);
  document.getElementById("apiKey").value = auth.configured ? (auth.marketDataConfigured ? `${auth.marketDataProvider || "Server quotes"} · multi-source RSS` : "Market data unavailable") : (state.apiKey ? "Browser fallback key saved" : "Backend not configured");
  document.getElementById("watchList").innerHTML = positions.map(pos => `<div class="nav-item" data-select-asset="${pos.symbol}"><span class="nav-name">${pos.symbol}</span><span class="nav-count">${pct(pos.dayChangePct)}</span></div>`).join("") || empty("Add positions to build your watchlist.");
  document.querySelectorAll("[data-news-filter]").forEach(b => b.classList.toggle("active", b.dataset.newsFilter === (state.newsFilter || "all")));
  const filtered = filterNews();
  document.getElementById("newsFeed").innerHTML = filtered.map((item, index) => {
    const sentimentKey = String(item.sentiment || "neutral").toLowerCase().replace(/\s+/g, "-");
    const showTicker = item.symbol && item.symbol !== "MKT";
    return `<article class="news-row"><span class="news-num">${String(index + 1).padStart(2, "0")}</span><div><div class="row-meta">${showTicker ? `<span class="tag stock">${item.symbol}</span>` : ""}${sourceLogoChip(item)}<span class="mono muted">${item.date || ""}</span></div><h2 class="news-title">${cleanUrl(item.url) ? `<a href="${cleanUrl(item.url)}" target="_blank" rel="noopener noreferrer">${item.title}</a>` : item.title}</h2><div class="news-meta"><span class="sentiment-pill ${sentimentKey}">${item.sentiment || "Neutral"}</span>${item.category ? `<span class="mono muted">${item.category}</span>` : ""}</div></div></article>`;
  }).join("") || empty("Refresh Intel to pull headlines from The Block, CoinDesk, Cointelegraph, Yahoo Finance, and your tickers.");
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

function renderIdeas() {
  const filters = [["all","All"],["raw","Raw"],["research","Research"],["committed","Committed"]];
  document.getElementById("ideaCount").textContent = String(state.ideas.length);
  document.getElementById("ideaFilters").innerHTML = filters.map(([id, label]) => `<div class="nav-item ${state.ideaFilter === id ? "active" : ""}" data-idea-filter="${id}"><span class="nav-name">${label}</span><span class="nav-count">${filterIdeas(id).length}</span></div>`).join("");
  document.getElementById("ideaStats").innerHTML = `<div class="db-row"><span>Committed</span><span class="green">${filterIdeas("committed").length}</span></div><div class="db-row"><span>Research</span><span class="accent">${filterIdeas("research").length}</span></div><div class="db-row"><span>Raw</span><span>${filterIdeas("raw").length}</span></div>`;
  document.querySelectorAll("[data-idea-filter]").forEach(b => b.classList.toggle("active", b.dataset.ideaFilter === state.ideaFilter));
  document.getElementById("ideaList").innerHTML = filterIdeas(state.ideaFilter).map(idea => `<div class="list-row ${idea.id === state.selectedIdeaId ? "selected" : ""}" data-select-idea="${idea.id}"><span class="dot ${idea.stage === "committed" ? "green" : "accent"}"></span><div><div>${idea.title}</div><div class="row-meta"><span class="tag ${idea.stage}">${idea.stage}</span><span class="tag ${idea.category.toLowerCase()}">${idea.category}</span><span class="mono muted">Impact ${idea.impact} | Effort ${idea.effort}</span></div></div></div>`).join("") || empty("No ideas here yet");
  renderIdeaDetail();
}

function filterIdeas(filter) { if (filter === "all") return state.ideas; return state.ideas.filter(i => i.stage === filter); }

function renderIdeaDetail() {
  const idea = state.ideas.find(i => i.id === state.selectedIdeaId) || state.ideas[0];
  const node = document.getElementById("ideaDetail");
  if (!idea) { node.innerHTML = empty("Select an idea"); return; }
  node.innerHTML = `<div class="detail-card"><h2>${idea.title}</h2><div class="row-meta"><span class="tag ${idea.stage}">${idea.stage}</span><span class="tag ${idea.category.toLowerCase()}">${idea.category}</span></div><p>${idea.notes || "No notes yet."}</p><div class="db-row"><span>Impact</span><span>${idea.impact}/5</span></div><div class="db-row"><span>Effort</span><span>${idea.effort}/5</span></div><div class="db-row"><span>Created</span><span>${idea.created}</span></div><div class="modal-actions"><button class="btn btn-ghost" data-promote-idea="${idea.id}">Advance</button><button class="btn btn-danger" data-delete-idea="${idea.id}">Delete</button></div></div>`;
}

function renderHistory() {
  document.getElementById("historyCount").textContent = String(state.snapshots.length);
  document.getElementById("historyList").innerHTML = state.snapshots.map(snap => `<div class="snapshot-row ${snap.id === state.selectedSnapshotId ? "active" : ""}" data-select-snapshot="${snap.id}"><div><div>${snap.title}</div><div class="muted mono">${snap.date}</div></div><div class="price-block"><div class="mono">${money(snap.portfolio.value)}</div><div class="mono ${snap.portfolio.dayPnl >= 0 ? "up" : "dn"}">${pct(snap.portfolio.dayPct)}</div></div></div>`).join("") || empty("No snapshots yet");
  const snap = state.snapshots.find(s => s.id === state.selectedSnapshotId) || state.snapshots[0];
  const node = document.getElementById("historyDetail");
  if (!snap) { node.innerHTML = `<div class="report"><h1 id="historyTitle">History</h1><p class="muted">Capture a snapshot to store daily portfolio value, open tasks, active ideas, and a short report.</p></div>`; return; }
  node.innerHTML = `<article class="report"><h1>${snap.title}</h1><div class="report-grid">${metric("Value", money(snap.portfolio.value), "Portfolio")}${metric("Today", money(snap.portfolio.dayPnl), pct(snap.portfolio.dayPct), snap.portfolio.dayPnl >= 0 ? "green" : "red")}${metric("Total P&L", money(snap.portfolio.gain), pct(snap.portfolio.gainPct), snap.portfolio.gain >= 0 ? "green" : "red")}${metric("Open Tasks", snap.tasks.open, `${snap.tasks.due} due`, "")}</div><section class="report-section"><h2>Daily Report</h2><p>${snap.report}</p></section><section class="report-section"><h2>Positions</h2>${snap.positions.map(pos => `<div class="db-row"><span>${pos.symbol}</span><span>${money(pos.value)} | ${pct(pos.dayChangePct)}</span></div>`).join("")}</section><section class="report-section"><h2>Ideas</h2>${snap.ideas.map(i => `<div class="db-row"><span>${i.title}</span><span>${i.stage}</span></div>`).join("")}</section></article>`;
}

function captureSnapshot() {
  const port = portfolio();
  const positions = port.positions.map(p => ({ symbol: p.symbol, value: p.value, dayChangePct: p.dayChangePct, gain: p.gain }));
  const openTasks = state.tasks.filter(t => !t.done);
  const dueTasks = openTasks.filter(t => t.due && t.due <= todayISO());
  const report = `Portfolio closed at ${money(port.value)} with ${money(port.dayPnl)} of daily movement (${pct(port.dayPct)}). Total unrealized P&L is ${money(port.gain)}. The biggest positions are ${positions.sort((a, b) => b.value - a.value).slice(0, 3).map(p => p.symbol).join(", ")}. There are ${openTasks.length} open tasks, ${dueTasks.length} due now, and ${state.ideas.filter(i => i.stage === "committed").length} committed ideas.`;
  const snap = { id: uid(), date: todayISO(), title: new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }), portfolio: { value: port.value, cost: port.cost, dayPnl: port.dayPnl, dayPct: port.dayPct, gain: port.gain, gainPct: port.gainPct }, positions, tasks: { open: openTasks.length, due: dueTasks.length }, ideas: state.ideas.map(({ title, stage }) => ({ title, stage })), report };
  state.snapshots.unshift(snap); state.selectedSnapshotId = snap.id; switchTab("history"); render();
}

function hydrateSelects() {
  const options = state.assets.map(a => `<option value="${a.symbol}">${a.symbol} - ${a.name}</option>`).join("");
  ["tradeAsset","taxAsset"].forEach(id => { const s = document.getElementById(id); if (s) { s.innerHTML = options; s.value = state.selectedSymbol; } });
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
  document.getElementById(id).classList.add("open"); document.getElementById(id).setAttribute("aria-hidden", "false");
  if (id === "tradeModal" && state.selectedSymbol) { const t = document.getElementById("tradeAsset"); if (t) t.value = state.selectedSymbol; }
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
  const symbol = data.symbol || state.selectedSymbol; if (!symbol) return;
  state.trades.push({ id: uid(), symbol, action: data.action, quantity: Number(data.quantity || 0), price: Number(data.price || 0), fees: Number(data.fees || 0), date: data.date, memo: data.memo.trim() });
  state.selectedSymbol = symbol;
}

function addTask(form) { const d = Object.fromEntries(new FormData(form).entries()); const t = { id: uid(), title: d.title.trim(), category: d.category, priority: d.priority, due: d.due, symbol: d.symbol, notes: d.notes.trim(), done: false }; state.tasks.unshift(t); state.selectedTaskId = t.id; }
function addIdea(form) { const d = Object.fromEntries(new FormData(form).entries()); const i = { id: uid(), title: d.title.trim(), stage: d.stage, category: d.category, impact: Number(d.impact || 3), effort: Number(d.effort || 3), created: todayISO(), notes: d.notes.trim() }; state.ideas.unshift(i); state.selectedIdeaId = i.id; }

async function refreshLiveData(silent = false) {
  if (auth.configured && !auth.authenticated) { if (!silent) alert("Sign in before refreshing server-side market data."); return; }
  if (auth.configured && auth.authenticated) {
    document.getElementById("liveState").textContent = "Refreshing";
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
      render();
    } catch (e) { if (!silent) alert(e.message); render(); }
    return;
  }
  if (!state.apiKey) { if (!silent) alert("Configure the server-side Alpha Vantage key in api/config.php, or save a browser fallback key in local mode."); return; }
  document.getElementById("liveState").textContent = "Refreshing";
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
      if (Array.isArray(result.news)) { state.news = result.news; setAuthMessage(result.provider ? `Intel refreshed via ${result.provider}.` : "Intel refreshed."); }
    } catch (e) { setAuthMessage(e.message); }
    return;
  }
  if (!state.apiKey) return;
  try {
    const tickers = state.assets.filter(a => a.type !== "cash" && a.type !== "other").map(a => a.symbol).join(",");
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&apikey=${encodeURIComponent(state.apiKey)}`;
    const result = await fetch(url).then(r => r.json());
    if (Array.isArray(result.feed)) {
      state.news = result.feed.slice(0, 25).map(item => ({ id: uid(), symbol: item.ticker_sentiment?.[0]?.ticker || "MKT", title: item.title, source: item.source || "Alpha Vantage", sourceKey: "alphavantage", url: item.url || "", date: String(item.time_published || todayISO()).slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), sentiment: item.overall_sentiment_label || "Neutral" }));
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
  const newsFilter = event.target.closest("[data-news-filter]")?.dataset.newsFilter;
  if (newsFilter) { state.newsFilter = newsFilter; render(); }
  const symbol = event.target.closest("[data-select-asset]")?.dataset.selectAsset;
  if (symbol) { state.selectedSymbol = symbol; render(); }
  const editAsset = event.target.closest("[data-edit-asset]")?.dataset.editAsset;
  if (editAsset) openAssetEditor(editAsset);
  const taskFilter = event.target.closest("[data-task-filter]")?.dataset.taskFilter;
  if (taskFilter) { state.taskFilter = taskFilter; render(); }
  const ideaFilter = event.target.closest("[data-idea-filter]")?.dataset.ideaFilter;
  if (ideaFilter) { state.ideaFilter = ideaFilter; render(); }
  const taskId = event.target.closest("[data-select-task]")?.dataset.selectTask;
  if (taskId) { state.selectedTaskId = taskId; render(); }
  const toggleTaskId = event.target.closest("[data-toggle-task]")?.dataset.toggleTask;
  if (toggleTaskId) { const t = state.tasks.find(i => i.id === toggleTaskId); if (t) t.done = !t.done; render(); }
  const deleteTaskId = event.target.closest("[data-delete-task]")?.dataset.deleteTask;
  if (deleteTaskId) { state.tasks = state.tasks.filter(t => t.id !== deleteTaskId); state.selectedTaskId = state.tasks[0]?.id || null; render(); }
  const ideaId = event.target.closest("[data-select-idea]")?.dataset.selectIdea;
  if (ideaId) { state.selectedIdeaId = ideaId; render(); }
  const promoteIdeaId = event.target.closest("[data-promote-idea]")?.dataset.promoteIdea;
  if (promoteIdeaId) { const idea = state.ideas.find(i => i.id === promoteIdeaId); if (idea) idea.stage = idea.stage === "raw" ? "research" : idea.stage === "research" ? "committed" : "committed"; render(); }
  const deleteIdeaId = event.target.closest("[data-delete-idea]")?.dataset.deleteIdea;
  if (deleteIdeaId) { state.ideas = state.ideas.filter(i => i.id !== deleteIdeaId); state.selectedIdeaId = state.ideas[0]?.id || null; render(); }
  const deleteTradeId = event.target.closest("[data-delete-trade]")?.dataset.deleteTrade;
  if (deleteTradeId && confirm("Delete this portfolio activity entry? This changes the holding quantity and tax lots.")) { state.trades = state.trades.filter(t => t.id !== deleteTradeId); render(); }
  const snapId = event.target.closest("[data-select-snapshot]")?.dataset.selectSnapshot;
  if (snapId) { state.selectedSnapshotId = snapId; render(); }
  if (event.target.closest("#portfolioRefreshBtn")) refreshLiveData();
  if (event.target.closest("#clearDemoBtn")) { state = removeDemoData(state); render(); }
});

document.getElementById("assetForm").addEventListener("submit", e => { e.preventDefault(); upsertAsset(e.currentTarget); e.currentTarget.reset(); setAssetLookupStatus("Lookup connects the asset to server-side market data for future refreshes."); closeModals(); render(); });
document.getElementById("assetLookupBtn").addEventListener("click", lookupAssetMarketData);
document.getElementById("tradeForm").addEventListener("submit", e => { e.preventDefault(); recordTrade(e.currentTarget); e.currentTarget.reset(); closeModals(); render(); });
document.getElementById("taskForm").addEventListener("submit", e => { e.preventDefault(); addTask(e.currentTarget); e.currentTarget.reset(); closeModals(); render(); });
document.getElementById("ideaForm").addEventListener("submit", e => { e.preventDefault(); addIdea(e.currentTarget); e.currentTarget.reset(); closeModals(); render(); });
document.getElementById("profileForm").addEventListener("submit", e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  state.profile = { displayName: d.displayName.trim(), baseCurrency: d.baseCurrency, timeZone: d.timeZone.trim() || DEFAULT_PROFILE.timeZone, investingStyle: d.investingStyle, notes: d.notes.trim() };
  const m = document.getElementById("profileMessage"); if (m) m.textContent = "Profile saved to your synced workspace."; render();
});
document.getElementById("taxForm").addEventListener("submit", e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries()); const result = estimateTax(d);
  document.getElementById("taxEstimateOutput").innerHTML = `${metric("Estimated Gain", money(result.gain), `${money(result.proceeds)} proceeds`, result.gain >= 0 ? "green" : "red")}<div class="db-row"><span>Cost basis</span><span>${money(result.basis)}</span></div><div class="db-row"><span>Federal estimate</span><span class="accent">${money(result.tax)}</span></div>${result.remaining > 0 ? `<div class="modal-note">Not enough open lots for ${result.remaining.toFixed(4)} units.</div>` : ""}${result.rows.map(r => `<div class="db-row"><span>${r.qty.toFixed(4)} from ${r.date} (${r.term})</span><span>${money(r.gain)}</span></div>`).join("")}`;
});

document.getElementById("saveApiKeyBtn").addEventListener("click", () => {
  if (auth.configured) { alert(auth.newsDataConfigured ? "Server-side quotes, Alpha Vantage news, and Yahoo + RSS fallbacks are configured." : "Server-side Yahoo quotes and multi-source RSS are active. Add alpha_vantage_api_key in public_html/api/config.php later for sentiment-enhanced news."); return; }
  const key = prompt("Optional local fallback Alpha Vantage key. Prefer server-side config for production.", state.apiKey || "");
  if (key !== null) { state.apiKey = key.trim(); render(); }
});

document.getElementById("refreshDataBtn").addEventListener("click", refreshLiveData);
document.getElementById("refreshNewsBtn").addEventListener("click", async () => { await refreshNews(); render(); });
document.getElementById("captureSnapshotBtn").addEventListener("click", captureSnapshot);
document.getElementById("historySnapshotBtn").addEventListener("click", captureSnapshot);

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `my-dailyedge-${todayISO()}.json`; link.click(); URL.revokeObjectURL(url);
});

document.getElementById("importFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  state = { ...structuredClone(seedState), ...JSON.parse(await file.text()) }; render();
});

document.getElementById("authBtn").addEventListener("click", async () => {
  if (auth.configured && auth.authenticated) { await apiRequest("auth.php", { method: "POST", body: JSON.stringify({ action: "logout" }) }); auth.authenticated = false; auth.user = null; updateAuthGate(); render(); return; }
  if (!auth.configured) { alert(auth.error || "Backend storage is not configured yet. Create api/config.php and install the MySQL schema to enable login."); return; }
  document.getElementById("authGate").hidden = false;
});

document.getElementById("showRegisterBtn").addEventListener("click", () => { document.getElementById("loginForm").hidden = true; document.getElementById("registerForm").hidden = false; setAuthMessage("Create the first account, then disable registration in api/config.php."); });
document.getElementById("showLoginBtn").addEventListener("click", () => { document.getElementById("registerForm").hidden = true; document.getElementById("loginForm").hidden = false; setAuthMessage(""); });

document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    const result = await apiRequest("auth.php", { method: "POST", body: JSON.stringify({ action: "login", email: d.email, password: d.password }) });
    if (result.csrfToken) auth.csrfToken = result.csrfToken;
    await refreshAuthStatus();
    await loadServerState();
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
  setupMobileMenu(); renderClock(); await refreshAuthStatus();
  if (auth.configured && auth.authenticated) { await loadServerState(); await refreshChartHistory(state.chartRange, true); }
  render();
}

setInterval(renderClock, 1000);
setInterval(() => { if (auth.configured && auth.authenticated && state.assets.length && !document.hidden) refreshLiveData(true); }, 300000);
initApp();
