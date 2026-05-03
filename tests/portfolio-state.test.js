"use strict";

const assert = require("assert");

function migrateState(nextState) {
  if (Number(nextState.demoCleanupVersion || 0) < 3) {
    const demoSymbols = new Set(["NVDA", "AAPL", "VOO", "BTC", "TSLA"]);
    const hasDemoAssets = Array.isArray(nextState.assets) && nextState.assets.some(asset => demoSymbols.has(asset.symbol));
    const hasDemoTradeIds = Array.isArray(nextState.trades) && nextState.trades.some(trade => /^t[1-7]$/.test(String(trade.id)));
    if (hasDemoAssets || hasDemoTradeIds) {
      nextState.assets = (nextState.assets || []).filter(asset => !demoSymbols.has(asset.symbol));
      nextState.trades = (nextState.trades || []).filter(trade => !demoSymbols.has(trade.symbol) && !/^t[1-7]$/.test(String(trade.id)));
      nextState.tasks = (nextState.tasks || []).filter(task => !String(task.id || "").startsWith("task-"));
      nextState.ideas = (nextState.ideas || []).filter(idea => !String(idea.id || "").startsWith("idea-"));
      nextState.news = (nextState.news || []).filter(item => item.source !== "Sample Intel");
      if (demoSymbols.has(nextState.selectedSymbol)) nextState.selectedSymbol = nextState.assets[0]?.symbol || null;
      nextState.selectedTaskId = nextState.tasks[0]?.id || null;
      nextState.selectedIdeaId = nextState.ideas[0]?.id || null;
    }
    delete nextState.demoDataCleared;
    nextState.demoCleanupVersion = 3;
  }
  return nextState;
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
assert.strictEqual(migrated.demoCleanupVersion, 3);

const mstr = positionFor(migrated, migrated.assets[0]);
assert.strictEqual(mstr.quantity, 12);
assert.strictEqual(mstr.cost, 1800);
assert.strictEqual(Number(mstr.value.toFixed(2)), 2126.04);

console.log("portfolio-state tests passed");
