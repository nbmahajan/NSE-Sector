const NSE_INDEX_API = "https://www.nseindia.in/api/NextApi/apiClient/marketWatchApi?functionName=";
const NSE_HOLIDAY_API = "https://www.nseindia.com/api/holiday-master?type=trading&year=";
const REQUEST_TIMEOUT_MS = 20000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const NSE_HOLIDAY_REFERER = "https://www.nseindia.com/resources/exchange-communication-holidays";
const NSE_INDEX_CACHE_MS = 5 * 60 * 1000;
let holidayCache = null;
let holidayCacheAt = 0;
let holidayRequest = null;
let sectorIndexCache = null;
let sectorIndexCacheKey = "";
let sectorIndexCacheAt = 0;
let sectorIndexRequest = null;

function normalizeName(value) {
  return String(value || "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^nifty\s+(\d)/, "nifty$1")
    .replace(/\s+/g, " ");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeNseTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (match) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[match[2].toLowerCase()];
    if (month !== undefined) {
      let hour = Number(match[4] || 0);
      if (match[7]) hour = (hour % 12) + (match[7].toLowerCase() === "pm" ? 12 : 0);
      const istAsUtc = Date.UTC(Number(match[3]), month, Number(match[1]), hour, Number(match[5] || 0), Number(match[6] || 0));
      return new Date(istAsUtc - IST_OFFSET_MS).toISOString();
    }
  }

  // NSE may provide an ISO-like timestamp without a timezone suffix. Treat that
  // wall-clock value as IST instead of letting Render's UTC timezone reinterpret it.
  const localIsoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/);
  if (localIsoMatch) {
    const year = Number(localIsoMatch[1]);
    const month = Number(localIsoMatch[2]) - 1;
    const day = Number(localIsoMatch[3]);
    const hour = Number(localIsoMatch[4]);
    const minute = Number(localIsoMatch[5]);
    const second = Number(localIsoMatch[6] || 0);
    const millisecond = Number(((localIsoMatch[7] || "") + "000").slice(0, 3));
    const istAsUtc = Date.UTC(year, month, day, hour, minute, second, millisecond);
    const check = new Date(istAsUtc);
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day
        && hour <= 23 && minute <= 59 && second <= 59) {
      return new Date(istAsUtc - IST_OFFSET_MS).toISOString();
    }
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}

async function getNseJson(url, referer) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36",
        Referer: referer || "https://www.nseindia.in/market-data/live-market-indices"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error("Could not reach the NSE market indices source: " + (error.message || "network error"));
  }
  if (!response.ok) throw new Error("NSE market indices source returned HTTP " + response.status + ".");
  try {
    return await response.json();
  } catch {
    throw new Error("NSE market indices source returned an unreadable response.");
  }
}

function holidayDateKey(value) {
  const text = String(value || "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3];
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const month = months[match[2].toLowerCase()];
  return month ? match[3] + "-" + month + "-" + String(Number(match[1])).padStart(2, "0") : null;
}

export async function loadNseTradingHolidays(year) {
  const yearNumber = Number(year);
  const now = Date.now();
  if (holidayCache && holidayCache.year === yearNumber && now - holidayCacheAt < 12 * 60 * 60 * 1000) return holidayCache;
  if (holidayRequest) return holidayRequest;

  holidayRequest = (async function () {
    const payload = await getNseJson(NSE_HOLIDAY_API + encodeURIComponent(String(yearNumber)), NSE_HOLIDAY_REFERER);
    function segmentDates(name) {
      if (!Array.isArray(payload && payload[name])) throw new Error("NSE returned an unreadable " + name + " holiday list.");
      return new Set(payload[name].map(function (item) { return holidayDateKey(item && item.tradingDate); }).filter(Boolean));
    }
    const calendar = { year: yearNumber, CM: segmentDates("CM"), FO: segmentDates("FO") };
    if (!calendar.CM.size || !calendar.FO.size) throw new Error("NSE returned an empty trading holiday list.");
    holidayCache = calendar;
    holidayCacheAt = Date.now();
    return holidayCache;
  })().finally(function () { holidayRequest = null; });

  return holidayRequest;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async function () {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function indexRowFrom(rows, name, symbol) {
  const expected = new Set([normalizeName(name), normalizeName(symbol)]);
  return rows.find(function (row) { return expected.has(normalizeName(row && row.symbol)); }) || rows[0] || null;
}

async function fetchNseIndices(allowedNames) {
  const configuredNames = Array.isArray(allowedNames) ? allowedNames : [];
  const namesByNormalized = new Map(configuredNames.map(function (name) { return [normalizeName(name), name]; }));
  const listing = await getNseJson(NSE_INDEX_API + "getIndexList");
  const sourceIndexes = listing && listing.data && listing.data["Sectoral Market Indices"];
  if (!sourceIndexes || typeof sourceIndexes !== "object" || Array.isArray(sourceIndexes)) {
    throw new Error("NSE did not return its sectoral index list.");
  }

  const entries = Object.entries(sourceIndexes).filter(function ([name]) {
    return namesByNormalized.has(normalizeName(name));
  });
  if (!entries.length) throw new Error("NSE index names did not match the configured sector list.");

  const fetchedAt = new Date().toISOString();
  const loaded = await mapLimit(entries, 8, async function ([sourceName, sourceSymbol]) {
    try {
      const symbol = String(sourceSymbol || sourceName);
      const url = NSE_INDEX_API + "getIndicesData&symbol=" + encodeURIComponent(symbol);
      const payload = await getNseJson(url);
      const rows = payload && payload.data && Array.isArray(payload.data.data) ? payload.data.data : [];
      const indexRow = indexRowFrom(rows, sourceName, symbol);
      if (!indexRow) return { error: "NSE returned no quote for " + sourceName + "." };

      const name = namesByNormalized.get(normalizeName(sourceName));
      const sourceTime = normalizeNseTime(indexRow.lastUpdateTime);
      return {
        row: {
          name: name,
          symbol: symbol,
          value: numberOrNull(indexRow.last),
          open: numberOrNull(indexRow.open),
          high: numberOrNull(indexRow.high),
          low: numberOrNull(indexRow.low),
          close: numberOrNull(indexRow.previousClose ?? indexRow.close),
          pointsChange: numberOrNull(indexRow.change),
          percentChange: numberOrNull(indexRow.pChange),
          sourceTime: sourceTime,
          fetchedAt: fetchedAt
        }
      };
    } catch (error) {
      return { error: error.message || "NSE index request failed." };
    }
  });

  const byName = new Map();
  const errors = [];
  for (const item of loaded) {
    if (item && item.row) byName.set(normalizeName(item.row.name), item.row);
    else if (item && item.error) errors.push(item.error);
  }
  const available = Array.from(byName.values());
  if (!available.some(function (item) { return item.percentChange !== null; })) {
    throw new Error(errors[0] || "NSE returned no sector index percentage changes.");
  }

  const indices = configuredNames.map(function (name) {
    return byName.get(normalizeName(name)) || {
      name: name,
      value: null,
      open: null,
      high: null,
      low: null,
      close: null,
      pointsChange: null,
      percentChange: null,
      sourceTime: null,
      fetchedAt: fetchedAt,
      unavailable: true
    };
  });
  const sourceTimes = available.map(function (item) { return item.sourceTime; }).filter(Boolean);
  const latestSourceTime = sourceTimes.sort(function (a, b) { return new Date(b).getTime() - new Date(a).getTime(); })[0] || fetchedAt;
  return { indices: indices, sourceTime: latestSourceTime, fetchedAt: fetchedAt };
}

export async function loadNseIndices(allowedNames, force) {
  const configuredNames = Array.isArray(allowedNames) ? allowedNames : [];
  const cacheKey = JSON.stringify(configuredNames);
  if (!force && sectorIndexCache && sectorIndexCacheKey === cacheKey && Date.now() - sectorIndexCacheAt < NSE_INDEX_CACHE_MS) {
    return sectorIndexCache;
  }
  if (sectorIndexRequest && sectorIndexRequest.cacheKey === cacheKey) return sectorIndexRequest.promise;

  let promise;
  promise = fetchNseIndices(configuredNames).then(function (result) {
    sectorIndexCache = result;
    sectorIndexCacheKey = cacheKey;
    sectorIndexCacheAt = Date.now();
    return result;
  }).finally(function () {
    if (sectorIndexRequest && sectorIndexRequest.promise === promise) sectorIndexRequest = null;
  });
  sectorIndexRequest = { cacheKey: cacheKey, promise: promise };
  return promise;
}
