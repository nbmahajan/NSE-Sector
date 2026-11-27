import { readFile } from "node:fs/promises";
import path from "node:path";
import { demoIndices, demoQuotes } from "./providers/demo.mjs";
import { loadAngelOneQuotes } from "./providers/angel-one.mjs";
import { loadNseIndices, loadNseTradingHolidays } from "./providers/nse-index.mjs";

const NSE_REFRESH_MS = 300000;
const ANGEL_REFRESH_MS = 60000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MARKET_OPEN_MINUTE = 9 * 60 + 15;
const NSE_INDEX_CLOSE_MINUTE = 15 * 60 + 30;
const ANGEL_STOCK_FUTURE_CLOSE_MINUTE = 15 * 60 + 45;
const HOLIDAY_RETRY_MS = 5 * MINUTE_MS;

function istDateParts(timestamp) {
  const date = new Date(timestamp + IST_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes()
  };
}

function dateKey(date) {
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
}

function getMarketWindow(timestamp, closeMinute, holidays) {
  const parts = istDateParts(timestamp);
  const todayStartUtc = Date.UTC(parts.year, parts.month, parts.day);
  const todayKey = dateKey(new Date(todayStartUtc));
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5;
  const isHoliday = Boolean(holidays && holidays.has(todayKey));
  const clockOpen = isWeekday && parts.minute >= MARKET_OPEN_MINUTE && parts.minute < closeMinute;
  const isOpen = clockOpen && !isHoliday;
  const closeAt = todayStartUtc + closeMinute * MINUTE_MS - IST_OFFSET_MS;
  let nextOpenAt = null;

  for (let offset = 0; offset <= 370; offset += 1) {
    const candidateDate = new Date(todayStartUtc + offset * DAY_MS);
    const candidateWeekday = candidateDate.getUTCDay();
    const candidateKey = dateKey(candidateDate);
    if (candidateWeekday < 1 || candidateWeekday > 5 || (holidays && holidays.has(candidateKey))) continue;
    const candidateOpenAt = Date.UTC(candidateDate.getUTCFullYear(), candidateDate.getUTCMonth(), candidateDate.getUTCDate(), 9, 15) - IST_OFFSET_MS;
    if (candidateOpenAt > timestamp) {
      nextOpenAt = candidateOpenAt;
      break;
    }
  }

  return { year: parts.year, clockOpen: clockOpen, isOpen: isOpen, closeAt: closeAt, nextOpenAt: nextOpenAt };
}

function nextFetchTime(lastAttemptAt, intervalMs, marketWindow, now) {
  if (!marketWindow.isOpen) return new Date(marketWindow.nextOpenAt || now + DAY_MS).toISOString();
  const dueAt = lastAttemptAt ? Math.max(now, lastAttemptAt + intervalMs) : now;
  return new Date(dueAt < marketWindow.closeAt ? dueAt : (marketWindow.nextOpenAt || now + DAY_MS)).toISOString();
}

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

export function createDataService(projectRoot, angelSession) {
  let currentSnapshot = null;
  let refreshPromise = null;
  let forceRefreshQueued = false;
  let forceRefreshQueuedOutsideMarketHours = false;
  let lastNseAttemptAt = 0;
  let lastAngelAttemptAt = 0;
  let lastCompletedRefreshAt = null;
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
  let holidayCalendar = null;
  let holidayCalendarYear = null;
  let holidayCalendarLoadedAt = 0;
  let holidayCalendarRetryAt = 0;
  let holidayCalendarError = null;

  async function getHolidayCalendar(year, now) {
    if (holidayCalendar && holidayCalendarYear === year && now - holidayCalendarLoadedAt < 12 * 60 * 60 * 1000) {
      return holidayCalendar;
    }
    if (holidayCalendarError && now < holidayCalendarRetryAt) {
      if (holidayCalendar && holidayCalendarYear === year) return holidayCalendar;
      throw new Error(holidayCalendarError);
    }
    try {
      holidayCalendar = await loadNseTradingHolidays(year);
      holidayCalendarYear = year;
      holidayCalendarLoadedAt = Date.now();
      holidayCalendarRetryAt = 0;
      holidayCalendarError = null;
      return holidayCalendar;
    } catch (error) {
      holidayCalendarRetryAt = Date.now() + HOLIDAY_RETRY_MS;
      holidayCalendarError = error.message || "NSE trading calendar could not be loaded.";
      if (holidayCalendar && holidayCalendarYear === year) return holidayCalendar;
      throw new Error(holidayCalendarError);
    }
  }

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

  async function refreshNse(names, force) {
    const startedAt = Date.now();
    lastNseAttemptAt = startedAt;
    try {
      const result = await loadNseIndices(names, force);
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
    } finally {
      lastCompletedRefreshAt = Date.now();
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
        ? "Angel One partial · " + result.failedBatchCount + " batch(es) failed" + (result.failedBatchMessage ? " · " + result.failedBatchMessage : "")
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
      const invalidApiKey = Boolean(error && error.code === "ANGEL_INVALID_API_KEY");
      if (invalidApiKey) {
        angelGeneration += 1;
        console.warn("[Angel One] Market-data API rejected the active SmartAPI key; keeping the dashboard session and clearing only the unusable quote snapshot.");
        angelCache = {
          quotes: [], symbols: [], missingInstruments: [], failedBatchCount: 0,
          sourceTime: null,
          status: sourceResult(false, "offline", error.message || "Angel One rejected the SmartAPI API key (AG8004). Check the current API key in SmartAPI, then sign out and sign in with the corrected key.", null)
        };
        return;
      }
      angelCache.status = sourceResult(false, angelCache.quotes.length ? "stale" : "offline", error.message || "Angel One source unavailable", angelCache.sourceTime);
    } finally {
      lastCompletedRefreshAt = Date.now();
    }
  }

  async function performRefresh(force, allowOutsideMarketHours) {
    const config = await getConfiguration();
    const mode = String(process.env.DATA_MODE || "live").toLowerCase() === "demo" ? "demo" : "live";
    let now = Date.now();
    let indices = [];
    let quotes = [];
    let indexStatus;
    let angelStatus;
    let unlistedSymbols = [];
    let trackedSymbols = config.watchlist.mode === "selected" ? config.watchlist.symbols : [];
    let nseClockWindow = getMarketWindow(now, NSE_INDEX_CLOSE_MINUTE, null);
    let angelClockWindow = getMarketWindow(now, ANGEL_STOCK_FUTURE_CLOSE_MINUTE, null);
    let nseMarketWindow = nseClockWindow;
    let angelMarketWindow = angelClockWindow;
    let calendarForToday = null;
    let calendarError = null;
    let calendarBlocked = false;

    if (mode === "demo") {
      indices = demoIndices;
      quotes = config.watchlist.mode === "selected"
        ? demoQuotes.filter(function (item) { return config.watchlist.symbols.includes(item.symbol); })
        : demoQuotes;
      trackedSymbols = quotes.map(function (item) { return item.symbol; });
      indexStatus = sourceResult(true, "demo", "Sample values", new Date().toISOString());
      angelStatus = sourceResult(true, "demo", "Sample quotes", new Date().toISOString());
      lastCompletedRefreshAt = Date.now();
    } else {
      if (nseClockWindow.clockOpen || angelClockWindow.clockOpen) {
        try {
          calendarForToday = await getHolidayCalendar(istDateParts(now).year, now);
          now = Date.now();
          nseClockWindow = getMarketWindow(now, NSE_INDEX_CLOSE_MINUTE, null);
          angelClockWindow = getMarketWindow(now, ANGEL_STOCK_FUTURE_CLOSE_MINUTE, null);
        } catch (error) {
          calendarError = error.message || "NSE trading calendar could not be loaded.";
        }
      } else if (holidayCalendar && holidayCalendarYear === istDateParts(now).year) {
        calendarForToday = holidayCalendar;
      }

      if (calendarForToday && calendarForToday.year === istDateParts(now).year) {
        nseMarketWindow = getMarketWindow(now, NSE_INDEX_CLOSE_MINUTE, calendarForToday.CM);
        angelMarketWindow = getMarketWindow(now, ANGEL_STOCK_FUTURE_CLOSE_MINUTE, new Set([...calendarForToday.CM, ...calendarForToday.FO]));
      } else {
        nseMarketWindow = getMarketWindow(now, NSE_INDEX_CLOSE_MINUTE, null);
        angelMarketWindow = getMarketWindow(now, ANGEL_STOCK_FUTURE_CLOSE_MINUTE, null);
        calendarBlocked = Boolean(calendarError && (nseClockWindow.clockOpen || angelClockWindow.clockOpen));
        if (calendarBlocked) {
          nseMarketWindow.isOpen = false;
          angelMarketWindow.isOpen = false;
          const pausedMessage = "NSE trading calendar unavailable; quote refresh is paused";
          nseCache.status = sourceResult(false, "offline", pausedMessage, nseCache.sourceTime);
          angelCache.status = sourceResult(false, "offline", pausedMessage, angelCache.sourceTime);
        }
      }

      const nseDue = (nseMarketWindow.isOpen || allowOutsideMarketHours) && (force || !lastNseAttemptAt || now - lastNseAttemptAt >= NSE_REFRESH_MS);
      const angelDue = (angelMarketWindow.isOpen || allowOutsideMarketHours) && (force || !lastAngelAttemptAt || now - lastAngelAttemptAt >= ANGEL_REFRESH_MS);
      const pending = [];
      if (nseDue) pending.push(refreshNse(config.sectoralIndexNames, force));
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
      updatedAt: lastCompletedRefreshAt ? new Date(lastCompletedRefreshAt).toISOString() : null,
      nextFetchAt: {
        nse: calendarBlocked
          ? new Date(Math.max(now, holidayCalendarRetryAt)).toISOString()
          : nextFetchTime(lastNseAttemptAt, NSE_REFRESH_MS, nseMarketWindow, now),
        angelOne: calendarBlocked
          ? new Date(Math.max(now, holidayCalendarRetryAt)).toISOString()
          : nextFetchTime(lastAngelAttemptAt, ANGEL_REFRESH_MS, angelMarketWindow, now),
        nseOpen: nseMarketWindow.isOpen,
        angelOneOpen: angelMarketWindow.isOpen
      },
      indices: indices,
      groups: grouped,
      trackedSymbolCount: trackedSymbols.length,
      unlistedSymbols: unlistedSymbols,
      sources: { nse: indexStatus, angelOne: angelStatus }
    };
    return currentSnapshot;
  }

  function startRefresh(force, allowOutsideMarketHours) {
    let tracked;
    tracked = performRefresh(Boolean(force), Boolean(allowOutsideMarketHours)).finally(function () {
      if (refreshPromise === tracked) refreshPromise = null;
    });
    refreshPromise = tracked;
    return tracked;
  }

  return {
    async refresh(force, allowOutsideMarketHours) {
      if (refreshPromise) {
        if (force) {
          forceRefreshQueued = true;
          forceRefreshQueuedOutsideMarketHours = forceRefreshQueuedOutsideMarketHours || Boolean(allowOutsideMarketHours);
        }
        const active = refreshPromise;
        const result = await active;
        if (forceRefreshQueued && !refreshPromise) {
          const queuedOutsideMarketHours = forceRefreshQueuedOutsideMarketHours;
          forceRefreshQueued = false;
          forceRefreshQueuedOutsideMarketHours = false;
          return startRefresh(true, queuedOutsideMarketHours);
        }
        return result;
      }
      return startRefresh(force, allowOutsideMarketHours);
    },
    getSnapshot() {
      return currentSnapshot;
    },
    resetAngel() {
      angelGeneration += 1;
      lastAngelAttemptAt = 0;
      currentSnapshot = null;
      const authenticated = Boolean(angelSession && angelSession.status().authenticated);
      angelCache = {
        quotes: [], symbols: [], missingInstruments: [], failedBatchCount: 0,
        sourceTime: null,
        status: sourceResult(false, "offline", authenticated ? "Signed in · tap Refresh now to fetch quotes" : "Sign in to Angel One", null)
      };
    }
  };
}

