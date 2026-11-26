import { gunzipSync } from "node:zlib";

const MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
const QUOTE_URL = "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";
const REQUEST_TIMEOUT_MS = 12000;
const SYMBOLS_PER_REQUEST = 25;
const MIN_REQUEST_GAP_MS = 1100;
let masterCache = null;
let masterCacheAt = 0;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
}

function parseExpiry(value) {
  if (!value) return null;
  const text = String(value).trim().toUpperCase();
  const match = text.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (match) {
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    if (months[match[2]] === undefined) return null;
    return Date.UTC(Number(match[3]), months[match[2]], Number(match[1]));
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function todayInIndiaUtc() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(function (part) { return [part.type, part.value]; }));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
}

async function fetchJson(url, options, angelSession) {
  const response = await angelSession.request(url, options);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Angel One returned a response that was not JSON.");
  }
  if (!response.ok) {
    throw new Error("Angel One quote request failed with HTTP " + response.status + ".");
  }
  return json;
}

async function getInstrumentMaster() {
  if (masterCache && Date.now() - masterCacheAt < 12 * 60 * 60 * 1000) return masterCache;
  const response = await fetch(MASTER_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("Could not download the Angel One instrument list.");
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Angel One instrument list could not be read.");
  }
  if (!Array.isArray(parsed)) throw new Error("Angel One instrument list has an unexpected format.");
  masterCache = parsed;
  masterCacheAt = Date.now();
  return masterCache;
}

function buildInstrumentMaps(master) {
  const today = todayInIndiaUtc();
  const cashBySymbol = new Map();
  const futuresBySymbol = new Map();
  for (const item of master) {
    const exchange = String(item.exch_seg || "").toUpperCase();
    const symbol = String(item.symbol || "").toUpperCase();
    const name = String(item.name || "").toUpperCase();
    if (exchange === "NSE" && symbol.endsWith("-EQ")) {
      cashBySymbol.set(symbol.slice(0, -3), item);
    }
    const expiry = parseExpiry(item.expiry);
    if (exchange === "NFO"
        && String(item.instrumenttype || "").toUpperCase() === "FUTSTK"
        && expiry !== null
        && expiry >= today
        && name) {
      const list = futuresBySymbol.get(name) || [];
      list.push(item);
      futuresBySymbol.set(name, list);
    }
  }
  for (const list of futuresBySymbol.values()) {
    list.sort(function (left, right) { return parseExpiry(left.expiry) - parseExpiry(right.expiry); });
  }
  return { cashBySymbol: cashBySymbol, futuresBySymbol: futuresBySymbol };
}

function makeResolvedInstruments(maps, symbols) {
  const instruments = [];
  const missing = [];
  for (const rawSymbol of symbols) {
    const symbol = String(rawSymbol).trim().toUpperCase();
    if (!symbol) continue;
    const cash = maps.cashBySymbol.get(symbol);
    const futureList = maps.futuresBySymbol.get(symbol) || [];
    const future = futureList[0];
    if (!cash || !future) {
      missing.push(symbol + ((!cash && !future) ? " (cash and future not found)" : !cash ? " (cash scrip not found)" : " (future contract not found)"));
      continue;
    }
    instruments.push({
      symbol: symbol,
      cashToken: String(cash.token),
      cashTradingSymbol: String(cash.symbol),
      futureToken: String(future.token),
      futureTradingSymbol: String(future.symbol),
      futureExpiry: String(future.expiry)
    });
  }
  return { instruments: instruments, missing: missing };
}

function quoteList(payload) {
  const data = payload && payload.data;
  if (data && Array.isArray(data.fetched)) return data.fetched;
  if (Array.isArray(data)) return data;
  return [];
}

function quantityTotals(quote) {
  const depth = quote && quote.depth ? quote.depth : {};
  const bidRows = Array.isArray(depth.buy) ? depth.buy.slice(0, 5) : [];
  const askRows = Array.isArray(depth.sell) ? depth.sell.slice(0, 5) : [];
  if (!bidRows.length || !askRows.length) return null;
  const bidQty = bidRows.reduce(function (sum, row) { return sum + (numberOrNull(row.quantity) || 0); }, 0);
  const askQty = askRows.reduce(function (sum, row) { return sum + (numberOrNull(row.quantity) || 0); }, 0);
  return { bidQty: bidQty, askQty: askQty, netQty: bidQty - askQty, bidLevels: bidRows.length, askLevels: askRows.length };
}

function wait(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

async function fetchQuoteBatch(instruments, angelSession) {
  const exchangeTokens = {
    NSE: instruments.map(function (item) { return item.cashToken; }),
    NFO: instruments.map(function (item) { return item.futureToken; })
  };
  return await fetchJson(QUOTE_URL, {
    method: "POST",
    body: JSON.stringify({ mode: "FULL", exchangeTokens: exchangeTokens })
  }, angelSession);
}

export async function loadAngelOneQuotes(watchlistConfig, angelSession) {
  if (!angelSession || !angelSession.status().authenticated) throw new Error("Sign in to Angel One to load order-book data.");

  const master = await getInstrumentMaster();
  const maps = buildInstrumentMaps(master);
  let requestedSymbols;
  if (watchlistConfig.mode === "all_nse_fo_stocks") {
    requestedSymbols = Array.from(maps.futuresBySymbol.keys())
      .filter(function (symbol) { return maps.cashBySymbol.has(symbol); })
      .sort();
  } else {
    requestedSymbols = (watchlistConfig.symbols || []).map(function (symbol) { return String(symbol).toUpperCase(); });
  }

  const resolved = makeResolvedInstruments(maps, requestedSymbols);
  if (!resolved.instruments.length) {
    throw new Error("No watchlist stocks with both cash and current futures contracts were found.");
  }

  const quoteByToken = new Map();
  const failedBatchSymbols = [];
  let successfulBatches = 0;
  const batches = [];
  for (let index = 0; index < resolved.instruments.length; index += SYMBOLS_PER_REQUEST) {
    batches.push(resolved.instruments.slice(index, index + SYMBOLS_PER_REQUEST));
  }

  for (let index = 0; index < batches.length; index += 1) {
    if (index > 0) await wait(MIN_REQUEST_GAP_MS);
    const batch = batches[index];
    try {
      const payload = await fetchQuoteBatch(batch, angelSession);
      if (payload.status === false || payload.success === false) {
        throw new Error("Angel One did not return a successful market-data response.");
      }
      for (const quote of quoteList(payload)) {
        const token = String(quote.symbolToken || quote.symboltoken || "");
        if (token) quoteByToken.set(token, quote);
      }
      successfulBatches += 1;
    } catch {
      failedBatchSymbols.push(...batch.map(function (item) { return item.symbol; }));
    }
  }

  if (!successfulBatches || !quoteByToken.size) {
    throw new Error("Angel One returned no quote data. Check the API session and local settings.");
  }

  const quotes = [];
  const failedSet = new Set(failedBatchSymbols);
  for (const instrument of resolved.instruments) {
    const cash = quoteByToken.get(instrument.cashToken);
    const future = quoteByToken.get(instrument.futureToken);
    if (!cash || !future) {
      const failedBatch = failedSet.has(instrument.symbol);
      quotes.push({
        symbol: instrument.symbol,
        unavailableReason: failedBatch ? "Quote batch failed" : !cash && !future ? "Cash and futures quote missing" : !cash ? "Cash quote missing" : "Futures quote missing"
      });
      continue;
    }
    const cashDepth = quantityTotals(cash);
    const futuresDepth = quantityTotals(future);
    if (!cashDepth || !futuresDepth) {
      quotes.push({ symbol: instrument.symbol, unavailableReason: "Five-level depth is missing for cash or futures" });
      continue;
    }
    quotes.push({
      symbol: instrument.symbol,
      price: numberOrNull(cash.ltp),
      close: numberOrNull(cash.close),
      percentChange: numberOrNull(cash.percentChange),
      cash: cashDepth,
      futures: futuresDepth,
      futureContract: instrument.futureTradingSymbol,
      futureExpiry: instrument.futureExpiry,
      sourceTime: cash.exchFeedTime || cash.exchTradeTime || null
    });
  }

  const quoteTimes = quotes.map(function (quote) { return quote.sourceTime; }).filter(Boolean);
  return {
    quotes: quotes,
    symbols: requestedSymbols,
    missingInstruments: resolved.missing,
    failedBatchCount: batches.length - successfulBatches,
    sourceTime: quoteTimes[0] || new Date().toISOString()
  };
}

