import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDataService } from "./src/data-service.mjs";
import { createAngelSession } from "./src/angel-session.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, "public");
const runningOnRender = String(process.env.RENDER || "").toLowerCase() === "true";
const MIN_DASHBOARD_PASSWORD_LENGTH = 12;

function loadLocalEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const splitAt = line.indexOf("=");
    if (splitAt < 1) continue;
    const key = line.slice(0, splitAt).trim();
    let value = line.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();
if (["ANGELONE_API_KEY", "ANGELONE_API_SECRET", "ANGELONE_JWT", "ANGELONE_REFRESH_TOKEN", "ANGELONE_CLIENT_CODE"].some(function (name) { return Boolean(process.env[name]); })) {
  console.warn("[Angel One] Ignoring environment-based credentials; only the API Key entered in the sign-in form is used.");
}
const port = Number(process.env.PORT || 8765);
const clientContexts = new Map();
const CLIENT_COOKIE_NAME = "nse_dashboard_client";
const angelSession = createAngelSession();
const dataService = createDataService(projectRoot, angelSession);
let angelLoginQueue = Promise.resolve();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function requestCookie(request, name) {
  const cookieHeader = String(request.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function getClientContext(request, response) {
  let clientId = requestCookie(request, CLIENT_COOKIE_NAME);
  if (!/^[A-Za-z0-9_-]{43}$/.test(clientId)) {
    clientId = randomBytes(32).toString("base64url");
    response.setHeader("Set-Cookie", CLIENT_COOKIE_NAME + "=" + clientId
      + "; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax"
      + (runningOnRender ? "; Secure" : ""));
  }

  let context = clientContexts.get(clientId);
  if (!context) {
    context = { clientId: clientId, logTag: randomBytes(3).toString("hex"), authorized: false };
    clientContexts.set(clientId, context);
  }
  return context;
}

function clientHasActiveAngelSession(client) {
  return Boolean(client && client.authorized && angelSession.status().authenticated);
}

function snapshotForClient(snapshot, client) {
  if (clientHasActiveAngelSession(client)) return snapshot;
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    groups: { green: [], red: [], white: [], unavailable: [] },
    trackedSymbolCount: 0,
    unlistedSymbols: [],
    sources: {
      ...snapshot.sources,
      angelOne: { ok: false, state: "offline", message: "Sign in to Angel One on this browser", sourceTime: null }
    }
  };
}

function hasOtherAuthorizedClient(client) {
  return Array.from(clientContexts.values()).some(function (other) {
    return other !== client && clientHasActiveAngelSession(other);
  });
}

function runAngelLogin(client, credentials) {
  const operation = angelLoginQueue.then(async function () {
    if (angelSession.status().authenticated) {
      if (angelSession.matches(credentials)) {
        client.authorized = true;
        console.info("[Angel One] Browser " + client.logTag + " reused the active server-side session.");
        dataService.refresh(true, false, { source: "login-reuse", clientTag: client.logTag }).catch(function () {});
        return { ...angelSession.status(), message: "Connected to the existing Angel One session on this dashboard. Loading market data…" };
      }
      if (!angelSession.matchesClient(credentials) && hasOtherAuthorizedClient(client)) {
        throw new Error("Another browser has an active Angel One session. Use the same client code and API key, or reset the Angel One session on all browsers before switching accounts.");
      }
      const sameClientCode = angelSession.matchesClient(credentials);
      if (sameClientCode && hasOtherAuthorizedClient(client)) {
        throw new Error("This browser submitted a different SmartAPI API key from the one active in another browser for this client. Check the API key field and any browser autofill; the active session was left unchanged.");
      }
      await angelSession.logout();
      dataService.resetAngel();
      console.info("[Angel One] Browser " + client.logTag + " replaced the active server-side session (" + (sameClientCode ? "same client code, different API key" : "different client code") + "); credentials omitted.");
    }

    const status = await angelSession.login(credentials);
    client.authorized = true;
    dataService.resetAngel();
    console.info("[Angel One] Browser " + client.logTag + " established a new server-side session; credentials omitted.");
    dataService.refresh(true, false, { source: "login-new", clientTag: client.logTag }).catch(function () {});
    return { ...status, message: "Signed in. Loading market data…" };
  });
  angelLoginQueue = operation.catch(function () {});
  return operation;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function constantTimeMatch(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function authorizeHostedDashboard(request, response) {
  if (!runningOnRender) return true;
  const expectedPassword = String(process.env.DASHBOARD_PASSWORD || "");
  if (expectedPassword.length < MIN_DASHBOARD_PASSWORD_LENGTH) {
    sendJson(response, 503, { error: "The dashboard owner must set a 12-character-or-longer DASHBOARD_PASSWORD in Render before using this service." });
    return false;
  }

  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  let username = "";
  let password = "";
  if (match) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch {}
  }
  if (username === "dashboard" && constantTimeMatch(password, expectedPassword)) return true;
  response.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Basic realm="NSE Sector Dashboard", charset="UTF-8"'
  });
  response.end("Sign in to the dashboard.");
  return false;
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  const protocol = String(request.headers["x-forwarded-proto"] || (runningOnRender ? "https" : "http")).split(",")[0].trim().replace(/:$/, "");
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host.toLowerCase() && parsed.protocol === protocol + ":";
  } catch {
    return false;
  }
}

async function readJsonBody(request, limit = 16000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function credentialsFromLoginForm(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Sign in through the Angel One form and enter the requested SmartAPI API Key.");
  }
  const field = function (name) { return typeof payload[name] === "string" ? payload[name].trim() : ""; };
  const apiKey = field("apiKey");
  if (!apiKey) throw new Error("Enter the SmartAPI API Key in the Angel One sign-in form.");
  return {
    apiKey: apiKey,
    clientCode: field("clientCode"),
    pin: field("pin"),
    totp: field("totp"),
    localIP: field("localIP"),
    publicIP: field("publicIP"),
    macAddress: field("macAddress")
  };
}

function isLocalOrigin(request) {
  const host = String(request.headers.host || "").toLowerCase();
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase()) && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

async function serveStatic(urlPath, response) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(publicRoot, "." + requested);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await readFile(filePath);
    const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async function (request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1:" + port);
  if (url.pathname === "/healthz" && request.method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!authorizeHostedDashboard(request, response)) return;
  if (url.pathname.startsWith("/api/") && !runningOnRender && !isLocalOrigin(request)) {
    sendJson(response, 403, { error: "This local dashboard accepts requests from this computer only." });
    return;
  }
  if (url.pathname.startsWith("/api/") && request.method !== "GET" && !isSameOrigin(request)) {
    sendJson(response, 403, { error: "This dashboard accepts changes only from its own page." });
    return;
  }
  const client = getClientContext(request, response);
  if (url.pathname === "/api/session" && request.method === "GET") {
    if (!angelSession.status().authenticated) client.authorized = false;
    sendJson(response, 200, { authenticated: clientHasActiveAngelSession(client) });
    return;
  }
  if (url.pathname === "/api/login-info" && request.method === "GET") {
    sendJson(response, 200, { ...(await angelSession.getLoginDefaults()), hosted: runningOnRender });
    return;
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    try {
      const credentials = credentialsFromLoginForm(await readJsonBody(request));
      if (runningOnRender) {
        const renderNetwork = await angelSession.getLoginDefaults();
        for (const key of ["localIP", "publicIP", "macAddress"]) {
          if (renderNetwork[key]) credentials[key] = renderNetwork[key];
        }
      }
      const status = await runAngelLogin(client, credentials);
      sendJson(response, 200, status);
    } catch (error) {
      sendJson(response, 401, { error: error.message || "Angel One sign-in failed." });
    }
    return;
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    client.authorized = false;
    if (hasOtherAuthorizedClient(client)) {
      sendJson(response, 200, {
        loggedOut: true,
        message: "Signed out on this browser. Angel One data remains connected on your other browser."
      });
      return;
    }
    const result = await angelSession.logout();
    dataService.resetAngel();
    dataService.refresh(true, false, { source: "logout", clientTag: client.logTag }).catch(function () {});
    sendJson(response, 200, {
      loggedOut: true,
      message: result.remoteLogout ? "Signed out of Angel One." : "Signed out locally. Angel One could not confirm remote logout."
    });
    return;
  }
  if (url.pathname === "/api/logout-all" && request.method === "POST") {
    for (const context of clientContexts.values()) context.authorized = false;
    const result = await angelSession.logout();
    dataService.resetAngel();
    dataService.refresh(true, false, { source: "logout-all", clientTag: client.logTag }).catch(function () {});
    sendJson(response, 200, {
      loggedOut: true,
      remoteLogout: result.remoteLogout,
      message: result.remoteLogout
        ? "Signed out of Angel One on this dashboard. All browsers must sign in again."
        : "Cleared the Angel One session on this dashboard. Angel One could not confirm remote sign-out. All browsers must sign in again."
    });
    return;
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const snapshot = dataService.getSnapshot();
    if (snapshot) sendJson(response, 200, snapshotForClient(snapshot, client));
    else sendJson(response, 200, snapshotForClient({
      loading: true,
      mode: String(process.env.DATA_MODE || "live").toLowerCase(),
      refreshSeconds: 60,
      updatedAt: null,
      indices: [],
      groups: { green: [], red: [], white: [], unavailable: [] },
      sources: {
        nse: { ok: false, state: "loading", message: "Checking source", sourceTime: null },
        angelOne: { ok: false, state: "loading", message: "Checking source", sourceTime: null }
      }
    }, client));
    return;
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    try {
      sendJson(response, 200, snapshotForClient(await dataService.refresh(true, true, { source: "manual", clientTag: client.logTag }), client));
    } catch {
      sendJson(response, 500, { error: "Refresh failed. Check the local project status and settings." });
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Unknown API route" });
    return;
  }
  await serveStatic(decodeURIComponent(url.pathname), response);
});

function listenOnPort(candidatePort) {
  server.once("error", function (error) {
    if (error.code === "EADDRINUSE" && candidatePort < 65535) {
      console.log("Port " + candidatePort + " is in use; trying " + (candidatePort + 1) + ".");
      listenOnPort(candidatePort + 1);
      return;
    }
    console.error("Could not start the dashboard server:", error.message);
    process.exitCode = 1;
  });

  server.listen(candidatePort, runningOnRender ? "0.0.0.0" : "127.0.0.1", function () {
    const activePort = server.address().port;
    const dashboardUrl = "http://127.0.0.1:" + activePort;
    console.log("NSE Sector + Order Book dashboard is running at " + dashboardUrl);
    console.log("Data mode: " + (String(process.env.DATA_MODE || "live").toLowerCase() === "demo" ? "demo" : "live"));
    if (process.platform === "win32" && process.env.OPEN_DASHBOARD_BROWSER === "1") {
      const browser = spawn("cmd.exe", ["/c", "start", "", dashboardUrl], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      browser.on("error", function () {
        console.log("Could not open a browser automatically. Open " + dashboardUrl);
      });
      browser.unref();
    }
    dataService.refresh(false, false, { source: "startup", clientTag: null }).catch(function () {});
    setInterval(function () {
      dataService.refresh(false, false, { source: "scheduler", clientTag: null }).catch(function () {});
    }, 60000);
  });
}

listenOnPort(port);

async function stopServer() {
  await angelSession.logout();
  server.close(function () { process.exit(0); });
}
process.once("SIGINT", stopServer);
process.once("SIGTERM", stopServer);

