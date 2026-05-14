"use strict";

/**
 * portfolio-math.js — canonical implementation of My DailyEdge's pure math.
 *
 * Loaded both:
 *   - in the browser (sets `window.PortfolioMath` — must load BEFORE app.js)
 *   - in Node.js for tests (`require("./lib/portfolio-math")`)
 *
 * Everything here is intentionally pure: no globals, no DOM, no fetch.
 * app.js wraps these with thin functions that pass `state.assets` / `state.trades`.
 *
 * If you change behavior here, update the matching test in tests/portfolio-math.test.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PortfolioMath = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  // ---- constants ----------------------------------------------------------

  const DEMO_SYMBOLS = new Set(["NVDA", "AAPL", "VOO", "BTC", "TSLA"]);
  const DEMO_CLEANUP_VERSION = 4;
  const DEFAULT_PROFILE = {
    displayName: "",
    baseCurrency: "USD",
    timeZone: "America/New_York",
    investingStyle: "Long-term",
    notes: ""
  };

  // ---- FIFO lots ----------------------------------------------------------

  /**
   * FIFO lot tracking. Sells/withdraws drain the oldest lots first.
   * @param {Array<{id?,symbol,action,quantity,price,fees?,date}>} trades
   * @param {string} symbol
   * @returns {Array<{id?,symbol,date,quantity,remaining,cost,unitCost}>}
   */
  function buildLotsFromTrades(trades, symbol) {
    if (!symbol) return [];
    const lots = [];
    (trades || [])
      .filter(trade => trade.symbol === symbol)
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(trade => {
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
          let r = quantity;
          for (const lot of lots) {
            if (r <= 0) break;
            const used = Math.min(lot.remaining, r);
            lot.remaining -= used;
            r -= used;
          }
        }
      });
    return lots.filter(lot => lot.remaining > 0.0000001);
  }

  // ---- per-position aggregate --------------------------------------------

  /**
   * Aggregate an asset's open position from trades.
   * Returns the asset shallow-cloned with quantity/cost/value/gain fields layered on.
   */
  function positionForAsset(asset, trades) {
    if (!asset) return null;
    const lots = buildLotsFromTrades(trades, asset.symbol);
    const quantity = lots.reduce((s, l) => s + l.remaining, 0);
    const cost = lots.reduce((s, l) => s + l.remaining * l.unitCost, 0);
    const value = quantity * Number(asset.price || 0);
    const dayChangePct = asset.previousClose
      ? ((asset.price - asset.previousClose) / asset.previousClose) * 100
      : 0;
    const gain = value - cost;
    const gainPct = cost ? (gain / cost) * 100 : 0;
    return { ...asset, quantity, cost, value, dayChangePct, gain, gainPct, lots };
  }

  // ---- portfolio rollup --------------------------------------------------

  /**
   * Portfolio-level rollup over all assets in the supplied state.
   */
  function portfolioFromState(state) {
    const assets = (state && state.assets) || [];
    const trades = (state && state.trades) || [];
    const positions = assets.map(a => positionForAsset(a, trades));
    const value = positions.reduce((s, p) => s + p.value, 0);
    const cost = positions.reduce((s, p) => s + p.cost, 0);
    const previousValue = positions.reduce(
      (s, p) => s + p.quantity * Number(p.previousClose || p.price || 0),
      0
    );
    const dayPnl = value - previousValue;
    const dayPct = previousValue ? (dayPnl / previousValue) * 100 : 0;
    const gain = value - cost;
    const gainPct = cost ? (gain / cost) * 100 : 0;
    return { positions, value, cost, dayPnl, dayPct, gain, gainPct };
  }

  // ---- FIFO tax estimator ------------------------------------------------

  /**
   * Estimate capital-gains tax on a hypothetical sale, lot-by-lot, FIFO.
   * Holding period >= 365 days = long-term.
   */
  function estimateTaxFromTrades({ symbol, quantity, price, date, shortRate, longRate }, trades) {
    let remaining = Number(quantity || 0);
    const salePrice = Number(price || 0);
    const saleDate = new Date(`${date}T00:00:00`);
    const rows = [];
    buildLotsFromTrades(trades, symbol)
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(lot => {
        if (remaining <= 0) return;
        const qty = Math.min(lot.remaining, remaining);
        const proceeds = qty * salePrice;
        const basis = qty * lot.unitCost;
        const gain = proceeds - basis;
        const daysHeld = Math.round((saleDate - new Date(`${lot.date}T00:00:00`)) / 86400000);
        const term = daysHeld >= 365 ? "long" : "short";
        const tax = gain > 0
          ? gain * ((term === "long" ? Number(longRate) : Number(shortRate)) / 100)
          : 0;
        rows.push({ qty, date: lot.date, unitCost: lot.unitCost, proceeds, basis, gain, term, tax });
        remaining -= qty;
      });
    return {
      rows, remaining,
      proceeds: rows.reduce((s, r) => s + r.proceeds, 0),
      basis: rows.reduce((s, r) => s + r.basis, 0),
      gain: rows.reduce((s, r) => s + r.gain, 0),
      tax: rows.reduce((s, r) => s + r.tax, 0)
    };
  }

  // ---- state migration ---------------------------------------------------

  function removeDemoData(nextState) {
    nextState.assets = (nextState.assets || []).filter(a => !DEMO_SYMBOLS.has(a.symbol));
    nextState.trades = (nextState.trades || []).filter(
      t => !DEMO_SYMBOLS.has(t.symbol) && !/^t[1-7]$/.test(String(t.id))
    );
    nextState.tasks = (nextState.tasks || []).filter(
      t => !String(t.id || "").startsWith("task-")
    );
    nextState.news = (nextState.news || []).filter(n => n.source !== "Sample Intel");
    if (DEMO_SYMBOLS.has(nextState.selectedSymbol)) {
      nextState.selectedSymbol = nextState.assets[0]?.symbol || null;
    }
    nextState.selectedTaskId = nextState.tasks[0]?.id || null;
    delete nextState.demoDataCleared;
    nextState.demoCleanupVersion = DEMO_CLEANUP_VERSION;
    return nextState;
  }

  function migrateState(nextState) {
    nextState.priceHistory ||= {};
    nextState.chartMode ||= "asset";
    nextState.chartRange ||= "1m";
    nextState.chartStyle ||= "area";
    nextState.newsFilter ||= "all";
    nextState.overviewRange ||= "90d";
    if (!Array.isArray(nextState.overviewBenchmarks)) nextState.overviewBenchmarks = [];
    nextState.alertFilter ||= "active";
    delete nextState.ideas;
    delete nextState.selectedIdeaId;
    delete nextState.ideaFilter;
    if (Array.isArray(nextState.tasks)) {
      nextState.tasks.forEach(t => { delete t.category; });
    }
    nextState.profile = { ...DEFAULT_PROFILE, ...(nextState.profile || {}) };
    const hasDemoAssets = Array.isArray(nextState.assets)
      && nextState.assets.some(a => DEMO_SYMBOLS.has(a.symbol));
    const hasDemoTradeIds = Array.isArray(nextState.trades)
      && nextState.trades.some(t => /^t[1-7]$/.test(String(t.id)));
    if (hasDemoAssets || hasDemoTradeIds
        || Number(nextState.demoCleanupVersion || 0) < DEMO_CLEANUP_VERSION) {
      nextState = removeDemoData(nextState);
    }
    return nextState;
  }

  // ---- squarified treemap (Bruls/Huijsen/van Wijk, 1999) -----------------

  function squarifyTreemap(items, w, h) {
    const positions = new Array(items.length);
    const total = items.reduce((s, x) => s + Math.max(0, x.value || 0), 0);
    if (!total || w <= 0 || h <= 0) {
      return items.map((it, i) => ({ x: 0, y: 0, w: 0, h: 0, item: it, _i: i }));
    }
    const scale = (w * h) / total;
    const tiles = items
      .map((it, i) => ({ a: Math.max(0, it.value || 0) * scale, i, item: it }))
      .sort((a, b) => b.a - a.a);

    function worstRatio(row, side) {
      if (!row.length || side <= 0) return Infinity;
      const sum = row.reduce((s, t) => s + t.a, 0);
      const max = Math.max(...row.map(t => t.a));
      const min = Math.min(...row.map(t => t.a));
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
    }

    function commitRow(row, rect) {
      const sum = row.reduce((s, t) => s + t.a, 0);
      const horiz = rect.w >= rect.h;
      const depth = sum / (horiz ? rect.h : rect.w);
      let offset = 0;
      for (const t of row) {
        const len = t.a / depth;
        if (horiz) {
          positions[t.i] = { x: rect.x, y: rect.y + offset, w: depth, h: len, item: t.item };
          offset += len;
        } else {
          positions[t.i] = { x: rect.x + offset, y: rect.y, w: len, h: depth, item: t.item };
          offset += len;
        }
      }
      return horiz
        ? { x: rect.x + depth, y: rect.y, w: rect.w - depth, h: rect.h }
        : { x: rect.x, y: rect.y + depth, w: rect.w, h: rect.h - depth };
    }

    let rect = { x: 0, y: 0, w, h };
    let row = [];
    for (const t of tiles) {
      const side = Math.min(rect.w, rect.h);
      const trial = [...row, t];
      if (row.length === 0 || worstRatio(trial, side) <= worstRatio(row, side)) {
        row.push(t);
      } else {
        rect = commitRow(row, rect);
        row = [t];
      }
    }
    if (row.length) commitRow(row, rect);
    return positions;
  }

  // ---- public API --------------------------------------------------------

  return {
    DEMO_SYMBOLS,
    DEMO_CLEANUP_VERSION,
    DEFAULT_PROFILE,
    buildLotsFromTrades,
    positionForAsset,
    portfolioFromState,
    estimateTaxFromTrades,
    migrateState,
    removeDemoData,
    squarifyTreemap
  };
});
