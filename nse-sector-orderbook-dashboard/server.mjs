import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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
const port = Number(process.env.PORT || 8765);
const angelSession = createAngelSession();
const dataService = createDataService(projectRoot, angelSession);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

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
  if (url.pathname === "/api/session" && request.method === "GET") {
    sendJson(response, 200, angelSession.status());
    return;
  }
  if (url.pathname === "/api/login-info" && request.method === "GET") {
    sendJson(response, 200, { ...(await angelSession.getLoginDefaults()), hosted: runningOnRender });
    return;
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    try {
      const credentials = await readJsonBody(request);
      if (runningOnRender) {
        const renderNetwork = await angelSession.getLoginDefaults();
        for (const key of ["localIP", "publicIP", "macAddress"]) {
          if (renderNetwork[key]) credentials[key] = renderNetwork[key];
        }
      }
      const status = await angelSession.login(credentials);
      dataService.resetAngel();
      dataService.refresh(true).catch(function () {});
      sendJson(response, 200, { ...status, message: "Signed in. Loading market data…" });
    } catch (error) {
      sendJson(response, 401, { error: error.message || "Angel One sign-in failed." });
    }
    return;
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const result = await angelSession.logout();
    dataService.resetAngel();
    dataService.refresh(true).catch(function () {});
    sendJson(response, 200, {
      loggedOut: true,
      message: result.remoteLogout ? "Signed out of Angel One." : "Signed out locally. Angel One could not confirm remote logout."
    });
    return;
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const snapshot = dataService.getSnapshot();
    if (snapshot) sendJson(response, 200, snapshot);
    else sendJson(response, 200, {
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
    });
    return;
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    try {
      sendJson(response, 200, await dataService.refresh(true, true));
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
    dataService.refresh().catch(function () {});
    setInterval(function () {
      dataService.refresh().catch(function () {});
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

