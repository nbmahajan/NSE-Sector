import { readFile } from "node:fs/promises";
import path from "node:path";
import { demoIndices, demoQuotes } from "./providers/demo.mjs";
import { loadAngelOneQuotes } from "./providers/angel-one.mjs";
import { loadNseIndices } from "./providers/nse-index.mjs";

const NSE_REFRESH_MS = 300000;
const ANGEL_REFRESH_MS = 60000;

function classify(quote) {
  if (!quote.cash || !quote.futures
      || !Number.isFinite(quote.cash.netQty)
      || !Number.isFinite(quote.futures.netQty)) {
    return "unavailable";
  }
  if (quote.cash.netQty > 0 && quote.futures.netQty > 0) return "green";
  if (quote.cash.netQty < 0 && quote.futures.netQty < 0) return "red";
  return "white";
}

function sourceResult(ok, state, message, sourceTime) {
  return { ok: ok, state: state, message: message, sourceTime: sourceTime || null };
}

function nextFetchTime(lastAttemptAt, intervalMs) {
  const dueAt = lastAttemptAt ? lastAttemptAt + intervalMs : Date.now();
  return new Date(dueAt).toISOString();
}

export function createDataService(projectRoot, angelSession) {
  let currentSnapshot = null;
  let refreshPromise = null;
  let forceRefreshQueued = false;
  let lastNseAttemptAt = 0;
  let lastAngelAttemptAt = 0;
  let angelGeneration = 0;
  let nseCache = {
    indices: [],
    sourceTime: null,
    status: sourceResult(false, "offline", "Waiting for NSE source setup", null)
  };
  let angelCache = {
    quotes: [],
    symbols: [],
    missingInstruments: [],
    failedBatchCount: 0,
    sourceTime: null,
    status: sourceResult(false, "offline", "Waiting for Angel One setup", null)
  };

  async function getConfiguration() {
    const watchlistText = (await readFile(path.join(projectRoot, "config", "watchlist.json"), "utf8")).replace(/^\uFEFF/, "");
    const indexNamesText = (await readFile(path.join(projectRoot, "config", "sectoral-indices.json"), "utf8")).replace(/^\uFEFF/, "");
    const parsedWatchlist = JSON.parse(watchlistText);
    const sectoralIndexNames = JSON.parse(indexNamesText);
    let watchlist;
    if (Array.isArray(parsedWatchlist)) {
      watchlist = { mode: "selected", symbols: parsedWatchlist.map(function (symbol) { return String(symbol).trim().toUpperCase(); }) };
    } else {
      watchlist = {
        mode: parsedWatchlist.mode === "selected" ? "selected" : "all_nse_fo_stocks",
        symbols: Array.isArray(parsedWatchlist.symbols)
          ? parsedWatchlist.symbols.map(function (symbol) { return String(symbol).trim().toUpperCase(); })
          : []
      };
    }
    return { watchlist: watchlist, sectoralIndexNames: sectoralIndexNames };
  }

  async function refreshNse(names) {
    const startedAt = Date.now();
    lastNseAttemptAt = startedAt;
    try {
      const result = await loadNseIndices(names);
      if (result.indices.length) {
        nseCache = {
          indices: result.indices,
          sourceTime: result.sourceTime,
          status: sourceResult(true, "snapshot", "Official NSE site · market indices pChange", result.sourceTime)
        };
      } else {
        nseCache.status = sourceResult(false, nseCache.indices.length ? "stale" : "offline", "No configured sector indices matched", nseCache.sourceTime);
      }
    } catch (error) {
      nseCache.status = sourceResult(false, nseCache.indices.length ? "stale" : "offline", error.message || "NSE source unavailable", nseCache.sourceTime);
    }
  }

  async function refreshAngel(watchlist) {
    const generation = angelGeneration;
    const startedAt = Date.now();
    lastAngelAttemptAt = startedAt;
    if (!angelSession || !angelSession.status().authenticated) {
      angelCache = {
        quotes: [], symbols: [], missingInstruments: [], failedBatchCount: 0,
        sourceTime: null,
        status: sourceResult(false, "offline", "Sign in to Angel One", null)
      };
      return;
    }
    try {
      const result = await loadAngelOneQuotes(watchlist, angelSession);
      if (generation !== angelGeneration) return;
      const message = result.failedBatchCount
        ? "Angel One partial · " + result.failedBatchCount + " batch(es) failed"
        : "Angel One SmartAPI";
      angelCache = {
        quotes: result.quotes,
        symbols: result.symbols || [],
        missingInstruments: result.missingInstruments || [],
        failedBatchCount: result.failedBatchCount || 0,
        sourceTime: result.sourceTime,
        status: sourceResult(true, result.failedBatchCount ? "partial" : "live", message, result.sourceTime)
      };
    } catch (error) {
      if (generation !== angelGeneration) return;
      angelCache.status = sourceResult(false, angelCache.quotes.length ? "stale" : "offline", error.message || "Angel One source unavailable", angelCache.sourceTime);
    }
  }

  async function performRefresh(force) {
    const config = await getConfiguration();
    const mode = String(process.env.DATA_MODE || "live").toLowerCase() === "demo" ? "demo" : "live";
    let indices = [];
    let quotes = [];
    let indexStatus;
    let angelStatus;
    let unlistedSymbols = [];
    let trackedSymbols = config.watchlist.mode === "selected" ? config.watchlist.symbols : [];

    if (mode === "demo") {
      indices = demoIndices;
      quotes = config.watchlist.mode === "selected"
        ? demoQuotes.filter(function (item) { return config.watchlist.symbols.includes(item.symbol); })
        : demoQuotes;
      trackedSymbols = quotes.map(function (item) { return item.symbol; });
      indexStatus = sourceResult(true, "demo", "Sample values", new Date().toISOString());
      angelStatus = sourceResult(true, "demo", "Sample quotes", new Date().toISOString());
    } else {
      const now = Date.now();
      const nseDue = force || !lastNseAttemptAt || now - lastNseAttemptAt >= NSE_REFRESH_MS;
      const angelDue = force || !lastAngelAttemptAt || now - lastAngelAttemptAt >= ANGEL_REFRESH_MS;
      const pending = [];
      if (nseDue) pending.push(refreshNse(config.sectoralIndexNames));
      if (angelDue) pending.push(refreshAngel(config.watchlist));
      if (pending.length) await Promise.allSettled(pending);

      indices = nseCache.indices;
      quotes = angelCache.quotes;
      unlistedSymbols = angelCache.missingInstruments;
      trackedSymbols = config.watchlist.mode === "all_nse_fo_stocks"
        ? angelCache.symbols
        : config.watchlist.symbols;
      indexStatus = nseCache.status;
      angelStatus = angelCache.status;
    }

    const bySymbol = new Map(quotes.map(function (quote) { return [quote.symbol, quote]; }));
    const rows = trackedSymbols.map(function (symbol) {
      const quote = bySymbol.get(symbol);
      if (!quote) return { symbol: symbol, bucket: "unavailable", unavailableReason: "No quote received" };
      const bucket = classify(quote);
      return { ...quote, bucket: bucket, unavailableReason: quote.unavailableReason || null };
    });
    const grouped = {
      green: rows.filter(function (row) { return row.bucket === "green"; }),
      red: rows.filter(function (row) { return row.bucket === "red"; }),
      white: rows.filter(function (row) { return row.bucket === "white"; }),
      unavailable: rows.filter(function (row) { return row.bucket === "unavailable"; })
    };

    currentSnapshot = {
      mode: mode,
      universe: config.watchlist.mode === "all_nse_fo_stocks" ? "All NSE F&O stocks with active futures contracts" : "Selected watchlist",
      refreshSeconds: 60,
      nseRefreshSeconds: 300,
      updatedAt: new Date().toISOString(),
      nextFetchAt: {
        nse: nextFetchTime(lastNseAttemptAt, NSE_REFRESH_MS),
        angelOne: nextFetchTime(lastAngelAttemptAt, ANGEL_REFRESH_MS)
      },
      indices: indices,
      groups: grouped,
      trackedSymbolCount: trackedSymbols.length,
      unlistedSymbols: unlistedSymbols,
      sources: { nse: indexStatus, angelOne: angelStatus }
    };
    return currentSnapshot;
  }

  function startRefresh(force) {
    let tracked;
    tracked = performRefresh(Boolean(force)).finally(function () {
      if (refreshPromise === tracked) refreshPromise = null;
    });
    refreshPromise = tracked;
    return tracked;
  }

  return {
    async refresh(force) {
      if (refreshPromise) {
        if (force) forceRefreshQueued = true;
        const active = refreshPromise;
        const result = await active;
        if (forceRefreshQueued && !refreshPromise) {
          forceRefreshQueued = false;
          return startRefresh(true);
        }
        return result;
      }
      return startRefresh(force);
    },
    getSnapshot() {
      return currentSnapshot;
    },
    resetAngel() {
      angelGeneration += 1;
      lastAngelAttemptAt = 0;
      currentSnapshot = null;
      angelCache = {
        quotes: [], symbols: [], missingInstruments: [], failedBatchCount: 0,
        sourceTime: null,
        status: sourceResult(false, "offline", "Sign in to Angel One", null)
      };
    }
  };
}

