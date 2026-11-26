const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
let currentSnapshot = null;
let pollTimer = null;
const CONSTITUENT_CACHE_KEY = "nse-dashboard-sector-constituents-v1";
const CONSTITUENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let sectorConstituents = {};
let constituentRefreshTime = null;
let constituentStatus = "Loading official NSE Indices constituent lists…";
let selectedIndexName = null;
let constituentRefreshPromise = null;
const tableSorts = {
  green: { key: "symbol", ascending: true },
  red: { key: "symbol", ascending: true },
  white: { key: "symbol", ascending: true }
};
let previouslyAuthenticated = false;

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Number.isFinite(Number(value))) return "—";
  return "₹" + money.format(Number(value));
}

function formatPct(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const sign = number > 0 ? "+" : number < 0 ? "−" : "";
  return sign + Math.abs(number).toFixed(2) + "%";
}

function formatQty(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Number.isFinite(Number(value))) return "—";
  return quantity.format(Number(value));
}

function formatPoints(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const sign = number > 0 ? "+" : number < 0 ? "−" : "";
  return sign + money.format(Math.abs(number));
}

function formatTimestamp(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric"
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(date);
}

function formatTileTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "Not available";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(function (part) { return [part.type, part.value]; }));
  return values.year + "-" + values.month + "-" + values.day + " " + values.hour + ":" + values.minute + " IST";
}

function sourceLabel(source) {
  if (!source) return "Not connected";
  const label = source.message || "Not connected";
  return source.sourceTime ? label + " · " + formatTimestamp(source.sourceTime) : label;
}

function updateSource(id, source) {
  const node = byId(id);
  if (!node) return;
  node.textContent = sourceLabel(source);
  const isHealthy = Boolean(source && source.ok && ["live", "partial", "snapshot"].includes(source.state));
  node.classList.toggle("ok", isHealthy);
  node.classList.toggle("bad", !isHealthy);
}

function getAllRows(groups) {
  return ["green", "red", "white", "unavailable"].flatMap(function (key) {
    return Array.isArray(groups && groups[key]) ? groups[key] : [];
  });
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some(function (value) { return value.trim(); })) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  record.push(field);
  if (record.some(function (value) { return value.trim(); })) records.push(record);
  return records;
}

function symbolsFromConstituentCsv(text) {
  const records = parseCsv(String(text).replace(/^\uFEFF/, ""));
  if (!records.length) throw new Error("The constituent file was empty.");
  const header = records[0].map(function (value) { return value.trim().toLowerCase(); });
  const symbolColumn = header.indexOf("symbol");
  const seriesColumn = header.indexOf("series");
  if (symbolColumn < 0) throw new Error("The constituent file did not contain a Symbol column.");
  const symbols = records.slice(1).map(function (row) {
    if (seriesColumn >= 0 && String(row[seriesColumn] || "").trim().toUpperCase() !== "EQ") return null;
    return normalizeSymbol(row[symbolColumn]);
  }).filter(Boolean);
  if (!symbols.length) throw new Error("The constituent file did not contain any equity symbols.");
  return Array.from(new Set(symbols));
}

function loadConstituentCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONSTITUENT_CACHE_KEY) || "null");
    if (saved && saved.sectors && typeof saved.sectors === "object") {
      const savedTime = new Date(saved.checkedAt || 0).getTime();
      const bundledTime = new Date(constituentRefreshTime || 0).getTime();
      if (savedTime >= bundledTime && savedTime > 0) {
        sectorConstituents = saved.sectors;
        constituentRefreshTime = saved.checkedAt || null;
        return Date.now() - savedTime < CONSTITUENT_MAX_AGE_MS;
      }
    }
  } catch {}
  return false;
}

async function loadBundledConstituents() {
  try {
    const response = await fetch("/sector-members.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("The saved sector lists could not be loaded.");
    const saved = await response.json();
    if (!saved || !saved.sectors || typeof saved.sectors !== "object") throw new Error("The saved sector lists are unreadable.");
    sectorConstituents = saved.sectors;
    constituentRefreshTime = saved.checkedAt || null;
    constituentStatus = "Saved NSE Indices lists loaded · fetched " + formatTileTimestamp(constituentRefreshTime) + " · list date is the previous month’s last trading day.";
  } catch {
    constituentStatus = "Loading the official NSE Indices constituent lists…";
  }
  if (currentSnapshot) render(currentSnapshot);
}

async function refreshConstituents() {
  if (constituentRefreshPromise) return constituentRefreshPromise;
  constituentRefreshPromise = (async function () {
    let cacheIsFresh = false;
    try {
      cacheIsFresh = loadConstituentCache();
      if (cacheIsFresh) {
        constituentStatus = "Official NSE Indices lists checked " + formatTileTimestamp(constituentRefreshTime) + " · list date is the previous month’s last trading day.";
        if (currentSnapshot) render(currentSnapshot);
        return;
      }

      const mapResponse = await fetch("/index-constituents.json", { cache: "no-cache" });
      if (!mapResponse.ok) throw new Error("The local index list could not be loaded.");
      const urls = await mapResponse.json();
      const entries = Object.entries(urls);
      const updated = { ...sectorConstituents };
      const failures = [];
      let cursor = 0;
      async function worker() {
        while (cursor < entries.length) {
          const entry = entries[cursor];
          cursor += 1;
          const name = entry[0];
          try {
            const response = await fetch(entry[1], { cache: "no-store", signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const symbols = symbolsFromConstituentCsv(await response.text());
            updated[name] = { symbols: symbols, fetchedAt: new Date().toISOString() };
          } catch {
            failures.push(name);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
      sectorConstituents = updated;
      const checkedAt = new Date().toISOString();
      if (!failures.length) constituentRefreshTime = checkedAt;
      constituentStatus = failures.length
        ? "Some NSE Indices lists could not be refreshed; available saved lists are still usable."
        : "Official NSE Indices lists fetched " + formatTileTimestamp(checkedAt) + " · the published list is as of the previous month’s last trading day.";
      try {
        localStorage.setItem(CONSTITUENT_CACHE_KEY, JSON.stringify({ sectors: sectorConstituents, checkedAt: failures.length ? constituentRefreshTime : checkedAt }));
      } catch {}
      if (currentSnapshot) render(currentSnapshot);
    } catch (error) {
      constituentStatus = Object.keys(sectorConstituents).length
        ? "Could not reach NSE Indices; using the saved constituent lists."
        : "NSE Indices constituent lists are unavailable; sector filtering is disabled until they load.";
      if (currentSnapshot) render(currentSnapshot);
    }
  })().finally(function () { constituentRefreshPromise = null; });
  return constituentRefreshPromise;
}

function renderIndices(indices) {
  const grid = byId("sector-grid");
  const count = byId("metric-index-total");
  const sideCount = byId("sector-count");
  const term = byId("index-search").value.trim().toLowerCase();
  const sort = byId("index-sort").value;
  const allRows = Array.isArray(indices) ? indices.slice() : [];
  const availableCount = allRows.filter(function (item) {
    return item.percentChange !== null && item.percentChange !== undefined && Number.isFinite(Number(item.percentChange));
  }).length;
  let rows = allRows.filter(function (item) { return String(item.name || "").toLowerCase().includes(term); });
  rows.sort(function (left, right) {
    const leftChange = Number(left.percentChange);
    const rightChange = Number(right.percentChange);
    const leftHasChange = left.percentChange !== null && left.percentChange !== undefined && Number.isFinite(leftChange);
    const rightHasChange = right.percentChange !== null && right.percentChange !== undefined && Number.isFinite(rightChange);
    if (leftHasChange !== rightHasChange) return leftHasChange ? -1 : 1;
    if (sort === "change_desc" && leftHasChange) return rightChange - leftChange;
    if (sort === "change_asc" && leftHasChange) return leftChange - rightChange;
    return String(left.name).localeCompare(String(right.name));
  });
  count.textContent = String(allRows.length);
  sideCount.textContent = term
    ? rows.length + " shown · " + allRows.length + " tiles"
    : availableCount + " with NSE data · " + allRows.length + " tiles";
  if (!rows.length) {
    grid.innerHTML = '<div class="empty-state">' + (allRows.length ? "No indices match this search." : "No NSE index data is available. Check the NSE source status above.") + "</div>";
    return;
  }
  grid.innerHTML = rows.map(function (item) {
    const hasData = item.percentChange !== null && item.percentChange !== undefined && Number.isFinite(Number(item.percentChange));
    const change = Number(item.percentChange);
    const trendClass = !hasData ? "no-snapshot" : change > 0 ? "sector-up" : change < 0 ? "sector-down" : "sector-flat";
    const value = hasData && item.value !== null && item.value !== undefined
      ? '<span class="sector-level">' + escapeHtml(formatPrice(item.value)) + "</span>"
      : '<span class="sector-level">' + (hasData ? "" : "No snapshot") + "</span>";
    const updatedAt = formatTileTimestamp(item.sourceTime || item.fetchedAt);
    const constituentData = sectorConstituents[item.name];
    const memberSymbols = constituentData && Array.isArray(constituentData.symbols) ? constituentData.symbols : null;
    const isSelected = selectedIndexName === item.name;
    const memberSet = memberSymbols ? new Set(memberSymbols.map(normalizeSymbol)) : null;
    const analysed = currentSnapshot && memberSet
      ? new Set(["green", "red", "white"].flatMap(function (key) {
        return (currentSnapshot.groups && currentSnapshot.groups[key] || [])
          .filter(function (row) { return memberSet.has(normalizeSymbol(row.symbol)); })
          .map(function (row) { return normalizeSymbol(row.symbol); });
      })).size
      : 0;
    const memberNote = memberSymbols
      ? escapeHtml(analysed + " analysed · " + memberSymbols.length + " NSE members")
      : "Constituent list unavailable";
    return '<div class="sector-tile-wrap"><button class="sector-card index-tile ' + trendClass + (isSelected ? " selected" : "") + '" type="button" data-index="' + escapeHtml(item.name) + '" aria-pressed="' + String(isSelected) + '" title="Select to filter the tables to this index"><span class="sector-name">' + escapeHtml(item.name) + '</span><span class="sector-line"><strong class="sector-change">' + escapeHtml(formatPct(item.percentChange)) + "</strong>" + value + '</span><span class="sector-updated">NSE updated ' + escapeHtml(updatedAt) + '</span><span class="sector-members">' + memberNote + '</span></button><button class="index-detail-trigger" type="button" data-index="' + escapeHtml(item.name) + '" aria-label="View ' + escapeHtml(item.name) + ' details">Details</button></div>';
  }).join("");
  grid.querySelectorAll(".index-tile").forEach(function (tile, index) {
    tile.addEventListener("click", function () {
      const selectedName = rows[index].name;
      if (!Array.isArray(sectorConstituents[selectedName] && sectorConstituents[selectedName].symbols)) {
        constituentStatus = "The " + selectedName + " constituent list is still loading; the tables have not been filtered yet.";
        byId("sector-source-status").textContent = constituentStatus;
        return;
      }
      selectedIndexName = selectedIndexName === selectedName ? null : selectedName;
      if (currentSnapshot) render(currentSnapshot);
      byId("book-heading").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  grid.querySelectorAll(".index-detail-trigger").forEach(function (button) {
    button.addEventListener("click", function () {
      const item = rows.find(function (candidate) { return candidate.name === button.dataset.index; });
      showIndexDetails(item);
    });
  });
  const sourceNote = byId("sector-source-status");
  sourceNote.textContent = constituentStatus;
}

function showIndexDetails(item) {
  if (!item) return;
  byId("index-detail-title").textContent = item.name;
  const hasData = item.percentChange !== null && item.percentChange !== undefined && Number.isFinite(Number(item.percentChange));
  const entries = hasData
    ? [
      ["Open", formatPrice(item.open)],
      ["High", formatPrice(item.high)],
      ["Low", formatPrice(item.low)],
      ["Close", formatPrice(item.close ?? item.value)],
      ["Points change", formatPoints(item.pointsChange)],
      ["Change", formatPct(item.percentChange)],
      ["NSE index updated", formatTimestamp(item.sourceTime)],
      ["Fetched by dashboard", formatTimestamp(item.fetchedAt)]
    ]
    : [["NSE index data", "No value was included for this index."]];
  byId("index-detail-body").innerHTML = entries.map(function (entry) {
    return '<div class="index-detail-item"><span>' + escapeHtml(entry[0]) + '</span><strong>' + escapeHtml(entry[1]) + "</strong></div>";
  }).join("");
  byId("index-detail-backdrop").hidden = false;
  byId("index-detail-close").focus();
}

function closeIndexDetails() {
  byId("index-detail-backdrop").hidden = true;
}

function depthMarkup(depth) {
  if (!depth) return '<div class="depth-lines"><span class="depth-line">Buy <strong>—</strong></span><span class="depth-line">Sell <strong>—</strong></span></div><span class="net zero">Net —</span>';
  const net = Number(depth.netQty);
  const className = net > 0 ? "pos" : net < 0 ? "neg" : "zero";
  const sign = net > 0 ? "+" : net < 0 ? "−" : "";
  return '<div class="depth-lines"><span class="depth-line">Buy <strong>' + escapeHtml(formatQty(depth.bidQty)) + '</strong></span><span class="depth-line">Sell <strong>' + escapeHtml(formatQty(depth.askQty)) + '</strong></span></div><span class="net ' + className + '">Net ' + sign + escapeHtml(formatQty(Math.abs(net))) + "</span>";
}

function rowMarkup(item) {
  const symbol = escapeHtml(item.symbol);
  const price = formatPrice(item.price);
  const contractText = [item.futureContract, item.futureExpiry].filter(Boolean).join(" · ");
  const contract = contractText ? '<span class="future-name">' + escapeHtml(contractText) + "</span>" : "";
  const hint = item.bucket === "white" ? '<span class="class-hint">mixed / flat</span>' : "";
  return '<article class="quote-row" role="row">'
    + '<div class="cell symbol-cell" role="cell"><span class="mobile-label">Symbol</span><span class="ticker">' + symbol + "</span>" + hint + "</div>"
    + '<div class="cell price-cell" role="cell"><span class="mobile-label">LTP / day change</span><span class="price-value">' + escapeHtml(price) + '</span><span class="price-change">' + escapeHtml(formatPct(item.percentChange)) + "</span></div>"
    + '<div class="cell cash-cell" role="cell"><span class="mobile-label">Cash · five levels</span>' + depthMarkup(item.cash) + "</div>"
    + '<div class="cell future-cell" role="cell"><span class="mobile-label">Nearest future · five levels</span>' + depthMarkup(item.futures) + contract + "</div>"
    + "</article>";
}

function sortRows(rows, sort) {
  const sorted = rows.slice();
  const key = sort.key;
  const direction = sort.ascending ? 1 : -1;
  if (key === "symbol") {
    sorted.sort(function (a, b) { return direction * String(a.symbol).localeCompare(String(b.symbol)); });
  } else {
    const valueFor = function (item) {
      if (key === "cash_net") return Number(item.cash && item.cash.netQty);
      if (key === "future_net") return Number(item.futures && item.futures.netQty);
      return Number(item.percentChange);
    };
    sorted.sort(function (a, b) {
      const left = valueFor(a);
      const right = valueFor(b);
      const leftValid = Number.isFinite(left);
      const rightValid = Number.isFinite(right);
      if (!leftValid && !rightValid) return String(a.symbol).localeCompare(String(b.symbol));
      if (!leftValid) return 1;
      if (!rightValid) return -1;
      return direction * (left - right);
    });
  }
  return sorted;
}

function matchesSign(value, filter) {
  if (filter === "all") return true;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return false;
  const number = Number(value);
  if (filter === "positive") return number > 0;
  if (filter === "negative") return number < 0;
  return number === 0;
}

function matchesPrice(value) {
  const minText = byId("price-min").value.trim();
  const maxText = byId("price-max").value.trim();
  if (!minText && !maxText) return true;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return false;
  const price = Number(value);
  if (minText && price < Number(minText)) return false;
  if (maxText && price > Number(maxText)) return false;
  return true;
}

function hasCustomDashboardView() {
  const tableSortChanged = ["green", "red", "white"].some(function (key) {
    return tableSorts[key].key !== "symbol" || !tableSorts[key].ascending;
  });
  return Boolean(selectedIndexName)
    || Boolean(byId("index-search").value.trim())
    || byId("index-sort").value !== "change_desc"
    || Boolean(byId("symbol-search").value.trim())
    || Boolean(byId("price-min").value.trim())
    || Boolean(byId("price-max").value.trim())
    || byId("group-filter").value !== "all"
    || byId("change-filter").value !== "all"
    || byId("cash-filter").value !== "all"
    || byId("future-filter").value !== "all"
    || tableSortChanged;
}

function updateSortHeaders() {
  document.querySelectorAll(".sort-header").forEach(function (button) {
    const bucket = button.closest(".bucket").dataset.bucket;
    const sort = tableSorts[bucket];
    const selected = button.dataset.sort === sort.key;
    button.dataset.arrow = selected ? (sort.ascending ? "↑" : "↓") : "";
    button.setAttribute("aria-sort", selected ? (sort.ascending ? "ascending" : "descending") : "none");
    button.setAttribute("aria-label", button.textContent.trim() + (selected ? (sort.ascending ? ", sorted ascending" : ", sorted descending") : ", sort"));
  });
  document.querySelectorAll(".bucket-sort").forEach(function (select) {
    select.value = tableSorts[select.dataset.bucketSort].key;
  });
}

function renderGroup(name, allItems, visibleItems, sectorName) {
  byId(name + "-count").textContent = String(visibleItems.length);
  const target = byId(name + "-rows");
  if (!visibleItems.length) {
    const message = allItems.length
      ? "No symbols match the current filters."
      : sectorName
        ? "No tracked F&O symbols from " + escapeHtml(sectorName) + " are in this group."
        : "No symbols in this group yet.";
    target.innerHTML = '<div class="empty-state">' + message + "</div>";
    return;
  }
  target.innerHTML = visibleItems.map(rowMarkup).join("");
}

function renderUnavailable(rows, unlistedSymbols) {
  const target = byId("unavailable");
  const names = rows.map(function (item) {
    return escapeHtml(item.symbol) + (item.unavailableReason ? " (" + escapeHtml(item.unavailableReason) + ")" : "");
  });
  const unlisted = Array.isArray(unlistedSymbols) ? unlistedSymbols.map(escapeHtml) : [];
  const all = names.concat(unlisted);
  if (!all.length) {
    target.hidden = true;
    target.textContent = "";
    return;
  }
  target.hidden = false;
  target.innerHTML = "<strong>Not classified:</strong> " + all.join(", ");
}

function updateMetrics(snapshot, allRows) {
  const indices = Array.isArray(snapshot.indices) ? snapshot.indices : [];
  const availableIndices = indices.filter(function (item) {
    return item.percentChange !== null && item.percentChange !== undefined && Number.isFinite(Number(item.percentChange));
  });
  const up = availableIndices.filter(function (item) { return Number(item.percentChange) > 0; }).length;
  const down = availableIndices.filter(function (item) { return Number(item.percentChange) < 0; }).length;
  const flat = availableIndices.length - up - down;
  const groups = snapshot.groups || {};
  const green = (groups.green || []).length;
  const red = (groups.red || []).length;
  const white = (groups.white || []).length;
  const unavailable = (groups.unavailable || []).length;

  byId("metric-index-breadth").textContent = availableIndices.length ? up + " / " + down + " / " + flat : "—";
  byId("metric-index-detail").textContent = availableIndices.length
    ? "Up · Down · Flat · " + (indices.length - availableIndices.length) + " missing"
    : "No index changes available";
  byId("metric-index-source").textContent = availableIndices.length + " of " + indices.length + " tiles · NSE site";
  byId("metric-symbol-total").textContent = String(snapshot.trackedSymbolCount || allRows.length);
  byId("metric-groups").textContent = "G " + green + " · R " + red + " · W " + white;
  byId("metric-group-detail").textContent = "Unavailable " + unavailable;
  byId("universe-label").textContent = snapshot.universe || "Configured stock universe";
}

function updateNotice(snapshot) {
  const notice = byId("notice");
  const message = notice.querySelector("span:last-child");
  const nse = snapshot.sources && snapshot.sources.nse;
  const angel = snapshot.sources && snapshot.sources.angelOne;
  if (snapshot.mode === "demo") {
    notice.dataset.state = "demo";
    message.textContent = "Demo mode was selected in the local settings. Displayed values are samples.";
  } else if (nse && nse.ok && angel && angel.ok) {
    notice.dataset.state = "live";
    message.textContent = "NSE index tiles refresh every five minutes. Angel One order books continue to refresh every minute.";
  } else {
    notice.dataset.state = "error";
    const problems = [];
    if (!nse || !nse.ok) problems.push("NSE: " + (nse && nse.message || "market indices data unavailable"));
    if (!angel || !angel.ok) problems.push("Angel One: " + (angel && angel.message || "sign in locally"));
    message.textContent = problems.join(" · ") + ". See README for setup.";
  }
}

function render(snapshot) {
  if (!snapshot || snapshot.loading) return;
  currentSnapshot = snapshot;
  const mode = byId("mode-pill");
  const nseOkay = snapshot.sources && snapshot.sources.nse && snapshot.sources.nse.ok;
  const angelOkay = snapshot.sources && snapshot.sources.angelOne && snapshot.sources.angelOne.ok;
  mode.textContent = snapshot.mode === "demo" ? "DEMO · SAMPLE" : (nseOkay && angelOkay ? "ANGEL DATA · NSE INDICES" : "LIVE · CONNECTION NEEDED");
  mode.classList.toggle("live", snapshot.mode === "live" && nseOkay && angelOkay);
  mode.classList.toggle("demo", snapshot.mode === "demo");
  updateSource("nse-source", snapshot.sources && snapshot.sources.nse);
  updateSource("angel-source", snapshot.sources && snapshot.sources.angelOne);
  byId("updated-at").textContent = formatTimestamp(snapshot.updatedAt);

  const groups = snapshot.groups || {};
  const allRows = getAllRows(groups);
  const constituentData = selectedIndexName ? sectorConstituents[selectedIndexName] : null;
  const memberSet = constituentData && Array.isArray(constituentData.symbols)
    ? new Set(constituentData.symbols.map(normalizeSymbol))
    : null;
  const sectorTrackedCount = memberSet
    ? allRows.filter(function (item) { return memberSet.has(normalizeSymbol(item.symbol)); }).length
    : 0;
  const symbolTerm = byId("symbol-search").value.trim().toLowerCase();
  const filter = byId("group-filter").value;
  const changeFilter = byId("change-filter").value;
  const cashFilter = byId("cash-filter").value;
  const futureFilter = byId("future-filter").value;
  const priceFiltered = Boolean(byId("price-min").value.trim() || byId("price-max").value.trim());
  let visibleTotal = 0;

  for (const key of ["green", "red", "white"]) {
    const allItems = Array.isArray(groups[key]) ? groups[key] : [];
    const sectorItems = memberSet ? allItems.filter(function (item) {
      return memberSet.has(normalizeSymbol(item.symbol));
    }) : allItems;
    let visibleItems = sectorItems.filter(function (item) {
      return (filter === "all" || filter === key)
        && String(item.symbol).toLowerCase().includes(symbolTerm)
        && matchesPrice(item.price)
        && matchesSign(item.percentChange, changeFilter)
        && matchesSign(item.cash && item.cash.netQty, cashFilter)
        && matchesSign(item.futures && item.futures.netQty, futureFilter);
    });
    visibleItems = sortRows(visibleItems, tableSorts[key]);
    visibleTotal += visibleItems.length;
    renderGroup(key, sectorItems, visibleItems, selectedIndexName);
  }

  let unavailable = Array.isArray(groups.unavailable) ? groups.unavailable : [];
  unavailable = unavailable.filter(function (item) {
    return (filter === "all" || filter === "unavailable")
      && (!memberSet || memberSet.has(normalizeSymbol(item.symbol)))
      && String(item.symbol).toLowerCase().includes(symbolTerm)
      && !priceFiltered && changeFilter === "all" && cashFilter === "all" && futureFilter === "all";
  });
  unavailable = sortRows(unavailable, { key: "symbol", ascending: true });
  visibleTotal += unavailable.length;
  const unlisted = Array.isArray(snapshot.unlistedSymbols) ? snapshot.unlistedSymbols : [];
  const visibleUnlisted = memberSet ? unlisted.filter(function (symbol) { return memberSet.has(normalizeSymbol(symbol)); }) : unlisted;
  renderUnavailable(unavailable, visibleUnlisted);

  const total = snapshot.trackedSymbolCount || allRows.length;
  byId("result-count").textContent = selectedIndexName
    ? visibleTotal + " shown · " + sectorTrackedCount + " tracked in " + selectedIndexName
    : visibleTotal + " shown · " + total + " symbols";
  const filterIndicator = byId("sector-filter-indicator");
  const hasCustomView = hasCustomDashboardView();
  filterIndicator.hidden = false;
  if (selectedIndexName) {
    byId("sector-filter-label").textContent = "Showing " + selectedIndexName + " · " + sectorTrackedCount + " tracked symbols / " + (memberSet ? memberSet.size : 0) + " constituents";
  } else if (hasCustomView) {
    byId("sector-filter-label").textContent = "Custom dashboard view";
  } else {
    byId("sector-filter-label").textContent = "Default dashboard view · all sectors";
  }
  byId("clear-all-button").disabled = !hasCustomView;
  updateMetrics(snapshot, allRows);
  renderIndices(snapshot.indices);
  updateNotice(snapshot);
  updateCountdown(snapshot.nextFetchAt);
  updateSortHeaders();
}

function renderBeforeConnection() {
  renderIndices([]);
  for (const key of ["green", "red", "white"]) renderGroup(key, [], []);
  byId("result-count").textContent = "Waiting for live data";
}

function updateCountdown(nextFetchAt) {
  const now = Date.now();
  function remaining(value) {
    const target = value ? new Date(value).getTime() : now;
    return Math.max(0, Math.ceil((target - now) / 1000));
  }
  function clock(value) {
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }
  const nse = remaining(nextFetchAt && nextFetchAt.nse);
  const angel = remaining(nextFetchAt && nextFetchAt.angelOne);
  byId("refresh-countdown").textContent = "Angel One " + clock(angel) + " · NSE " + clock(nse);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportCsv() {
  if (!currentSnapshot) return;
  const groups = currentSnapshot.groups || {};
  let rows = getAllRows(groups);
  const selectedConstituents = selectedIndexName && sectorConstituents[selectedIndexName];
  if (selectedConstituents && Array.isArray(selectedConstituents.symbols)) {
    const members = new Set(selectedConstituents.symbols.map(normalizeSymbol));
    rows = rows.filter(function (item) { return members.has(normalizeSymbol(item.symbol)); });
  }
  const headers = [
    "symbol", "group", "ltp", "day_percent_change",
    "cash_buy_qty_5_levels", "cash_sell_qty_5_levels", "cash_net_qty",
    "future_contract", "future_expiry",
    "future_buy_qty_5_levels", "future_sell_qty_5_levels", "future_net_qty"
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const item of rows) {
    lines.push([
      item.symbol, item.bucket, item.price, item.percentChange,
      item.cash && item.cash.bidQty, item.cash && item.cash.askQty, item.cash && item.cash.netQty,
      item.futureContract, item.futureExpiry,
      item.futures && item.futures.bidQty, item.futures && item.futures.askQty, item.futures && item.futures.netQty
    ].map(csvCell).join(","));
  }
  const file = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = "nse-order-book-" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

async function loadSnapshot(force) {
  const buttons = [byId("refresh-button"), byId("sector-refresh-button")];
  if (force) {
    buttons.forEach(function (button) {
      button.disabled = true;
      button.textContent = button.id === "sector-refresh-button" ? "Refreshing…" : "Checking…";
    });
  }
  try {
    const response = await fetch(force ? "/api/refresh" : "/api/dashboard", {
      method: force ? "POST" : "GET",
      cache: "no-store"
    });
    if (!response.ok) throw new Error("Dashboard request failed.");
    const snapshot = await response.json();
    if (snapshot.loading) {
      window.setTimeout(function () { loadSnapshot(false); }, 1500);
      return;
    }
    render(snapshot);
  } catch {
    const notice = byId("notice");
    notice.dataset.state = "error";
    notice.querySelector("span:last-child").textContent = "The local dashboard server is unavailable. Restart it using the README steps.";
  } finally {
    if (force) {
      buttons.forEach(function (button) {
        button.disabled = false;
        button.textContent = button.id === "sector-refresh-button" ? "Refresh" : "Refresh now";
      });
    }
  }
}

byId("refresh-button").addEventListener("click", function () { loadSnapshot(true); });
byId("export-button").addEventListener("click", exportCsv);
byId("symbol-search").addEventListener("input", function () { if (currentSnapshot) render(currentSnapshot); });
byId("price-min").addEventListener("input", function () { if (currentSnapshot) render(currentSnapshot); });
byId("price-max").addEventListener("input", function () { if (currentSnapshot) render(currentSnapshot); });
byId("group-filter").addEventListener("change", function () { if (currentSnapshot) render(currentSnapshot); });
for (const id of ["change-filter", "cash-filter", "future-filter"]) {
  byId(id).addEventListener("change", function () { if (currentSnapshot) render(currentSnapshot); });
}
document.querySelectorAll(".sort-header").forEach(function (button) {
  button.addEventListener("click", function () {
    const bucket = button.closest(".bucket").dataset.bucket;
    const sort = tableSorts[bucket];
    const key = button.dataset.sort;
    if (sort.key === key) sort.ascending = !sort.ascending;
    else tableSorts[bucket] = { key: key, ascending: key === "symbol" };
    if (currentSnapshot) render(currentSnapshot);
    else updateSortHeaders();
  });
});
document.querySelectorAll(".bucket-sort").forEach(function (select) {
  select.addEventListener("change", function () {
    const bucket = select.dataset.bucketSort;
    tableSorts[bucket] = { key: select.value, ascending: select.value === "symbol" };
    if (currentSnapshot) render(currentSnapshot);
    else updateSortHeaders();
  });
});
byId("index-search").addEventListener("input", function () { if (currentSnapshot) renderIndices(currentSnapshot.indices); });
byId("index-sort").addEventListener("change", function () { if (currentSnapshot) renderIndices(currentSnapshot.indices); });
byId("clear-all-button").addEventListener("click", function () {
  selectedIndexName = null;
  byId("index-search").value = "";
  byId("index-sort").value = "change_desc";
  byId("symbol-search").value = "";
  byId("price-min").value = "";
  byId("price-max").value = "";
  byId("group-filter").value = "all";
  byId("change-filter").value = "all";
  byId("cash-filter").value = "all";
  byId("future-filter").value = "all";
  for (const key of ["green", "red", "white"]) tableSorts[key] = { key: "symbol", ascending: true };
  closeIndexDetails();
  if (currentSnapshot) render(currentSnapshot);
  window.scrollTo({ top: 0, behavior: "smooth" });
});
byId("sector-refresh-button").addEventListener("click", function () { loadSnapshot(true); });
byId("index-detail-close").addEventListener("click", closeIndexDetails);
byId("index-detail-backdrop").addEventListener("click", function (event) {
  if (event.target === byId("index-detail-backdrop")) closeIndexDetails();
});
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !byId("index-detail-backdrop").hidden) closeIndexDetails();
});

async function loadLoginDefaults() {
  try {
    const response = await fetch("/api/login-info", { cache: "no-store" });
    if (!response.ok) return;
    const info = await response.json();
    const missingNetworkValue = !info.localIP || !info.publicIP || !info.macAddress;
    for (const [key, value] of Object.entries({ localIP: info.localIP, publicIP: info.publicIP, macAddress: info.macAddress })) {
      const input = byId("login-form").elements.namedItem(key);
      if (input && !input.value) input.value = value || "";
    }
    if (missingNetworkValue) {
      byId("network-settings").open = true;
      const error = byId("login-error");
      error.textContent = "Network details could not all be detected. Fill the highlighted section before signing in.";
      error.hidden = false;
    }
  } catch {}
}

function setSessionUi(authenticated) {
  byId("sign-in-button").hidden = authenticated;
  byId("sign-out-button").hidden = !authenticated;
  if (authenticated) byId("login-backdrop").hidden = true;
  previouslyAuthenticated = authenticated;
}

async function checkSession(showLogin) {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    const status = await response.json();
    const wasAuthenticated = previouslyAuthenticated;
    setSessionUi(Boolean(status.authenticated));
    if (!status.authenticated && (showLogin || wasAuthenticated)) {
      byId("login-backdrop").hidden = false;
      loadLoginDefaults();
    }
  } catch {}
}

byId("login-form").addEventListener("submit", async function (event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = byId("login-submit");
  const error = byId("login-error");
  const values = Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  button.textContent = "Signing in…";
  error.hidden = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
      cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed.");
    form.reset();
    setSessionUi(true);
    byId("notice").dataset.state = "live";
    byId("notice").querySelector("span:last-child").textContent = result.message || "Signed in. Loading market data…";
    loadSnapshot(false);
  } catch (failure) {
    error.textContent = failure.message || "Sign-in failed. Check your details and try again.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

byId("sign-in-button").addEventListener("click", function () {
  byId("login-error").hidden = true;
  byId("login-backdrop").hidden = false;
  loadLoginDefaults();
});
byId("continue-without-login").addEventListener("click", function () { byId("login-backdrop").hidden = true; });
byId("sign-out-button").addEventListener("click", async function () {
  const button = byId("sign-out-button");
  button.disabled = true;
  try {
    await fetch("/api/logout", { method: "POST", cache: "no-store" });
    setSessionUi(false);
    byId("login-backdrop").hidden = false;
    byId("login-error").hidden = true;
    loadLoginDefaults();
    loadSnapshot(false);
  } finally {
    button.disabled = false;
  }
});

renderBeforeConnection();
loadBundledConstituents().finally(function () {
  refreshConstituents();
  loadSnapshot(false);
});
checkSession(true);
pollTimer = window.setInterval(function () { loadSnapshot(false); }, 10000);
window.setInterval(function () { checkSession(false); }, 10000);
window.setInterval(function () {
  if (currentSnapshot) updateCountdown(currentSnapshot.nextFetchAt);
}, 1000);
window.setInterval(refreshConstituents, 60 * 60 * 1000);

