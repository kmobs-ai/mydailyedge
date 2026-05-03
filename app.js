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

const seedState = {
  selectedSymbol: null,
  selectedTaskId: null,
  selectedIdeaId: null,
  selectedSnapshotId: null,
  taskFilter: "open",
  ideaFilter: "all",
  apiKey: "",
  assets: [],
  trades: [],
  tasks: [],
  ideas: [],
  news: [],
  snapshots: [],
  demoCleanupVersion: DEMO_CLEANUP_VERSION
};

let state = loadState();
let auth = {
  checked: false,
  configured: false,
  authenticated: false,
  registrationOpen: false,
  marketDataConfigured: false,
  marketDataProvider: "",
  newsDataConfigured: false,
  user: null,
  error: ""
};
let syncTimer = null;
let suppressSync = false;

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function loadState() {
  const stored = localStorage.getItem(STORE_KEY);
  if (!stored) return structuredClone(seedState);
  try {
    return migrateState({ ...structuredClone(seedState), ...JSON.parse(stored) });
  } catch {
    return structuredClone(seedState);
  }
}

function migrateState(nextState) {
  const hasDemoAssets = Array.isArray(nextState.assets) && nextState.assets.some(asset => DEMO_SYMBOLS.has(asset.symbol));
  const hasDemoTradeIds = Array.isArray(nextState.trades) && nextState.trades.some(trade => /^t[1-7]$/.test(String(trade.id)));
  if (hasDemoAssets || hasDemoTradeIds || Number(nextState.demoCleanupVersion || 0) < DEMO_CLEANUP_VERSION) {
    nextState = removeDemoData(nextState);
  }
  return nextState;
}

function removeDemoData(nextState) {
  nextState.assets = (nextState.assets || []).filter(asset => !DEMO_SYMBOLS.has(asset.symbol));
  nextState.trades = (nextState.trades || []).filter(trade => !DEMO_SYMBOLS.has(trade.symbol) && !/^t[1-7]$/.test(String(trade.id)));
  nextState.tasks = (nextState.tasks || []).filter(task => !String(task.id || "").startsWith("task-"));
  nextState.ideas = (nextState.ideas || []).filter(idea => !String(idea.id || "").startsWith("idea-"));
  nextState.news = (nextState.news || []).filter(item => item.source !== "Sample Intel");
  if (DEMO_SYMBOLS.has(nextState.selectedSymbol)) nextState.selectedSymbol = nextState.assets[0]?.symbol || null;
  nextState.selectedTaskId = nextState.tasks[0]?.id || null;
  nextState.selectedIdeaId = nextState.ideas[0]?.id || null;
  delete nextState.demoDataCleared;
  nextState.demoCleanupVersion = DEMO_CLEANUP_VERSION;
  return nextState;
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  scheduleServerSave();
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}/${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function scheduleServerSave() {
  if (suppressSync || !auth.configured || !auth.authenticated) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(saveServerState, 700);
}

async function saveServerState() {
  if (!auth.configured || !auth.authenticated) return;
  try {
    await apiRequest("state.php", {
      method: "PUT",
      body: JSON.stringify({ state })
    });
    setAuthMessage("Synced to MySQL.");
  } catch (error) {
    setAuthMessage(error.message);
  }
}

async function loadServerState() {
  const result = await apiRequest("state.php");
  if (result.state) {
    suppressSync = true;
    state = migrateState({ ...structuredClone(seedState), ...result.state });
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    suppressSync = false;
  } else {
    await saveServerState();
  }
}

async function refreshAuthStatus() {
  try {
    const result = await apiRequest("status.php");
    auth = {
      checked: true,
      configured: Boolean(result.configured),
      authenticated: Boolean(result.authenticated),
      registrationOpen: Boolean(result.registrationOpen),
      marketDataConfigured: Boolean(result.marketDataConfigured),
      marketDataProvider: result.marketDataProvider || "",
      newsDataConfigured: Boolean(result.newsDataConfigured),
      user: result.user || null,
      error: ""
    };
  } catch (error) {
    auth = {
      checked: true,
      configured: Boolean(error.data?.configured),
      authenticated: false,
      registrationOpen: false,
      marketDataConfigured: false,
      marketDataProvider: "",
      newsDataConfigured: false,
      user: null,
      error: error.message
    };
  }
}

function setAuthMessage(message) {
  const node = document.getElementById("authMessage");
  if (node) node.textContent = message || "";
}

function setAssetLookupStatus(message, tone = "") {
  const node = document.getElementById("assetLookupStatus");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("green", tone === "green");
  node.classList.toggle("red", tone === "red");
}

function updateAuthGate() {
  const gate = document.getElementById("authGate");
  if (!gate) return;

  if (auth.configured && !auth.authenticated) {
    gate.hidden = false;
    document.getElementById("showRegisterBtn").hidden = !auth.registrationOpen;
    setAuthMessage(auth.error || (auth.registrationOpen ? "Use your account, or create the first private account for this install." : "Registration is closed. Sign in with the existing account."));
  } else {
    gate.hidden = true;
  }
}

function getAsset(symbol = state.selectedSymbol) {
  return state.assets.find(asset => asset.symbol === symbol) || state.assets[0];
}

function getTrades(symbol) {
  if (!symbol) return [];
  return state.trades.filter(trade => trade.symbol === symbol);
}

function formatQuantity(value, type) {
  return Number(value || 0).toFixed(type === "crypto" ? 5 : 2);
}

function averageCost(pos) {
  return pos?.quantity ? pos.cost / pos.quantity : Number(pos?.price || 0);
}

function buildLots(symbol) {
  if (!symbol) return [];
  const lots = [];
  getTrades(symbol).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(trade => {
    const quantity = Number(trade.quantity || 0);
    const price = Number(trade.price || 0);
    const fees = Number(trade.fees || 0);
    if (trade.action === "buy" || trade.action === "deposit") {
      lots.push({
        id: trade.id,
        symbol,
        date: trade.date,
        quantity,
        remaining: quantity,
        cost: quantity * price + fees,
        unitCost: quantity ? (quantity * price + fees) / quantity : 0
      });
    }
    if (trade.action === "sell" || trade.action === "withdraw") {
      let remainingSale = quantity;
      for (const lot of lots) {
        if (remainingSale <= 0) break;
        const used = Math.min(lot.remaining, remainingSale);
        lot.remaining -= used;
        remainingSale -= used;
      }
    }
  });
  return lots.filter(lot => lot.remaining > 0.0000001);
}

function positionFor(asset) {
  if (!asset) return null;
  const lots = buildLots(asset.symbol);
  const quantity = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.remaining * lot.unitCost, 0);
  const value = quantity * Number(asset.price || 0);
  const dayChangePct = asset.previousClose ? ((asset.price - asset.previousClose) / asset.previousClose) * 100 : 0;
  const gain = value - cost;
  const gainPct = cost ? (gain / cost) * 100 : 0;
  return { ...asset, quantity, cost, value, dayChangePct, gain, gainPct, lots };
}

function portfolio() {
  const positions = state.assets.map(positionFor);
  const value = positions.reduce((sum, pos) => sum + pos.value, 0);
  const cost = positions.reduce((sum, pos) => sum + pos.cost, 0);
  const previousValue = positions.reduce((sum, pos) => sum + pos.quantity * Number(pos.previousClose || pos.price || 0), 0);
  const dayPnl = value - previousValue;
  const dayPct = previousValue ? (dayPnl / previousValue) * 100 : 0;
  const gain = value - cost;
  const gainPct = cost ? (gain / cost) * 100 : 0;
  return { positions, value, cost, dayPnl, dayPct, gain, gainPct };
}

function estimateTax({ symbol, quantity, price, date, shortRate, longRate }) {
  let remaining = Number(quantity || 0);
  const salePrice = Number(price || 0);
  const saleDate = new Date(`${date}T00:00:00`);
  const rows = [];
  buildLots(symbol).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(lot => {
    if (remaining <= 0) return;
    const qty = Math.min(lot.remaining, remaining);
    const proceeds = qty * salePrice;
    const basis = qty * lot.unitCost;
    const gain = proceeds - basis;
    const daysHeld = Math.round((saleDate - new Date(`${lot.date}T00:00:00`)) / 86400000);
    const term = daysHeld >= 365 ? "long" : "short";
    const tax = gain > 0 ? gain * ((term === "long" ? Number(longRate) : Number(shortRate)) / 100) : 0;
    rows.push({ qty, date: lot.date, unitCost: lot.unitCost, proceeds, basis, gain, term, tax });
    remaining -= qty;
  });
  return {
    rows,
    remaining,
    proceeds: rows.reduce((sum, row) => sum + row.proceeds, 0),
    basis: rows.reduce((sum, row) => sum + row.basis, 0),
    gain: rows.reduce((sum, row) => sum + row.gain, 0),
    tax: rows.reduce((sum, row) => sum + row.tax, 0)
  };
}

function render() {
  saveState();
  renderClock();
  renderTopState();
  updateAuthGate();
  renderOverview();
  renderPortfolio();
  renderTasks();
  renderIntel();
  renderIdeas();
  renderHistory();
  hydrateSelects();
}

function renderClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  document.getElementById("overviewTitle").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function renderTopState() {
  if (!auth.checked) {
    document.getElementById("liveState").textContent = "Loading";
    return;
  }
  if (auth.configured && auth.authenticated) {
    document.getElementById("liveState").textContent = auth.marketDataConfigured ? "Live Sync" : "Synced";
    document.getElementById("authBtn").textContent = "LO";
    document.getElementById("authBtn").title = auth.user?.email || "Log out";
    return;
  }
  if (auth.configured) {
    document.getElementById("liveState").textContent = auth.error ? "Setup" : "Login";
    document.getElementById("authBtn").textContent = "AC";
    return;
  }
  document.getElementById("liveState").textContent = state.apiKey ? "Live API" : "Local";
  document.getElementById("authBtn").textContent = "AC";
}

function renderOverview() {
  const port = portfolio();
  const openTasks = state.tasks.filter(task => !task.done);
  const todayTasks = openTasks.filter(task => task.due && task.due <= todayISO());
  const committedIdeas = state.ideas.filter(idea => idea.stage === "committed").length;
  const briefGain = port.dayPnl >= 0 ? "up" : "down";
  document.getElementById("dailyBrief").textContent = `${briefGain === "up" ? "Portfolio is higher" : "Portfolio is lower"} today with ${todayTasks.length} time-sensitive tasks and ${state.news.length} intel items in the queue.`;

  document.getElementById("overviewSummary").innerHTML = [
    metric("Portfolio Value", money(port.value), `${pct(port.dayPct)} today`, port.dayPnl >= 0 ? "up" : "dn"),
    metric("Invested Capital", money(port.cost), `${money(port.gain)} total P&L`, port.gain >= 0 ? "up" : "dn"),
    metric("Open Tasks", openTasks.length, `${todayTasks.length} due now`, todayTasks.length ? "accent" : ""),
    metric("Ideas", state.ideas.length, `${committedIdeas} committed`, "accent")
  ].join("");

  document.getElementById("overviewPortfolio").innerHTML = port.positions
    .sort((a, b) => b.value - a.value)
    .map(pos => positionMini(pos, port.value))
    .join("");

  document.getElementById("overviewTasks").innerHTML = state.tasks
    .filter(task => !task.done)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 5)
    .map(task => compactRow(task.title, `${task.category} | ${task.due || "No due date"}`, task.priority === "High" ? "accent" : ""))
    .join("") || empty("No open tasks");

  document.getElementById("overviewIntel").innerHTML = state.news.slice(0, 5).map((item, index) => newsMini(item, index)).join("") || empty("No intel yet");
  document.getElementById("overviewIdeas").innerHTML = state.ideas.slice(0, 5).map(idea => compactRow(idea.title, `${idea.stage} | impact ${idea.impact}/5`, idea.stage)).join("");
  document.getElementById("overviewHistory").innerHTML = state.snapshots.slice(0, 5).map(snap => compactRow(snap.title, `${money(snap.portfolio.value)} | ${pct(snap.portfolio.dayPct)}`, snap.portfolio.dayPnl >= 0 ? "green" : "red")).join("") || empty("Capture your first snapshot");
}

function metric(label, value, sub, tone = "") {
  return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${tone}">${value}</div><div class="metric-sub">${sub}</div></div>`;
}

function positionMini(pos, total) {
  const weight = total ? (pos.value / total) * 100 : 0;
  return `
    <div class="position-item" data-select-asset="${pos.symbol}">
      <div class="row-top">
        <div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div>
        <div class="price-block"><div class="mono">${money(pos.value)}</div><div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)}</div></div>
      </div>
      <div class="alloc-track"><div class="alloc-fill" style="width:${Math.min(100, weight)}%;background:${pos.color}"></div></div>
    </div>`;
}

function compactRow(title, meta, tone = "") {
  return `<div class="activity-row"><div><div>${title}</div><div class="muted mono">${meta}</div></div><span class="dot ${tone === "green" || tone === "committed" ? "green" : "accent"}"></span></div>`;
}

function newsMini(item, index) {
  return `<div class="activity-row"><span class="news-num">${String(index + 1).padStart(2, "0")}</span><div><div>${item.title}</div><div class="muted mono">${item.symbol} | ${item.source} | ${item.date}</div></div></div>`;
}

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

function renderPortfolio() {
  const port = portfolio();
  const selectedAsset = getAsset();
  const selected = selectedAsset ? positionFor(selectedAsset) : null;
  const linkedCount = port.positions.filter(pos => pos.marketDataLinked !== false && pos.type !== "cash" && pos.type !== "other").length;
  const zeroLotCount = port.positions.filter(pos => pos.quantity <= 0).length;
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
    </div>`).join("") : `<div class="summary-card"><div class="empty">No positions yet</div><button class="btn btn-primary full" data-open-modal="assetModal">Add Position</button></div>`;

  if (selected) renderAssetDetail(selected);
  else renderEmptyPortfolioDetail();
  renderChart(port);
  document.getElementById("connectionPanel").innerHTML = renderConnectionPanel(port);
}

function allocationPieces(port) {
  if (!port.value) return `<div class="alloc-piece" style="width:100%;background:var(--line2)"></div>`;
  return port.positions
    .filter(pos => pos.value > 0)
    .sort((a, b) => b.value - a.value)
    .map(pos => `<div class="alloc-piece" title="${pos.symbol}" style="width:${Math.max(1, pos.value / port.value * 100)}%;background:${pos.color}"></div>`)
    .join("");
}

function renderConnectionPanel(port) {
  const linked = port.positions.filter(pos => pos.marketDataLinked !== false && pos.type !== "cash" && pos.type !== "other").length;
  return `
    <div class="connection-row"><span>Market quotes</span><span>${auth.marketDataProvider || (auth.marketDataConfigured ? "Yahoo Finance" : "Manual only")}</span></div>
    <div class="connection-row"><span>Linked holdings</span><span>${linked}/${port.positions.length}</span></div>
    <div class="connection-row"><span>Position news</span><span>${auth.newsDataConfigured ? "Alpha Vantage active" : "Alpha key needed"}</span></div>
    <div class="connection-row"><span>Kraken</span><span>API possible: balances/trades</span></div>
    <div class="connection-row"><span>Robinhood</span><span>Official crypto API only</span></div>
    <div class="connection-row"><span>Brokerage import</span><span>Plaid or SnapTrade recommended</span></div>`;
}

function renderEmptyPortfolioDetail() {
  document.getElementById("assetDetailHead").innerHTML = `
    <div>
      <p class="hero-eyebrow">Portfolio setup</p>
      <div class="asset-title">Add your first position</div>
      <p class="hero-greeting">Use Lookup to connect a ticker to live market data, then enter your shares, average cost, and purchase date.</p>
    </div>
    <button class="btn btn-primary" data-open-modal="assetModal">Add Position</button>`;
  document.getElementById("lotsList").innerHTML = empty("No lots yet");
  document.getElementById("taxPreview").innerHTML = empty("No tax estimate yet");
  document.getElementById("activityList").innerHTML = empty("No activity yet");
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
      <div class="price-block">
        <div class="summary-value">${money2(pos.price)}</div>
        <div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)} today</div>
      </div>
      <div class="toolbar-row">
        <button class="btn btn-primary" type="button" data-edit-asset="${pos.symbol}">Edit Holding</button>
        <button class="btn btn-ghost" type="button" data-open-modal="tradeModal">Add Trade</button>
      </div>
    </div>`;

  document.getElementById("lotsList").innerHTML = pos.lots.map(lot => `
    <div class="lot-row">
      <div><div>${formatQuantity(lot.remaining, pos.type)} units</div><div class="muted">Bought ${lot.date}</div></div>
      <div class="price-block"><div>${money2(lot.unitCost)}</div><div class="muted">${money(lot.remaining * lot.unitCost)}</div></div>
    </div>`).join("") || `<div class="empty">No open lots</div><button class="btn btn-primary full" data-open-modal="tradeModal">Add Lot</button>`;

  const previewQty = Math.min(pos.quantity, pos.quantity * .2 || 0);
  const tax = estimateTax({ symbol: pos.symbol, quantity: previewQty, price: pos.price, date: todayISO(), shortRate: 24, longRate: 15 });
  document.getElementById("taxPreview").innerHTML = previewQty ? `
    ${metric("Potential Sale", money(tax.proceeds), `${formatQuantity(previewQty, pos.type)} units`, "")}
    <div class="db-row"><span>Estimated gain</span><span class="${tax.gain >= 0 ? "up" : "dn"}">${money(tax.gain)}</span></div>
    <div class="db-row"><span>Estimated federal tax</span><span class="accent">${money(tax.tax)}</span></div>
    <div class="modal-note">Preview assumes selling 20% of the current position using FIFO lots.</div>` : empty("No quantity available");

  document.getElementById("activityList").innerHTML = getTrades(pos.symbol).sort(byDateDesc).map(trade => `
    <div class="activity-row">
      <div><div>${trade.action.toUpperCase()} ${formatQuantity(trade.quantity, pos.type)} @ ${money2(trade.price)}</div><div class="muted">${trade.date} | ${trade.memo || "No memo"}</div></div>
      <div class="activity-actions"><span class="${trade.action === "sell" ? "red" : "green"}">${trade.action === "sell" ? "-" : "+"}${money(Number(trade.quantity) * Number(trade.price))}</span><button class="cell-link danger-link" type="button" data-delete-trade="${trade.id}">Delete</button></div>
    </div>`).join("") || empty("No activity");
}

function km(value, label) {
  return `<div class="km"><div class="km-val">${value}</div><div class="km-lbl">${label}</div></div>`;
}

function renderChart(port) {
  const values = [port.cost * .86, port.cost * .91, port.cost * .94, port.cost * .9, port.cost * .98, port.cost * 1.04, port.value];
  const costs = [port.cost * .76, port.cost * .8, port.cost * .83, port.cost * .88, port.cost * .92, port.cost * .96, port.cost];
  const all = values.concat(costs);
  const min = Math.min(...all) * .96;
  const max = Math.max(...all) * 1.04;
  const points = series => series.map((value, index) => {
    const x = 28 + index * (644 / (series.length - 1));
    const y = 212 - ((value - min) / (max - min || 1)) * 184;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  document.getElementById("portfolioChart").innerHTML = `
    <line x1="28" y1="212" x2="672" y2="212" stroke="#28282f"/>
    <line x1="28" y1="28" x2="28" y2="212" stroke="#28282f"/>
    <polyline points="${points(costs)}" fill="none" stroke="#e8d5b0" stroke-width="2" opacity=".65"/>
    <polyline points="${points(values)}" fill="none" stroke="#67aa7d" stroke-width="2.5"/>
    ${values.map((value, index) => {
      const x = 28 + index * (644 / (values.length - 1));
      const y = 212 - ((value - min) / (max - min || 1)) * 184;
      return `<circle cx="${x}" cy="${y}" r="3" fill="#67aa7d"/>`;
    }).join("")}`;
}

function renderTasks() {
  const filters = [
    ["open", "Open"], ["today", "Today"], ["finance", "Finance"], ["done", "Done"]
  ];
  document.getElementById("taskCount").textContent = String(state.tasks.length);
  document.getElementById("taskFilters").innerHTML = filters.map(([id, label]) => `<div class="nav-item ${state.taskFilter === id ? "active" : ""}" data-task-filter="${id}"><span class="nav-name">${label}</span><span class="nav-count">${filterTasks(id).length}</span></div>`).join("");
  document.getElementById("taskStats").innerHTML = `
    <div class="db-row"><span>Completed</span><span class="green">${state.tasks.filter(t => t.done).length}</span></div>
    <div class="db-row"><span>Due now</span><span class="accent">${filterTasks("today").length}</span></div>
    <div class="db-row"><span>Finance</span><span>${filterTasks("finance").length}</span></div>`;
  document.querySelectorAll("[data-task-filter]").forEach(btn => btn.classList.toggle("active", btn.dataset.taskFilter === state.taskFilter));
  document.getElementById("taskList").innerHTML = filterTasks(state.taskFilter).sort((a, b) => Number(a.done) - Number(b.done) || String(a.due).localeCompare(String(b.due))).map(task => `
    <div class="list-row ${task.id === state.selectedTaskId ? "selected" : ""}" data-select-task="${task.id}">
      <button class="check ${task.done ? "done" : ""}" data-toggle-task="${task.id}" aria-label="Toggle task"></button>
      <div>
        <div class="${task.done ? "muted" : ""}">${task.title}</div>
        <div class="row-meta"><span class="tag ${task.category.toLowerCase()}">${task.category}</span><span class="mono muted">${task.due || "No due date"}</span><span class="mono ${task.priority === "High" ? "accent" : "muted"}">${task.priority}</span></div>
      </div>
    </div>`).join("") || empty("No tasks in this filter");
  renderTaskDetail();
}

function filterTasks(filter) {
  if (filter === "done") return state.tasks.filter(task => task.done);
  if (filter === "today") return state.tasks.filter(task => !task.done && task.due && task.due <= todayISO());
  if (filter === "finance") return state.tasks.filter(task => !task.done && task.category === "Finance");
  return state.tasks.filter(task => !task.done);
}

function renderTaskDetail() {
  const task = state.tasks.find(item => item.id === state.selectedTaskId) || state.tasks[0];
  const node = document.getElementById("taskDetail");
  if (!task) {
    node.innerHTML = empty("Select a task");
    return;
  }
  node.innerHTML = `
    <div class="detail-card">
      <h2>${task.title}</h2>
      <div class="row-meta"><span class="tag ${task.category.toLowerCase()}">${task.category}</span><span class="tag">${task.priority}</span>${task.symbol ? `<span class="tag stock">${task.symbol}</span>` : ""}</div>
      <p>${task.notes || "No notes yet."}</p>
      <div class="db-row"><span>Due</span><span>${task.due || "None"}</span></div>
      <div class="db-row"><span>Status</span><span class="${task.done ? "green" : "accent"}">${task.done ? "Done" : "Open"}</span></div>
      <div class="modal-actions"><button class="btn btn-primary" data-toggle-task="${task.id}">${task.done ? "Reopen" : "Complete"}</button><button class="btn btn-danger" data-delete-task="${task.id}">Delete</button></div>
    </div>`;
}

function renderIntel() {
  const positions = portfolio().positions;
  document.getElementById("watchCount").textContent = String(positions.length);
  document.getElementById("apiKey").value = auth.configured
    ? (auth.marketDataConfigured ? `${auth.marketDataProvider || "Server quotes"} active` : "Market data unavailable")
    : (state.apiKey ? "Browser fallback key saved" : "Backend not configured");
  document.getElementById("watchList").innerHTML = positions.map(pos => `<div class="nav-item" data-select-asset="${pos.symbol}"><span class="nav-name">${pos.symbol}</span><span class="nav-count">${pct(pos.dayChangePct)}</span></div>`).join("");
  document.getElementById("newsFeed").innerHTML = state.news.map((item, index) => `
    <article class="news-row">
      <span class="news-num">${String(index + 1).padStart(2, "0")}</span>
      <div>
        <div class="row-meta"><span class="tag stock">${item.symbol}</span><span class="mono muted">${item.source} | ${item.date}</span></div>
        <h2 class="news-title">${item.url ? `<a href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a>` : item.title}</h2>
        <div class="news-meta">${item.sentiment || "Neutral"}</div>
      </div>
      <span class="tag ${String(item.sentiment || "neutral").toLowerCase()}">${item.sentiment || "Neutral"}</span>
    </article>`).join("") || empty("Save an API key and refresh, or add manual intel later.");
}

function renderIdeas() {
  const filters = [["all", "All"], ["raw", "Raw"], ["research", "Research"], ["committed", "Committed"]];
  document.getElementById("ideaCount").textContent = String(state.ideas.length);
  document.getElementById("ideaFilters").innerHTML = filters.map(([id, label]) => `<div class="nav-item ${state.ideaFilter === id ? "active" : ""}" data-idea-filter="${id}"><span class="nav-name">${label}</span><span class="nav-count">${filterIdeas(id).length}</span></div>`).join("");
  document.getElementById("ideaStats").innerHTML = `
    <div class="db-row"><span>Committed</span><span class="green">${filterIdeas("committed").length}</span></div>
    <div class="db-row"><span>Research</span><span class="accent">${filterIdeas("research").length}</span></div>
    <div class="db-row"><span>Raw</span><span>${filterIdeas("raw").length}</span></div>`;
  document.querySelectorAll("[data-idea-filter]").forEach(btn => btn.classList.toggle("active", btn.dataset.ideaFilter === state.ideaFilter));
  document.getElementById("ideaList").innerHTML = filterIdeas(state.ideaFilter).map(idea => `
    <div class="list-row ${idea.id === state.selectedIdeaId ? "selected" : ""}" data-select-idea="${idea.id}">
      <span class="dot ${idea.stage === "committed" ? "green" : "accent"}"></span>
      <div>
        <div>${idea.title}</div>
        <div class="row-meta"><span class="tag ${idea.stage}">${idea.stage}</span><span class="tag ${idea.category.toLowerCase()}">${idea.category}</span><span class="mono muted">Impact ${idea.impact} | Effort ${idea.effort}</span></div>
      </div>
    </div>`).join("") || empty("No ideas here yet");
  renderIdeaDetail();
}

function filterIdeas(filter) {
  if (filter === "all") return state.ideas;
  return state.ideas.filter(idea => idea.stage === filter);
}

function renderIdeaDetail() {
  const idea = state.ideas.find(item => item.id === state.selectedIdeaId) || state.ideas[0];
  const node = document.getElementById("ideaDetail");
  if (!idea) {
    node.innerHTML = empty("Select an idea");
    return;
  }
  node.innerHTML = `
    <div class="detail-card">
      <h2>${idea.title}</h2>
      <div class="row-meta"><span class="tag ${idea.stage}">${idea.stage}</span><span class="tag ${idea.category.toLowerCase()}">${idea.category}</span></div>
      <p>${idea.notes || "No notes yet."}</p>
      <div class="db-row"><span>Impact</span><span>${idea.impact}/5</span></div>
      <div class="db-row"><span>Effort</span><span>${idea.effort}/5</span></div>
      <div class="db-row"><span>Created</span><span>${idea.created}</span></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-promote-idea="${idea.id}">Advance</button><button class="btn btn-danger" data-delete-idea="${idea.id}">Delete</button></div>
    </div>`;
}

function renderHistory() {
  document.getElementById("historyCount").textContent = String(state.snapshots.length);
  document.getElementById("historyList").innerHTML = state.snapshots.map(snap => `
    <div class="snapshot-row ${snap.id === state.selectedSnapshotId ? "active" : ""}" data-select-snapshot="${snap.id}">
      <div><div>${snap.title}</div><div class="muted mono">${snap.date}</div></div>
      <div class="price-block"><div class="mono">${money(snap.portfolio.value)}</div><div class="mono ${snap.portfolio.dayPnl >= 0 ? "up" : "dn"}">${pct(snap.portfolio.dayPct)}</div></div>
    </div>`).join("") || empty("No snapshots yet");
  const snap = state.snapshots.find(item => item.id === state.selectedSnapshotId) || state.snapshots[0];
  const node = document.getElementById("historyDetail");
  if (!snap) {
    node.innerHTML = `<div class="report"><h1 id="historyTitle">History</h1><p class="muted">Capture a snapshot to store daily portfolio value, open tasks, active ideas, and a short report.</p></div>`;
    return;
  }
  node.innerHTML = `
    <article class="report">
      <h1>${snap.title}</h1>
      <div class="report-grid">
        ${metric("Value", money(snap.portfolio.value), "Portfolio")}
        ${metric("Today", money(snap.portfolio.dayPnl), pct(snap.portfolio.dayPct), snap.portfolio.dayPnl >= 0 ? "green" : "red")}
        ${metric("Total P&L", money(snap.portfolio.gain), pct(snap.portfolio.gainPct), snap.portfolio.gain >= 0 ? "green" : "red")}
        ${metric("Open Tasks", snap.tasks.open, `${snap.tasks.due} due`, "")}
      </div>
      <section class="report-section"><h2>Daily Report</h2><p>${snap.report}</p></section>
      <section class="report-section"><h2>Positions</h2>${snap.positions.map(pos => `<div class="db-row"><span>${pos.symbol}</span><span>${money(pos.value)} | ${pct(pos.dayChangePct)}</span></div>`).join("")}</section>
      <section class="report-section"><h2>Ideas</h2>${snap.ideas.map(idea => `<div class="db-row"><span>${idea.title}</span><span>${idea.stage}</span></div>`).join("")}</section>
    </article>`;
}

function captureSnapshot() {
  const port = portfolio();
  const positions = port.positions.map(pos => ({ symbol: pos.symbol, value: pos.value, dayChangePct: pos.dayChangePct, gain: pos.gain }));
  const openTasks = state.tasks.filter(task => !task.done);
  const dueTasks = openTasks.filter(task => task.due && task.due <= todayISO());
  const report = `Portfolio closed at ${money(port.value)} with ${money(port.dayPnl)} of daily movement (${pct(port.dayPct)}). Total unrealized P&L is ${money(port.gain)}. The biggest positions are ${positions.sort((a, b) => b.value - a.value).slice(0, 3).map(pos => pos.symbol).join(", ")}. There are ${openTasks.length} open tasks, ${dueTasks.length} due now, and ${state.ideas.filter(idea => idea.stage === "committed").length} committed ideas.`;
  const snap = {
    id: uid(),
    date: todayISO(),
    title: new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }),
    portfolio: { value: port.value, cost: port.cost, dayPnl: port.dayPnl, dayPct: port.dayPct, gain: port.gain, gainPct: port.gainPct },
    positions,
    tasks: { open: openTasks.length, due: dueTasks.length },
    ideas: state.ideas.map(({ title, stage }) => ({ title, stage })),
    report
  };
  state.snapshots.unshift(snap);
  state.selectedSnapshotId = snap.id;
  switchTab("history");
  render();
}

function hydrateSelects() {
  const options = state.assets.map(asset => `<option value="${asset.symbol}">${asset.symbol} - ${asset.name}</option>`).join("");
  ["tradeAsset", "taxAsset"].forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      select.innerHTML = options;
      select.value = state.selectedSymbol;
    }
  });
  const taskAsset = document.getElementById("taskAsset");
  if (taskAsset) taskAsset.innerHTML = `<option value="">None</option>${options}`;
  document.querySelector("#tradeForm [name='date']").value ||= todayISO();
  document.querySelector("#taxForm [name='date']").value ||= todayISO();
  document.querySelector("#assetForm [name='purchaseDate']").value ||= todayISO();
}

function resetAssetForm() {
  const form = document.getElementById("assetForm");
  form.reset();
  form.elements.mode.value = "create";
  form.elements.originalSymbol.value = "";
  form.elements.symbol.disabled = false;
  form.elements.purchaseDate.value = todayISO();
  form.elements.fees.value = "0";
  document.getElementById("assetModalTitle").textContent = "Position";
  setAssetLookupStatus("Lookup connects the asset to server-side market data for future refreshes.");
}

function fillAssetForm(symbol) {
  const form = document.getElementById("assetForm");
  const asset = state.assets.find(item => item.symbol === symbol);
  if (!asset) return;
  const pos = positionFor(asset);
  form.elements.mode.value = "edit";
  form.elements.originalSymbol.value = asset.symbol;
  form.elements.symbol.value = asset.symbol;
  form.elements.symbol.disabled = false;
  form.elements.name.value = asset.name || asset.symbol;
  form.elements.type.value = asset.type || "stock";
  form.elements.price.value = Number(asset.price || 0).toFixed(asset.type === "crypto" ? 2 : 4);
  form.elements.targetWeight.value = asset.targetWeight || "";
  form.elements.color.value = asset.color || "#e8d5b0";
  form.elements.quantity.value = pos.quantity ? String(Number(pos.quantity.toFixed(asset.type === "crypto" ? 6 : 4))) : "0";
  form.elements.costPrice.value = Number(averageCost(pos) || 0).toFixed(asset.type === "crypto" ? 2 : 4);
  form.elements.purchaseDate.value = pos.lots[0]?.date || todayISO();
  form.elements.fees.value = "0";
  form.elements.notes.value = asset.notes || "";
  document.getElementById("assetModalTitle").textContent = `Edit ${asset.symbol}`;
  setAssetLookupStatus("Editing replaces this holding's current lots with the quantity and average cost entered here.");
}

function switchTab(tab) {
  document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
  document.getElementById(`${tab}View`).classList.add("active");
  document.querySelectorAll(".t-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
}

function openModal(id) {
  if (id === "assetModal") resetAssetForm();
  document.getElementById(id).classList.add("open");
  document.getElementById(id).setAttribute("aria-hidden", "false");
  if (id === "tradeModal" && state.selectedSymbol) {
    const tradeAsset = document.getElementById("tradeAsset");
    if (tradeAsset) tradeAsset.value = state.selectedSymbol;
  }
}

function openAssetEditor(symbol) {
  resetAssetForm();
  fillAssetForm(symbol);
  document.getElementById("assetModal").classList.add("open");
  document.getElementById("assetModal").setAttribute("aria-hidden", "false");
}

function closeModals() {
  document.querySelectorAll(".modal-overlay").forEach(modal => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  });
}

function upsertAsset(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const symbol = data.symbol.trim().toUpperCase();
  const originalSymbol = (data.originalSymbol || symbol).trim().toUpperCase();
  const isEdit = data.mode === "edit";
  const existing = state.assets.find(asset => asset.symbol === (isEdit ? originalSymbol : symbol)) || state.assets.find(asset => asset.symbol === symbol);
  const marketLinked = data.type !== "cash" && data.type !== "other";
  const purchaseDate = data.purchaseDate || todayISO();
  const quantity = Number(data.quantity || 0);
  const costPrice = Number(data.costPrice || data.price || 0);
  const fees = Number(data.fees || 0);
  const asset = {
    symbol,
    name: data.name.trim(),
    type: data.type,
    price: Number(data.price || 0),
    previousClose: existing?.price || Number(data.price || 0),
    targetWeight: Number(data.targetWeight || 0),
    color: data.color || "#e8d5b0",
    notes: data.notes.trim(),
    marketDataSymbol: symbol,
    marketDataProvider: marketLinked ? "server" : "manual",
    marketDataLinked: marketLinked,
    quoteUpdatedAt: existing?.quoteUpdatedAt || null
  };
  if (existing) {
    Object.assign(existing, asset);
    if (originalSymbol !== symbol) {
      state.trades.forEach(trade => {
        if (trade.symbol === originalSymbol) trade.symbol = symbol;
      });
      state.tasks.forEach(task => {
        if (task.symbol === originalSymbol) task.symbol = symbol;
      });
      state.news.forEach(item => {
        if (item.symbol === originalSymbol) item.symbol = symbol;
      });
    }
  }
  else state.assets.push(asset);
  if (isEdit) {
    state.trades = state.trades.filter(trade => trade.symbol !== originalSymbol && trade.symbol !== symbol);
  }
  if (quantity > 0 && costPrice > 0) {
    state.trades.push({
      id: uid(),
      symbol,
      action: "buy",
      quantity,
      price: costPrice,
      fees,
      date: purchaseDate,
      memo: isEdit ? "Manual holding update" : (data.notes.trim() || "Initial position entry")
    });
  }
  state.selectedSymbol = symbol;
}

async function lookupAssetMarketData() {
  const form = document.getElementById("assetForm");
  const symbolInput = form.elements.symbol;
  const symbol = symbolInput.value.trim().toUpperCase();
  if (!symbol) {
    setAssetLookupStatus("Enter a ticker first.", "red");
    symbolInput.focus();
    return;
  }
  if (!auth.configured || !auth.authenticated) {
    setAssetLookupStatus("Sign in before using server-side lookup.", "red");
    return;
  }

  setAssetLookupStatus(`Looking up ${symbol}...`);
  try {
    const result = await apiRequest(`market.php?type=lookup&symbol=${encodeURIComponent(symbol)}`, {
      method: "GET",
      headers: {}
    });
    const asset = result.asset;
    form.elements.symbol.value = asset.symbol || symbol;
    form.elements.name.value = asset.name || asset.symbol || symbol;
    form.elements.type.value = asset.assetType || "stock";
    form.elements.price.value = asset.price ? Number(asset.price).toFixed(asset.assetType === "crypto" ? 2 : 4) : "";
    if (!form.elements.costPrice.value && asset.price) {
      form.elements.costPrice.value = Number(asset.price).toFixed(asset.assetType === "crypto" ? 2 : 4);
    }
    setAssetLookupStatus(`Linked ${asset.symbol || symbol} through ${asset.provider || auth.marketDataProvider || "market data"}. Enter your shares and cost basis, then save.`, "green");
  } catch (error) {
    setAssetLookupStatus(error.message, "red");
  }
}

function recordTrade(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const symbol = data.symbol || state.selectedSymbol;
  if (!symbol) return;
  state.trades.push({
    id: uid(),
    symbol,
    action: data.action,
    quantity: Number(data.quantity || 0),
    price: Number(data.price || 0),
    fees: Number(data.fees || 0),
    date: data.date,
    memo: data.memo.trim()
  });
  state.selectedSymbol = symbol;
}

function addTask(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const task = { id: uid(), title: data.title.trim(), category: data.category, priority: data.priority, due: data.due, symbol: data.symbol, notes: data.notes.trim(), done: false };
  state.tasks.unshift(task);
  state.selectedTaskId = task.id;
}

function addIdea(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const idea = { id: uid(), title: data.title.trim(), stage: data.stage, category: data.category, impact: Number(data.impact || 3), effort: Number(data.effort || 3), created: todayISO(), notes: data.notes.trim() };
  state.ideas.unshift(idea);
  state.selectedIdeaId = idea.id;
}

async function refreshLiveData(silent = false) {
  if (auth.configured && !auth.authenticated) {
    if (!silent) alert("Sign in before refreshing server-side market data.");
    return;
  }

  if (auth.configured && auth.authenticated) {
    document.getElementById("liveState").textContent = "Refreshing";
    try {
      const symbols = state.assets
        .filter(item => item.marketDataLinked !== false && item.type !== "cash" && item.type !== "other")
        .map(asset => asset.marketDataSymbol || asset.symbol)
        .join(",");
      if (!symbols) {
        render();
        return;
      }
      const result = await apiRequest(`market.php?type=quotes&symbols=${encodeURIComponent(symbols)}`, {
        method: "GET",
        headers: {}
      });
      for (const quote of result.quotes || []) {
        const asset = state.assets.find(item => (item.marketDataSymbol || item.symbol) === quote.symbol || item.symbol === quote.symbol);
        if (asset && quote.price) {
          asset.previousClose = quote.previousClose || asset.price;
          asset.price = quote.price;
          asset.marketDataLinked = true;
          asset.marketDataProvider = quote.provider || auth.marketDataProvider || "server";
          if (quote.name && (!asset.name || asset.name === asset.symbol)) asset.name = quote.name;
          asset.quoteUpdatedAt = new Date().toISOString();
        }
      }
      await refreshNews();
      render();
    } catch (error) {
      if (!silent) alert(error.message);
      render();
    }
    return;
  }

  if (!state.apiKey) {
    if (!silent) alert("Configure the server-side Alpha Vantage key in api/config.php, or save a browser fallback key in local mode.");
    return;
  }

  document.getElementById("liveState").textContent = "Refreshing";
  for (const asset of state.assets.filter(item => item.type !== "crypto" && item.type !== "cash")) {
    try {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(asset.symbol)}&apikey=${encodeURIComponent(state.apiKey)}`;
      const result = await fetch(url).then(res => res.json());
      const quote = result["Global Quote"];
      const price = Number(quote?.["05. price"]);
      const previousClose = Number(quote?.["08. previous close"]);
      if (price) {
        asset.previousClose = previousClose || asset.price;
        asset.price = price;
      }
    } catch {
      // Network/API failures leave the last known quote untouched.
    }
  }
  await refreshNews();
  render();
}

async function refreshNews() {
  if (auth.configured && auth.authenticated) {
    if (!auth.newsDataConfigured) {
      setAuthMessage("Quotes are live. Add an Alpha Vantage key for investment news.");
      return;
    }
    try {
      const symbols = state.assets
        .filter(asset => asset.type === "stock" || asset.type === "crypto")
        .map(asset => asset.symbol)
        .join(",");
      const result = await apiRequest(`market.php?type=news&symbols=${encodeURIComponent(symbols)}`, {
        method: "GET",
        headers: {}
      });
      if (Array.isArray(result.news)) {
        state.news = result.news;
      }
    } catch (error) {
      setAuthMessage(error.message);
    }
    return;
  }

  if (!state.apiKey) return;
  try {
    const tickers = state.assets.filter(asset => asset.type !== "crypto" && asset.type !== "cash").map(asset => asset.symbol).join(",");
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&apikey=${encodeURIComponent(state.apiKey)}`;
    const result = await fetch(url).then(res => res.json());
    if (Array.isArray(result.feed)) {
      state.news = result.feed.slice(0, 25).map(item => ({
        id: uid(),
        symbol: item.ticker_sentiment?.[0]?.ticker || "MKT",
        title: item.title,
        source: item.source || "Alpha Vantage",
        url: item.url || "",
        date: String(item.time_published || todayISO()).slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
        sentiment: item.overall_sentiment_label || "Neutral"
      }));
    }
  } catch {
    alert("News refresh failed. Check the API key, rate limit, or browser network permissions.");
  }
}

document.addEventListener("click", event => {
  const tab = event.target.closest("[data-tab]")?.dataset.tab;
  if (tab) switchTab(tab);

  const modal = event.target.closest("[data-open-modal]")?.dataset.openModal;
  if (modal) openModal(modal);
  if (event.target.closest("[data-close-modal]") || event.target.classList.contains("modal-overlay")) closeModals();

  const symbol = event.target.closest("[data-select-asset]")?.dataset.selectAsset;
  if (symbol) {
    state.selectedSymbol = symbol;
    render();
  }

  const editAsset = event.target.closest("[data-edit-asset]")?.dataset.editAsset;
  if (editAsset) {
    openAssetEditor(editAsset);
  }

  const taskFilter = event.target.closest("[data-task-filter]")?.dataset.taskFilter;
  if (taskFilter) {
    state.taskFilter = taskFilter;
    render();
  }

  const ideaFilter = event.target.closest("[data-idea-filter]")?.dataset.ideaFilter;
  if (ideaFilter) {
    state.ideaFilter = ideaFilter;
    render();
  }

  const taskId = event.target.closest("[data-select-task]")?.dataset.selectTask;
  if (taskId) {
    state.selectedTaskId = taskId;
    render();
  }

  const toggleTaskId = event.target.closest("[data-toggle-task]")?.dataset.toggleTask;
  if (toggleTaskId) {
    const task = state.tasks.find(item => item.id === toggleTaskId);
    if (task) task.done = !task.done;
    render();
  }

  const deleteTaskId = event.target.closest("[data-delete-task]")?.dataset.deleteTask;
  if (deleteTaskId) {
    state.tasks = state.tasks.filter(task => task.id !== deleteTaskId);
    state.selectedTaskId = state.tasks[0]?.id || null;
    render();
  }

  const ideaId = event.target.closest("[data-select-idea]")?.dataset.selectIdea;
  if (ideaId) {
    state.selectedIdeaId = ideaId;
    render();
  }

  const promoteIdeaId = event.target.closest("[data-promote-idea]")?.dataset.promoteIdea;
  if (promoteIdeaId) {
    const idea = state.ideas.find(item => item.id === promoteIdeaId);
    if (idea) idea.stage = idea.stage === "raw" ? "research" : idea.stage === "research" ? "committed" : "committed";
    render();
  }

  const deleteIdeaId = event.target.closest("[data-delete-idea]")?.dataset.deleteIdea;
  if (deleteIdeaId) {
    state.ideas = state.ideas.filter(idea => idea.id !== deleteIdeaId);
    state.selectedIdeaId = state.ideas[0]?.id || null;
    render();
  }

  const deleteTradeId = event.target.closest("[data-delete-trade]")?.dataset.deleteTrade;
  if (deleteTradeId && confirm("Delete this portfolio activity entry? This changes the holding quantity and tax lots.")) {
    state.trades = state.trades.filter(trade => trade.id !== deleteTradeId);
    render();
  }

  const snapId = event.target.closest("[data-select-snapshot]")?.dataset.selectSnapshot;
  if (snapId) {
    state.selectedSnapshotId = snapId;
    render();
  }

  if (event.target.closest("#portfolioRefreshBtn")) {
    refreshLiveData();
  }

  if (event.target.closest("#clearDemoBtn")) {
    state = removeDemoData(state);
    render();
  }
});

document.getElementById("assetForm").addEventListener("submit", event => {
  event.preventDefault();
  upsertAsset(event.currentTarget);
  event.currentTarget.reset();
  setAssetLookupStatus("Lookup connects the asset to server-side market data for future refreshes.");
  closeModals();
  render();
});

document.getElementById("assetLookupBtn").addEventListener("click", lookupAssetMarketData);

document.getElementById("tradeForm").addEventListener("submit", event => {
  event.preventDefault();
  recordTrade(event.currentTarget);
  event.currentTarget.reset();
  closeModals();
  render();
});

document.getElementById("taskForm").addEventListener("submit", event => {
  event.preventDefault();
  addTask(event.currentTarget);
  event.currentTarget.reset();
  closeModals();
  render();
});

document.getElementById("ideaForm").addEventListener("submit", event => {
  event.preventDefault();
  addIdea(event.currentTarget);
  event.currentTarget.reset();
  closeModals();
  render();
});

document.getElementById("taxForm").addEventListener("submit", event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const result = estimateTax(data);
  document.getElementById("taxEstimateOutput").innerHTML = `
    ${metric("Estimated Gain", money(result.gain), `${money(result.proceeds)} proceeds`, result.gain >= 0 ? "green" : "red")}
    <div class="db-row"><span>Cost basis</span><span>${money(result.basis)}</span></div>
    <div class="db-row"><span>Federal estimate</span><span class="accent">${money(result.tax)}</span></div>
    ${result.remaining > 0 ? `<div class="modal-note">Not enough open lots for ${result.remaining.toFixed(4)} units.</div>` : ""}
    ${result.rows.map(row => `<div class="db-row"><span>${row.qty.toFixed(4)} from ${row.date} (${row.term})</span><span>${money(row.gain)}</span></div>`).join("")}`;
});

document.getElementById("saveApiKeyBtn").addEventListener("click", () => {
  if (auth.configured) {
    alert(auth.newsDataConfigured ? "Server-side quotes and Alpha Vantage news are configured." : "Server-side Yahoo quotes are active. Add alpha_vantage_api_key in public_html/api/config.php for news.");
    return;
  }
  const key = prompt("Optional local fallback Alpha Vantage key. Prefer server-side config for production.", state.apiKey || "");
  if (key !== null) {
    state.apiKey = key.trim();
    render();
  }
});

document.getElementById("refreshDataBtn").addEventListener("click", refreshLiveData);
document.getElementById("refreshNewsBtn").addEventListener("click", async () => { await refreshNews(); render(); });
document.getElementById("captureSnapshotBtn").addEventListener("click", captureSnapshot);
document.getElementById("historySnapshotBtn").addEventListener("click", captureSnapshot);

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `my-dailyedge-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  state = { ...structuredClone(seedState), ...JSON.parse(await file.text()) };
  render();
});

document.getElementById("authBtn").addEventListener("click", async () => {
  if (auth.configured && auth.authenticated) {
    await apiRequest("auth.php", {
      method: "POST",
      body: JSON.stringify({ action: "logout" })
    });
    auth.authenticated = false;
    auth.user = null;
    updateAuthGate();
    render();
    return;
  }

  if (!auth.configured) {
    alert(auth.error || "Backend storage is not configured yet. Create api/config.php and install the MySQL schema to enable login.");
    return;
  }

  document.getElementById("authGate").hidden = false;
});

document.getElementById("showRegisterBtn").addEventListener("click", () => {
  document.getElementById("loginForm").hidden = true;
  document.getElementById("registerForm").hidden = false;
  setAuthMessage("Create the first account, then disable registration in api/config.php.");
});

document.getElementById("showLoginBtn").addEventListener("click", () => {
  document.getElementById("registerForm").hidden = true;
  document.getElementById("loginForm").hidden = false;
  setAuthMessage("");
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await apiRequest("auth.php", {
      method: "POST",
      body: JSON.stringify({ action: "login", email: data.email, password: data.password })
    });
    await refreshAuthStatus();
    await loadServerState();
    updateAuthGate();
    render();
  } catch (error) {
    setAuthMessage(error.message);
  }
});

document.getElementById("registerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await apiRequest("auth.php", {
      method: "POST",
      body: JSON.stringify({ action: "register", email: data.email, password: data.password })
    });
    await refreshAuthStatus();
    await saveServerState();
    updateAuthGate();
    render();
  } catch (error) {
    setAuthMessage(error.message);
  }
});

async function initApp() {
  renderClock();
  await refreshAuthStatus();
  if (auth.configured && auth.authenticated) {
    await loadServerState();
  }
  render();
}

setInterval(renderClock, 1000);
setInterval(() => {
  if (auth.configured && auth.authenticated && state.assets.length && !document.hidden) {
    refreshLiveData(true);
  }
}, 300000);
initApp();
