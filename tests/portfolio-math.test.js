"use strict";

/**
 * Tests for lib/portfolio-math.js — the canonical pure-math module.
 *
 * Run from repo root:
 *   node --test tests/portfolio-math.test.js
 * Or run the whole suite:
 *   node --test
 *
 * Tests are organized by function. Each `test()` block is one independent case
 * with its own fixtures, so failures point straight at the offending behavior.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PM = require("../lib/portfolio-math.js");

// Tolerance for floating-point assertions — the math uses doubles, so use
// `closeTo` when comparing computed sums rather than strictEqual.
const EPS = 1e-6;
const closeTo = (actual, expected, eps = EPS) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ~= ${expected} (within ${eps})`
  );

// ============================================================
// constants
// ============================================================

test("constants: DEMO_SYMBOLS + cleanup version + default profile are exported", () => {
  assert.ok(PM.DEMO_SYMBOLS instanceof Set);
  assert.ok(PM.DEMO_SYMBOLS.has("NVDA"));
  assert.equal(PM.DEMO_CLEANUP_VERSION, 4);
  assert.equal(PM.DEFAULT_PROFILE.baseCurrency, "USD");
  assert.equal(PM.DEFAULT_PROFILE.timeZone, "America/New_York");
});

// ============================================================
// buildLotsFromTrades
// ============================================================

test("buildLots: empty input returns empty array", () => {
  assert.deepEqual(PM.buildLotsFromTrades([], "AAPL"), []);
  assert.deepEqual(PM.buildLotsFromTrades(null, "AAPL"), []);
  assert.deepEqual(PM.buildLotsFromTrades(undefined, "AAPL"), []);
});

test("buildLots: missing symbol returns empty array", () => {
  const trades = [{ symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }];
  assert.deepEqual(PM.buildLotsFromTrades(trades, ""), []);
  assert.deepEqual(PM.buildLotsFromTrades(trades, null), []);
});

test("buildLots: single buy creates one lot at unit cost = price + fee/qty", () => {
  const lots = PM.buildLotsFromTrades(
    [{ id: "t1", symbol: "AAPL", action: "buy", quantity: 10, price: 100, fees: 5, date: "2024-01-01" }],
    "AAPL"
  );
  assert.equal(lots.length, 1);
  assert.equal(lots[0].quantity, 10);
  assert.equal(lots[0].remaining, 10);
  closeTo(lots[0].cost, 1005);     // 10*100 + 5
  closeTo(lots[0].unitCost, 100.5); // 1005 / 10
});

test("buildLots: ignores other symbols", () => {
  const lots = PM.buildLotsFromTrades(
    [
      { id: "a", symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" },
      { id: "n", symbol: "NVDA", action: "buy", quantity: 5, price: 500, date: "2024-01-01" }
    ],
    "AAPL"
  );
  assert.equal(lots.length, 1);
  assert.equal(lots[0].id, "a");
});

test("buildLots: trades are sorted by date even when supplied out of order", () => {
  const lots = PM.buildLotsFromTrades(
    [
      { id: "later",  symbol: "AAPL", action: "buy", quantity: 10, price: 200, date: "2024-06-01" },
      { id: "first", symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }
    ],
    "AAPL"
  );
  assert.deepEqual(lots.map(l => l.id), ["first", "later"]);
});

test("buildLots: sells drain oldest lots first (FIFO)", () => {
  const lots = PM.buildLotsFromTrades(
    [
      { id: "lot1", symbol: "AAPL", action: "buy",  quantity: 10, price: 100, date: "2024-01-01" },
      { id: "lot2", symbol: "AAPL", action: "buy",  quantity: 10, price: 200, date: "2024-02-01" },
      { id: "s1",   symbol: "AAPL", action: "sell", quantity: 8,  price: 250, date: "2024-03-01" }
    ],
    "AAPL"
  );
  // First lot should have 2 left, second lot untouched at 10.
  assert.equal(lots.length, 2);
  assert.equal(lots[0].id, "lot1");
  assert.equal(lots[0].remaining, 2);
  assert.equal(lots[1].id, "lot2");
  assert.equal(lots[1].remaining, 10);
});

test("buildLots: sell spanning multiple lots leaves only newer lots", () => {
  const lots = PM.buildLotsFromTrades(
    [
      { id: "lot1", symbol: "AAPL", action: "buy",  quantity: 10, price: 100, date: "2024-01-01" },
      { id: "lot2", symbol: "AAPL", action: "buy",  quantity: 10, price: 200, date: "2024-02-01" },
      { id: "lot3", symbol: "AAPL", action: "buy",  quantity: 10, price: 300, date: "2024-03-01" },
      { id: "s1",   symbol: "AAPL", action: "sell", quantity: 25, price: 400, date: "2024-04-01" }
    ],
    "AAPL"
  );
  // 25 sold drains lot1 (10), lot2 (10), and 5 of lot3 → only lot3 remains with 5.
  assert.equal(lots.length, 1);
  assert.equal(lots[0].id, "lot3");
  assert.equal(lots[0].remaining, 5);
});

test("buildLots: oversell drains everything (no negative remaining)", () => {
  // Selling 100 when only 10 exist — should leave nothing, not negatives.
  const lots = PM.buildLotsFromTrades(
    [
      { symbol: "AAPL", action: "buy",  quantity: 10,  price: 100, date: "2024-01-01" },
      { symbol: "AAPL", action: "sell", quantity: 100, price: 200, date: "2024-02-01" }
    ],
    "AAPL"
  );
  assert.deepEqual(lots, []);
});

test("buildLots: deposit acts like buy, withdraw acts like sell", () => {
  // Used for cash / crypto staking where 'deposit'/'withdraw' are the verbs.
  const lots = PM.buildLotsFromTrades(
    [
      { symbol: "USDC", action: "deposit",  quantity: 1000, price: 1, date: "2024-01-01" },
      { symbol: "USDC", action: "withdraw", quantity: 300,  price: 1, date: "2024-02-01" }
    ],
    "USDC"
  );
  assert.equal(lots.length, 1);
  closeTo(lots[0].remaining, 700);
});

test("buildLots: lots with effectively-zero remaining (< 1e-7) are filtered out", () => {
  // Float-precision case — selling the exact buy amount should leave no lots.
  const lots = PM.buildLotsFromTrades(
    [
      { symbol: "BTC", action: "buy",  quantity: 0.1, price: 60000, date: "2024-01-01" },
      { symbol: "BTC", action: "buy",  quantity: 0.2, price: 60000, date: "2024-02-01" },
      { symbol: "BTC", action: "sell", quantity: 0.3, price: 70000, date: "2024-03-01" }
    ],
    "BTC"
  );
  // 0.1 + 0.2 - 0.3 = 5.55e-17 in IEEE 754. Filter must catch this.
  assert.equal(lots.length, 0);
});

test("buildLots: zero-quantity buy doesn't NaN the unit cost", () => {
  const lots = PM.buildLotsFromTrades(
    [{ symbol: "X", action: "buy", quantity: 0, price: 100, date: "2024-01-01" }],
    "X"
  );
  // Zero remaining gets filtered, so empty result.
  assert.equal(lots.length, 0);
});

// ============================================================
// positionForAsset
// ============================================================

test("positionFor: null asset returns null", () => {
  assert.equal(PM.positionForAsset(null, []), null);
});

test("positionFor: no trades = zero quantity, zero cost, zero value", () => {
  const pos = PM.positionForAsset(
    { symbol: "AAPL", price: 200 },
    []
  );
  assert.equal(pos.quantity, 0);
  assert.equal(pos.cost, 0);
  assert.equal(pos.value, 0);
  assert.equal(pos.gain, 0);
  assert.equal(pos.gainPct, 0);
});

test("positionFor: rolls up lots and computes gain at current price", () => {
  const pos = PM.positionForAsset(
    { symbol: "AAPL", price: 200, previousClose: 180 },
    [
      { symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" },
      { symbol: "AAPL", action: "buy", quantity: 5,  price: 150, date: "2024-02-01" }
    ]
  );
  assert.equal(pos.quantity, 15);
  closeTo(pos.cost, 1750);           // 10*100 + 5*150
  closeTo(pos.value, 3000);          // 15 * 200
  closeTo(pos.gain, 1250);           // 3000 - 1750
  closeTo(pos.gainPct, 71.42857143, 1e-4);
  // dayChange uses previousClose, not lot-level math: 200 vs 180 -> +11.11%
  closeTo(pos.dayChangePct, 11.11111111, 1e-4);
});

test("positionFor: dayChangePct is 0 when previousClose is missing", () => {
  const pos = PM.positionForAsset({ symbol: "X", price: 100 }, []);
  assert.equal(pos.dayChangePct, 0);
});

test("positionFor: preserves asset fields on the returned object", () => {
  const pos = PM.positionForAsset(
    { symbol: "AAPL", name: "Apple Inc", type: "stock", color: "#fff", price: 200 },
    []
  );
  assert.equal(pos.name, "Apple Inc");
  assert.equal(pos.type, "stock");
  assert.equal(pos.color, "#fff");
});

// ============================================================
// portfolioFromState
// ============================================================

test("portfolio: empty state returns zeros", () => {
  const port = PM.portfolioFromState({ assets: [], trades: [] });
  assert.deepEqual(port.positions, []);
  assert.equal(port.value, 0);
  assert.equal(port.cost, 0);
  assert.equal(port.dayPnl, 0);
  assert.equal(port.dayPct, 0);
  assert.equal(port.gain, 0);
  assert.equal(port.gainPct, 0);
});

test("portfolio: multi-asset rollup matches per-position sum", () => {
  const state = {
    assets: [
      { symbol: "AAPL", price: 200, previousClose: 180 },
      { symbol: "NVDA", price: 600, previousClose: 500 }
    ],
    trades: [
      { symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" },
      { symbol: "NVDA", action: "buy", quantity: 2,  price: 400, date: "2024-01-01" }
    ]
  };
  const port = PM.portfolioFromState(state);
  closeTo(port.value, 10 * 200 + 2 * 600);   // 3200
  closeTo(port.cost,  10 * 100 + 2 * 400);   // 1800
  closeTo(port.gain,  port.value - port.cost);
  // previousValue = 10*180 + 2*500 = 2800
  closeTo(port.dayPnl, port.value - 2800);   // 400
  closeTo(port.dayPct, (400 / 2800) * 100, 1e-4);
});

test("portfolio: handles assets with missing prices gracefully", () => {
  const port = PM.portfolioFromState({
    assets: [{ symbol: "X" }],   // no price
    trades: [{ symbol: "X", action: "buy", quantity: 5, price: 10, date: "2024-01-01" }]
  });
  assert.equal(port.positions.length, 1);
  assert.equal(port.value, 0);    // no current price -> no value
  closeTo(port.cost, 50);
});

test("portfolio: undefined assets/trades defaults to empty arrays", () => {
  const port = PM.portfolioFromState({});
  assert.deepEqual(port.positions, []);
  assert.equal(port.value, 0);
});

// ============================================================
// estimateTaxFromTrades
// ============================================================

test("estimateTax: simple short-term gain", () => {
  // Buy at 100, sell at 150, six months later → short-term.
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 10, price: 150, date: "2024-07-01", shortRate: 30, longRate: 15 },
    [{ symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }]
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.term, "short");
  closeTo(row.gain, 500);          // (150-100) * 10
  closeTo(row.tax, 150);           // 500 * 30%
  assert.equal(result.remaining, 0);
});

test("estimateTax: holding period >= 365 days flips to long-term", () => {
  // Exactly 365 days apart → long-term per the >= 365 rule.
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 10, price: 150, date: "2025-01-01", shortRate: 30, longRate: 15 },
    [{ symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }]
  );
  // 2024 was a leap year — Jan 1 2024 → Jan 1 2025 is 366 days, so long-term.
  assert.equal(result.rows[0].term, "long");
  closeTo(result.rows[0].tax, 75); // 500 * 15%
});

test("estimateTax: 364 days held is still short-term", () => {
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 5, price: 200, date: "2024-12-30", shortRate: 30, longRate: 15 },
    [{ symbol: "AAPL", action: "buy", quantity: 5, price: 100, date: "2024-01-01" }]
  );
  assert.equal(result.rows[0].term, "short");
});

test("estimateTax: spans multiple lots — separate rows, mixed terms", () => {
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 15, price: 200, date: "2025-06-01", shortRate: 30, longRate: 15 },
    [
      { symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }, // 17 mo - long
      { symbol: "AAPL", action: "buy", quantity: 10, price: 150, date: "2025-03-01" }  // 3 mo - short
    ]
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].term, "long");
  assert.equal(result.rows[1].term, "short");
  // long: 10 * (200-100) = 1000 @ 15% = 150
  // short: 5 * (200-150) = 250 @ 30% = 75
  closeTo(result.gain, 1250);
  closeTo(result.tax, 225);
  assert.equal(result.remaining, 0);
});

test("estimateTax: losses produce zero tax (no negative tax)", () => {
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 10, price: 50, date: "2024-07-01", shortRate: 30, longRate: 15 },
    [{ symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }]
  );
  closeTo(result.rows[0].gain, -500);
  assert.equal(result.rows[0].tax, 0);
  closeTo(result.tax, 0);
});

test("estimateTax: trying to sell more than you hold leaves a remainder", () => {
  const result = PM.estimateTaxFromTrades(
    { symbol: "AAPL", quantity: 20, price: 200, date: "2024-07-01", shortRate: 30, longRate: 15 },
    [{ symbol: "AAPL", action: "buy", quantity: 10, price: 100, date: "2024-01-01" }]
  );
  assert.equal(result.remaining, 10);
  assert.equal(result.rows[0].qty, 10);
});

// ============================================================
// migrateState
// ============================================================

test("migrateState: fills in schema fields with sensible defaults", () => {
  const out = PM.migrateState({ demoCleanupVersion: PM.DEMO_CLEANUP_VERSION });
  assert.deepEqual(out.priceHistory, {});
  assert.equal(out.chartMode, "asset");
  assert.equal(out.chartRange, "1m");
  assert.equal(out.chartStyle, "area");
  assert.equal(out.newsFilter, "all");
  assert.equal(out.overviewRange, "90d");
  assert.deepEqual(out.overviewBenchmarks, []);
  assert.equal(out.alertFilter, "active");
});

test("migrateState: doesn't overwrite existing non-empty values", () => {
  const out = PM.migrateState({
    demoCleanupVersion: PM.DEMO_CLEANUP_VERSION,
    chartRange: "1y",
    chartStyle: "candle",
    newsFilter: "portfolio"
  });
  assert.equal(out.chartRange, "1y");
  assert.equal(out.chartStyle, "candle");
  assert.equal(out.newsFilter, "portfolio");
});

test("migrateState: strips deprecated fields (ideas, selectedIdeaId, ideaFilter, task.category)", () => {
  const out = PM.migrateState({
    demoCleanupVersion: PM.DEMO_CLEANUP_VERSION,
    ideas: [{ id: "x" }],
    selectedIdeaId: "x",
    ideaFilter: "all",
    tasks: [{ id: "t1", title: "do", category: "work" }]
  });
  assert.equal(out.ideas, undefined);
  assert.equal(out.selectedIdeaId, undefined);
  assert.equal(out.ideaFilter, undefined);
  assert.equal(out.tasks[0].category, undefined);
  // But the task itself should survive.
  assert.equal(out.tasks[0].id, "t1");
});

test("migrateState: removes demo data when demoCleanupVersion is stale", () => {
  const out = PM.migrateState({
    demoCleanupVersion: 2,                        // older than DEMO_CLEANUP_VERSION
    selectedSymbol: "VOO",
    assets: [
      { symbol: "VOO", price: 500 },              // demo
      { symbol: "NVDA", price: 600 },             // demo
      { symbol: "MSTR", price: 180 }              // real
    ],
    trades: [
      { id: "t1",    symbol: "NVDA", action: "buy", quantity: 5,  price: 600, date: "2024-01-01" }, // demo id
      { id: "real1", symbol: "MSTR", action: "buy", quantity: 10, price: 150, date: "2024-01-01" }
    ],
    tasks: [{ id: "task-tax" }, { id: "real-task" }],
    news:  [{ source: "Sample Intel" }, { source: "Yahoo Finance" }]
  });
  assert.deepEqual(out.assets.map(a => a.symbol), ["MSTR"]);
  assert.deepEqual(out.trades.map(t => t.id), ["real1"]);
  assert.deepEqual(out.tasks.map(t => t.id), ["real-task"]);
  assert.deepEqual(out.news.map(n => n.source), ["Yahoo Finance"]);
  assert.equal(out.selectedSymbol, "MSTR");        // demo symbol replaced
  assert.equal(out.demoCleanupVersion, PM.DEMO_CLEANUP_VERSION);
});

test("migrateState: is idempotent — running twice produces same result", () => {
  const input = {
    demoCleanupVersion: 2,
    assets: [{ symbol: "VOO" }, { symbol: "MSTR" }],
    trades: [{ id: "real", symbol: "MSTR", action: "buy", quantity: 1, price: 1, date: "2024-01-01" }],
    tasks: [{ id: "real-task" }],
    news: []
  };
  const once = PM.migrateState(JSON.parse(JSON.stringify(input)));
  const twice = PM.migrateState(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(once.assets, twice.assets);
  assert.deepEqual(once.trades, twice.trades);
  assert.equal(once.demoCleanupVersion, twice.demoCleanupVersion);
});

test("migrateState: preserves profile fields while merging in DEFAULT_PROFILE", () => {
  const out = PM.migrateState({
    demoCleanupVersion: PM.DEMO_CLEANUP_VERSION,
    profile: { displayName: "Luis", baseCurrency: "EUR" }
  });
  assert.equal(out.profile.displayName, "Luis");
  assert.equal(out.profile.baseCurrency, "EUR");
  // missing fields filled from defaults
  assert.equal(out.profile.timeZone, "America/New_York");
  assert.equal(out.profile.investingStyle, "Long-term");
});

test("migrateState: handles totally empty state", () => {
  const out = PM.migrateState({});
  assert.deepEqual(out.priceHistory, {});
  assert.equal(out.alertFilter, "active");
  assert.equal(out.demoCleanupVersion, PM.DEMO_CLEANUP_VERSION);
});

// ============================================================
// squarifyTreemap
// ============================================================

test("treemap: empty input returns empty array", () => {
  assert.deepEqual(PM.squarifyTreemap([], 100, 100), []);
});

test("treemap: zero dimensions returns zero-area rectangles, one per item", () => {
  const items = [{ value: 10 }, { value: 20 }];
  const rects = PM.squarifyTreemap(items, 0, 100);
  assert.equal(rects.length, 2);
  rects.forEach(r => {
    assert.equal(r.w, 0);
    assert.equal(r.h, 0);
  });
});

test("treemap: total area equals w*h (conservation)", () => {
  const items = [
    { value: 100, label: "A" },
    { value: 50,  label: "B" },
    { value: 25,  label: "C" },
    { value: 10,  label: "D" },
    { value: 5,   label: "E" }
  ];
  const W = 400, H = 300;
  const rects = PM.squarifyTreemap(items, W, H);
  const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
  closeTo(totalArea, W * H, 1e-3);
});

test("treemap: rectangles stay within bounds", () => {
  const items = [{ value: 30 }, { value: 20 }, { value: 10 }, { value: 5 }];
  const W = 200, H = 150;
  const rects = PM.squarifyTreemap(items, W, H);
  rects.forEach(r => {
    assert.ok(r.x >= -1e-6 && r.x + r.w <= W + 1e-6, `x in bounds: ${r.x}+${r.w}<=${W}`);
    assert.ok(r.y >= -1e-6 && r.y + r.h <= H + 1e-6, `y in bounds: ${r.y}+${r.h}<=${H}`);
  });
});

test("treemap: parallel-array order matches input order (positions[i] ↔ items[i])", () => {
  const items = [
    { value: 30, label: "A" },
    { value: 20, label: "B" },
    { value: 10, label: "C" }
  ];
  const rects = PM.squarifyTreemap(items, 100, 100);
  rects.forEach((r, i) => assert.equal(r.item.label, items[i].label));
});

test("treemap: largest value gets the largest rectangle", () => {
  const items = [
    { value: 5,   label: "small" },
    { value: 100, label: "big" },
    { value: 20,  label: "mid" }
  ];
  const rects = PM.squarifyTreemap(items, 300, 200);
  const areas = rects.map(r => r.w * r.h);
  // Item index 1 (value=100) must have the largest area.
  const maxIdx = areas.indexOf(Math.max(...areas));
  assert.equal(maxIdx, 1);
});

test("treemap: handles negative-or-zero values by treating them as zero", () => {
  const items = [
    { value: 100 },
    { value: 0 },
    { value: -50 }
  ];
  const rects = PM.squarifyTreemap(items, 100, 100);
  // The first tile should cover the full box; the others should have ~0 area.
  closeTo(rects[0].w * rects[0].h, 100 * 100, 1e-3);
});
