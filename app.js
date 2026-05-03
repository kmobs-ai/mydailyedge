"use strict";

const STORE_KEY = "dailyedge.v1";
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const money = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = value => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));

const seedState = {
  selectedSymbol: "NVDA",
  selectedTaskId: "task-tax",
  selectedIdeaId: "idea-etfs",
  selectedSnapshotId: null,
  taskFilter: "open",
  ideaFilter: "all",
  apiKey: "",
  assets: [
    { symbol: "NVDA", name: "NVIDIA Corp.", type: "stock", price: 627.8, previousClose: 599.62, targetWeight: 28, color: "#8b8b9a", notes: "AI infrastructure leader. Watch valuation and supply chain concentration." },
    { symbol: "AAPL", name: "Apple Inc.", type: "stock", price: 187.35, previousClose: 184.9, targetWeight: 18, color: "#5a9e72", notes: "Durable cash generation. Monitor services growth and device replacement cycle." },
    { symbol: "VOO", name: "Vanguard S&P 500 ETF", type: "etf", price: 512.4, previousClose: 510.2, targetWeight: 32, color: "#e8d5b0", notes: "Core broad market exposure." },
    { symbol: "BTC", name: "Bitcoin", type: "crypto", price: 64250, previousClose: 63500, targetWeight: 12, color: "#5b8db8", notes: "High volatility allocation. Rebalance around target weight." },
    { symbol: "TSLA", name: "Tesla Inc.", type: "stock", price: 177.12, previousClose: 180.4, targetWeight: 10, color: "#c0544a", notes: "Optionality around autonomy and energy, with high execution risk." }
  ],
  trades: [
    { id: "t1", symbol: "NVDA", action: "buy", quantity: 55, price: 328.2, fees: 0, date: "2024-08-12", memo: "Initial AI infrastructure position" },
    { id: "t2", symbol: "NVDA", action: "buy", quantity: 42, price: 471.35, fees: 0, date: "2025-02-21", memo: "Added after earnings reset" },
    { id: "t3", symbol: "AAPL", action: "buy", quantity: 120, price: 151.3, fees: 0, date: "2024-05-15", memo: "Core compounder" },
    { id: "t4", symbol: "VOO", action: "buy", quantity: 132, price: 421.2, fees: 0, date: "2024-02-02", memo: "Core index allocation" },
    { id: "t5", symbol: "BTC", action: "buy", quantity: 0.72, price: 41200, fees: 12, date: "2024-11-06", memo: "Crypto sleeve" },
    { id: "t6", symbol: "TSLA", action: "buy", quantity: 92, price: 211.6, fees: 0, date: "2025-07-18", memo: "Autonomy thesis" },
    { id: "t7", symbol: "NVDA", action: "sell", quantity: 12, price: 601.45, fees: 0, date: "2026-04-15", memo: "Trimmed into strength" }
  ],
  tasks: [
    { id: "task-tax", title: "Estimate tax impact for planned NVDA trim", category: "Finance", priority: "High", due: todayISO(), done: false, symbol: "NVDA", notes: "Use FIFO lots, then compare with actual brokerage tax lots before placing the order." },
    { id: "task-rebalance", title: "Review target allocation drift", category: "Finance", priority: "Medium", due: todayISO(), done: false, symbol: "", notes: "Check if BTC and NVDA exceed risk budget." },
    { id: "task-news", title: "Read earnings notes for top holdings", category: "Finance", priority: "Medium", due: addDays(todayISO(), 2), done: false, symbol: "AAPL", notes: "Capture only decision-changing notes." },
    { id: "task-transfer", title: "Transfer monthly investment contribution", category: "Finance", priority: "Low", due: addDays(todayISO(), -1), done: true, symbol: "VOO", notes: "Recurring deposit for core index position." }
  ],
  ideas: [
    { id: "idea-etfs", title: "Research dividend ETF income sleeve", stage: "research", category: "Finance", impact: 4, effort: 2, created: "2026-04-28", notes: "Compare SCHD, VIG, and DGRO. Decide whether income sleeve improves behavior or just adds complexity." },
    { id: "idea-rules", title: "Create written selling rules for concentrated winners", stage: "committed", category: "Finance", impact: 5, effort: 2, created: "2026-04-30", notes: "Define trim bands, taxable account rules, and exceptions before high-volatility days." },
    { id: "idea-consult", title: "Start a side consulting practice", stage: "raw", category: "Business", impact: 4, effort: 5, created: "2026-05-01", notes: "Validate one paid offer before building infrastructure." }
  ],
  news: [
    { id: "n1", symbol: "NVDA", title: "Semiconductor leaders rally as AI capex expectations keep rising", source: "Sample Intel", url: "", date: todayISO(), sentiment: "Positive" },
    { id: "n2", symbol: "AAPL", title: "Services growth remains key focus for Apple investors", source: "Sample Intel", url: "", date: todayISO(), sentiment: "Neutral" },
    { id: "n3", symbol: "BTC", title: "Bitcoin steadies as ETF flows offset macro caution", source: "Sample Intel", url: "", date: addDays(todayISO(), -1), sentiment: "Neutral" }
  ],
  snapshots: []
};

let state = loadState();

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function loadState() {
  const stored = localStorage.getItem(STORE_KEY);
  if (!stored) return structuredClone(seedState);
  try {
    return { ...structuredClone(seedState), ...JSON.parse(stored) };
  } catch {
    return structuredClone(seedState);
  }
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function getAsset(symbol = state.selectedSymbol) {
  return state.assets.find(asset => asset.symbol === symbol) || state.assets[0];
}

function getTrades(symbol) {
  return state.trades.filter(trade => trade.symbol === symbol);
}

function buildLots(symbol) {
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
  document.getElementById("liveState").textContent = state.apiKey ? "Live API" : "Manual";
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
  const selected = positionFor(getAsset()?.symbol || state.assets[0]?.symbol);
  document.getElementById("positionCount").textContent = `${port.positions.length} assets`;
  document.getElementById("portfolioSummary").innerHTML = `
    <div class="summary-value">${money(port.value)}</div>
    <div class="summary-row">
      <div class="summary-stat"><strong class="${port.dayPnl >= 0 ? "up" : "dn"}">${money(port.dayPnl)}</strong><span>Today P&L</span></div>
      <div class="summary-stat"><strong class="${port.dayPct >= 0 ? "up" : "dn"}">${pct(port.dayPct)}</strong><span>Day return</span></div>
      <div class="summary-stat"><strong class="${port.gain >= 0 ? "up" : "dn"}">${money(port.gain)}</strong><span>All-time P&L</span></div>
    </div>`;
  document.getElementById("positionList").innerHTML = port.positions.sort((a, b) => b.value - a.value).map(pos => `
    <div class="position-item ${pos.symbol === selected.symbol ? "active" : ""}" data-select-asset="${pos.symbol}">
      <div class="row-top">
        <div class="asset-title-row"><span class="dot" style="background:${pos.color}"></span><div><div class="ticker">${pos.symbol}</div><div class="asset-name">${pos.name}</div></div></div>
        <div class="price-block"><div class="mono">${money(pos.value)}</div><div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)}</div></div>
      </div>
      <div class="row-meta"><span class="muted mono">${pos.quantity.toFixed(pos.type === "crypto" ? 4 : 2)} units</span><span class="muted mono">${port.value ? (pos.value / port.value * 100).toFixed(1) : "0.0"}%</span></div>
    </div>`).join("");

  renderAssetDetail(selected);
  renderChart(port);
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
      </div>
    </div>
    <div class="price-block">
      <div class="summary-value">${money2(pos.price)}</div>
      <div class="mono ${pos.dayChangePct >= 0 ? "up" : "dn"}">${pct(pos.dayChangePct)} today</div>
    </div>`;

  document.getElementById("lotsList").innerHTML = pos.lots.map(lot => `
    <div class="lot-row">
      <div><div>${lot.remaining.toFixed(pos.type === "crypto" ? 5 : 2)} units</div><div class="muted">Bought ${lot.date}</div></div>
      <div class="price-block"><div>${money2(lot.unitCost)}</div><div class="muted">${money(lot.remaining * lot.unitCost)}</div></div>
    </div>`).join("") || empty("No open lots");

  const previewQty = Math.min(pos.quantity, pos.quantity * .2 || 0);
  const tax = estimateTax({ symbol: pos.symbol, quantity: previewQty, price: pos.price, date: todayISO(), shortRate: 24, longRate: 15 });
  document.getElementById("taxPreview").innerHTML = previewQty ? `
    ${metric("Potential Sale", money(tax.proceeds), `${previewQty.toFixed(pos.type === "crypto" ? 5 : 2)} units`, "")}
    <div class="db-row"><span>Estimated gain</span><span class="${tax.gain >= 0 ? "up" : "dn"}">${money(tax.gain)}</span></div>
    <div class="db-row"><span>Estimated federal tax</span><span class="accent">${money(tax.tax)}</span></div>
    <div class="modal-note">Preview assumes selling 20% of the current position using FIFO lots.</div>` : empty("No quantity available");

  document.getElementById("activityList").innerHTML = getTrades(pos.symbol).sort(byDateDesc).map(trade => `
    <div class="activity-row">
      <div><div>${trade.action.toUpperCase()} ${Number(trade.quantity).toFixed(pos.type === "crypto" ? 5 : 2)} @ ${money2(trade.price)}</div><div class="muted">${trade.date} | ${trade.memo || "No memo"}</div></div>
      <span class="${trade.action === "sell" ? "red" : "green"}">${trade.action === "sell" ? "-" : "+"}${money(Number(trade.quantity) * Number(trade.price))}</span>
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
  document.getElementById("apiKey").value = state.apiKey || "";
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
}

function switchTab(tab) {
  document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
  document.getElementById(`${tab}View`).classList.add("active");
  document.querySelectorAll(".t-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
}

function openModal(id) {
  document.getElementById(id).classList.add("open");
  document.getElementById(id).setAttribute("aria-hidden", "false");
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
  const existing = state.assets.find(asset => asset.symbol === symbol);
  const asset = {
    symbol,
    name: data.name.trim(),
    type: data.type,
    price: Number(data.price || 0),
    previousClose: existing?.price || Number(data.price || 0),
    targetWeight: Number(data.targetWeight || 0),
    color: data.color || "#e8d5b0",
    notes: data.notes.trim()
  };
  if (existing) Object.assign(existing, asset);
  else state.assets.push(asset);
  state.selectedSymbol = symbol;
}

function recordTrade(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  state.trades.push({
    id: uid(),
    symbol: data.symbol,
    action: data.action,
    quantity: Number(data.quantity || 0),
    price: Number(data.price || 0),
    fees: Number(data.fees || 0),
    date: data.date,
    memo: data.memo.trim()
  });
  state.selectedSymbol = data.symbol;
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

async function refreshLiveData() {
  if (!state.apiKey) {
    alert("Save an Alpha Vantage API key in Intel to refresh live stock quotes/news. Crypto and manual assets can still be updated from Portfolio.");
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

  const snapId = event.target.closest("[data-select-snapshot]")?.dataset.selectSnapshot;
  if (snapId) {
    state.selectedSnapshotId = snapId;
    render();
  }
});

document.getElementById("assetForm").addEventListener("submit", event => {
  event.preventDefault();
  upsertAsset(event.currentTarget);
  event.currentTarget.reset();
  closeModals();
  render();
});

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
  state.apiKey = document.getElementById("apiKey").value.trim();
  render();
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

setInterval(renderClock, 1000);
render();
