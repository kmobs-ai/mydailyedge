"use strict";

const assert = require("assert");

const DEMO_SYMBOLS = new Set(["NVDA", "AAPL", "VOO", "BTC", "TSLA"]);
const DEMO_CLEANUP_VERSION = 4;

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

function upsertAsset(state, data) {
  const symbol = data.symbol.trim().toUpperCase();
  const originalSymbol = (data.originalSymbol || symbol).trim().toUpperCase();
  const isEdit = data.mode === "edit";
  const existing = state.assets.find(asset => asset.symbol === (isEdit ? originalSymbol : symbol)) || state.assets.find(asset => asset.symbol === symbol);
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
    marketDataProvider: data.type !== "cash" && data.type !== "other" ? "server" : "manual",
    marketDataLinked: data.type !== "cash" && data.type !== "other",
    quoteUpdatedAt: existing?.quoteUpdatedAt || null
  };
  if (existing) {
    Object.assign(existing, asset);
    if (originalSymbol !== symbol) {
      state.trades.forEach(trade => {
        if (trade.symbol === originalSymbol) trade.symbol = symbol;
      });
      state.tasks?.forEach(task => {
        if (task.symbol === originalSymbol) task.symbol = symbol;
      });
      state.news?.forEach(item => {
        if (item.symbol === originalSymbol) item.symbol = symbol;
      });
    }
  }
  else state.assets.push(asset);
  if (isEdit) {
    state.trades = state.trades.filter(trade => trade.symbol !== originalSymbol && trade.symbol !== symbol);
  }
  if (Number(data.quantity || 0) > 0 && Number(data.costPrice || data.price || 0) > 0) {
    state.trades.push({
      id: "test-trade",
      symbol,
      action: "buy",
      quantity: Number(data.quantity || 0),
      price: Number(data.costPrice || data.price || 0),
      fees: Number(data.fees || 0),
      date: data.purchaseDate,
      memo: isEdit ? "Manual holding update" : (data.notes.trim() || "Initial position entry")
    });
  }
  state.selectedSymbol = symbol;
}

function buildLots(state, symbol) {
  const lots = [];
  state.trades.filter(trade => trade.symbol === symbol)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .forEach(trade => {
      const quantity = Number(trade.quantity || 0);
      const price = Number(trade.price || 0);
      const fees = Number(trade.fees || 0);
      if (trade.action === "buy" || trade.action === "deposit") {
        lots.push({
          date: trade.date,
          remaining: quantity,
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

function positionFor(state, asset) {
  const lots = buildLots(state, asset.symbol);
  const quantity = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.remaining * lot.unitCost, 0);
  return {
    quantity,
    cost,
    value: quantity * Number(asset.price || 0)
  };
}

const migrated = migrateState({
  demoCleanupVersion: 2,
  selectedSymbol: "VOO",
  selectedTaskId: "task-tax",
  selectedIdeaId: "idea-etfs",
  assets: [
    { symbol: "VOO", name: "Vanguard S&P 500 ETF", price: 512.4 },
    { symbol: "NVDA", name: "NVIDIA Corp.", price: 627.8 },
    { symbol: "MSTR", name: "MSTR", price: 177.17 },
    { symbol: "SOL", name: "Solana", price: 84.3 }
  ],
  trades: [
    { id: "t1", symbol: "NVDA", action: "buy", quantity: 55, price: 328.2, date: "2024-08-12" },
    { id: "real1", symbol: "MSTR", action: "buy", quantity: 12, price: 150, fees: 0, date: "2026-05-01" }
  ],
  tasks: [{ id: "task-tax" }],
  ideas: [{ id: "idea-etfs" }],
  news: [{ source: "Sample Intel" }]
});

assert.deepStrictEqual(migrated.assets.map(asset => asset.symbol), ["MSTR", "SOL"]);
assert.deepStrictEqual(migrated.trades.map(trade => trade.symbol), ["MSTR"]);
assert.strictEqual(migrated.selectedSymbol, "MSTR");
assert.strictEqual(migrated.tasks.length, 0);
assert.strictEqual(migrated.ideas.length, 0);
assert.strictEqual(migrated.news.length, 0);
assert.strictEqual(migrated.demoCleanupVersion, DEMO_CLEANUP_VERSION);

const mstr = positionFor(migrated, migrated.assets[0]);
assert.strictEqual(mstr.quantity, 12);
assert.strictEqual(mstr.cost, 1800);
assert.strictEqual(Number(mstr.value.toFixed(2)), 2126.04);

const staleDemo = migrateState({
  demoCleanupVersion: 3,
  selectedSymbol: "VOO",
  assets: [{ symbol: "VOO" }, { symbol: "SOL", price: 84.3 }],
  trades: [{ id: "real-sol", symbol: "SOL", action: "buy", quantity: 4.5, price: 80, date: "2026-05-03" }],
  tasks: [],
  ideas: [],
  news: []
});

assert.deepStrictEqual(staleDemo.assets.map(asset => asset.symbol), ["SOL"]);
assert.strictEqual(positionFor(staleDemo, staleDemo.assets[0]).quantity, 4.5);

const entryState = { assets: [], trades: [] };
upsertAsset(entryState, {
  symbol: "mstr",
  name: "MicroStrategy",
  type: "stock",
  price: "177.17",
  targetWeight: "10",
  color: "#f5b21a",
  quantity: "12",
  costPrice: "150",
  fees: "0",
  purchaseDate: "2026-05-03",
  notes: ""
});
assert.strictEqual(entryState.assets[0].symbol, "MSTR");
assert.strictEqual(positionFor(entryState, entryState.assets[0]).quantity, 12);

upsertAsset(entryState, {
  mode: "edit",
  originalSymbol: "MSTR",
  symbol: "MSTR",
  name: "MicroStrategy",
  type: "stock",
  price: "180",
  targetWeight: "12",
  color: "#f5b21a",
  quantity: "20",
  costPrice: "160",
  fees: "0",
  purchaseDate: "2026-05-04",
  notes: ""
});
const editedMstr = positionFor(entryState, entryState.assets[0]);
assert.strictEqual(entryState.trades.length, 1);
assert.strictEqual(editedMstr.quantity, 20);
assert.strictEqual(editedMstr.cost, 3200);
assert.strictEqual(entryState.trades[0].memo, "Manual holding update");

console.log("portfolio-state tests passed");
