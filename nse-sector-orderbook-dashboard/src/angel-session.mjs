import os from "node:os";

const LOGIN_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";
const REFRESH_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens";
const LOGOUT_URL = "https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/logout";
const REQUEST_TIMEOUT_MS = 30000;

function networkDefaults() {
  const entries = Object.entries(os.networkInterfaces()).flatMap(function ([name, addresses]) {
    return (addresses || []).map(function (address) { return { name: name, ...address }; });
  });
  const ipv4 = entries.find(function (item) {
    return (item.family === "IPv4" || item.family === 4) && !item.internal && item.address && !item.address.startsWith("169.254.");
  });
  const macEntry = entries.find(function (item) {
    return item.mac && item.mac !== "00:00:00:00:00:00" && !item.internal;
  });
  return {
    localIP: ipv4 ? ipv4.address : "",
    macAddress: macEntry ? macEntry.mac : ""
  };
}

async function findPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return "";
    const result = await response.json();
    return typeof result.ip === "string" ? result.ip : "";
  } catch {
    return "";
  }
}

function jwtExpiresAt(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return Number(parsed.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

async function readJson(response, serviceName) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(serviceName + " returned an unreadable response.");
  }
  if (!response.ok || payload.status === false || payload.status === "false" || payload.success === false || payload.success === "false") {
    const apiMessage = String(payload.message || payload.errorMessage || "").trim();
    const errorCode = String(payload.errorcode || "").trim();
    const error = new Error((apiMessage ? serviceName + ": " + apiMessage : serviceName + " request failed.")
      + (errorCode ? " (" + errorCode + ")" : ""));
    if (/invalid\s*api\s*key/i.test(apiMessage) || errorCode.toUpperCase() === "AG8004") {
      error.code = "ANGEL_INVALID_API_KEY";
    } else if (/invalid.{0,20}(?:refresh|auth|jwt)?\s*token|(?:refresh|auth|jwt)?\s*token.{0,20}(?:invalid|expired)|session.{0,20}expired/i.test(apiMessage)) {
      error.code = "ANGEL_SESSION_EXPIRED";
    }
    throw error;
  }
  return payload;
}

export function createAngelSession() {
  let session = null;
  let loginDefaultsCache = null;
  let loginDefaultsAt = 0;
  let refreshPromise = null;

  async function getLoginDefaults() {
    if (loginDefaultsCache && Date.now() - loginDefaultsAt < 60000) return loginDefaultsCache;
    const device = networkDefaults();
    const publicIP = await findPublicIp();
    loginDefaultsCache = { ...device, publicIP: publicIP };
    loginDefaultsAt = Date.now();
    return loginDefaultsCache;
  }

  function baseHeaders(activeSession, includeAuthorization) {
    const headers = {
      "X-PrivateKey": activeSession.apiKey,
      "X-ClientCode": activeSession.clientCode,
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": activeSession.localIP,
      "X-ClientPublicIP": activeSession.publicIP,
      "X-MACAddress": activeSession.macAddress,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    if (includeAuthorization && activeSession.jwtToken) headers.Authorization = "Bearer " + activeSession.jwtToken;
    return headers;
  }

  async function performTokenRefresh() {
    if (!session) {
      const error = new Error("Your Angel One session has expired. Sign in again.");
      error.code = "ANGEL_SESSION_EXPIRED";
      throw error;
    }
    const activeSession = session;
    if (!activeSession.refreshToken) {
      session = null;
      const error = new Error("Your Angel One session has expired. Sign in again.");
      error.code = "ANGEL_SESSION_EXPIRED";
      throw error;
    }
    try {
      const response = await fetch(REFRESH_URL, {
        method: "POST",
        headers: baseHeaders(activeSession, true),
        body: JSON.stringify({ refreshToken: activeSession.refreshToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const payload = await readJson(response, "Angel One session refresh failed");
      if (session !== activeSession) {
        const error = new Error("The Angel One session ended. Sign in again if you want order-book data.");
        error.code = "ANGEL_SESSION_EXPIRED";
        throw error;
      }
      if (!payload.data || !payload.data.jwtToken) throw new Error("Angel One did not return a refreshed session.");
      session = {
        ...activeSession,
        jwtToken: payload.data.jwtToken,
        refreshToken: payload.data.refreshToken || activeSession.refreshToken,
        feedToken: payload.data.feedToken || activeSession.feedToken
      };
    } catch (error) {
      if (session === activeSession && (error.code === "ANGEL_INVALID_API_KEY" || error.code === "ANGEL_SESSION_EXPIRED")) session = null;
      throw error;
    }
  }

  async function ensureFreshToken() {
    if (!session) throw new Error("Sign in to Angel One to load order-book data.");
    const expiresAt = jwtExpiresAt(session.jwtToken);
    if (expiresAt && expiresAt < Date.now() + 60000) {
      if (!refreshPromise) refreshPromise = performTokenRefresh().finally(function () { refreshPromise = null; });
      await refreshPromise;
    }
  }

  return {
    async login(input) {
      const values = {
        apiKey: String(input.apiKey || "").trim(),
        clientCode: String(input.clientCode || "").trim(),
        pin: String(input.pin || "").trim(),
        totp: String(input.totp || "").trim(),
        localIP: String(input.localIP || "").trim(),
        publicIP: String(input.publicIP || "").trim(),
        macAddress: String(input.macAddress || "").trim()
      };
      const missing = Object.entries(values).filter(function ([key, value]) { return !value; }).map(function ([key]) { return key; });
      if (missing.length) throw new Error("Complete all sign-in fields and network details before continuing.");

      const loginHeaders = {
        "X-PrivateKey": values.apiKey,
        "X-ClientCode": values.clientCode,
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": values.localIP,
        "X-ClientPublicIP": values.publicIP,
        "X-MACAddress": values.macAddress,
        Accept: "application/json",
        "Content-Type": "application/json"
      };
      const response = await fetch(LOGIN_URL, {
        method: "POST",
        headers: loginHeaders,
        body: JSON.stringify({ clientcode: values.clientCode, password: values.pin, totp: values.totp }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const payload = await readJson(response, "Angel One sign-in failed");
      if (!payload.data || !payload.data.jwtToken) throw new Error("Angel One did not return a signed-in session.");
      session = {
        apiKey: values.apiKey,
        clientCode: values.clientCode,
        localIP: values.localIP,
        publicIP: values.publicIP,
        macAddress: values.macAddress,
        jwtToken: payload.data.jwtToken,
        refreshToken: payload.data.refreshToken || "",
        feedToken: payload.data.feedToken || ""
      };
      return this.status();
    },

    status() {
      return { authenticated: Boolean(session) };
    },

    clear() {
      session = null;
    },

    async request(url, options) {
      await ensureFreshToken();
      const makeRequest = function () {
        return fetch(url, {
          ...options,
          headers: { ...baseHeaders(session, true), ...(options && options.headers || {}) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      };
      let response = await makeRequest();
      if (response.status === 401 || response.status === 403) {
        if (!refreshPromise) refreshPromise = performTokenRefresh().finally(function () { refreshPromise = null; });
        await refreshPromise;
        const refreshedSession = session;
        response = await makeRequest();
        if ((response.status === 401 || response.status === 403) && session === refreshedSession) session = null;
      }
      return response;
    },

    async logout() {
      const activeSession = session;
      session = null;
      if (!activeSession) return { loggedOut: true, remoteLogout: true };
      try {
        const response = await fetch(LOGOUT_URL, {
          method: "POST",
          headers: baseHeaders(activeSession, true),
          body: JSON.stringify({ clientcode: activeSession.clientCode }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        await readJson(response, "Angel One logout failed");
        return { loggedOut: true, remoteLogout: true };
      } catch {
        return { loggedOut: true, remoteLogout: false };
      }
    },

    getLoginDefaults: getLoginDefaults
  };
}
