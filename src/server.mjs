import { createServer } from "node:http";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./evaluate.mjs";
import { fetchSnapshot } from "./unifi.mjs";
import { demoInput } from "./demo.mjs";
import {
  clearSessionCookie,
  createUser,
  deleteUser,
  findUserByToken,
  initAuth,
  listUsers,
  login,
  logout,
  readCookie,
  sessionCookie,
  updateUser,
  visibleSites,
} from "./auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const historyPath = path.join(dataDir, "history.json");
const settingsPath = path.join(dataDir, "settings.json");
const logoPath = path.join(dataDir, "logo");
const logoTypes = new Map([
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46]],
]);

loadEnv(path.join(root, ".env"));

const demo = process.env.UNIFI_DEMO === "1";
const port = Number(process.env.PORT || 8787);
const repeatThreshold = Number(process.env.REPEAT_THRESHOLD || 2);
const packetLossLimit = Number(process.env.PACKET_LOSS_PERCENT || 2);
const apiKey = process.env.UNIFI_API_KEY || "";
const clients = new Set();

await initAuth(dataDir);
let pollSeconds = 60;
let logoType = null;
await loadSettings();
let pollTimer = null;
let checking = false;

let history = demo ? null : await loadHistory();
let snapshot = {
  updatedAt: null,
  error: null,
  demo,
  summary: { networks: 0, devicesChecked: 0, healthy: 0, warnings: 0, offline: 0, repeated: 0 },
  warnings: [],
};
let polling = false;

function normalizePollSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400) return null;
  return seconds;
}

async function loadSettings() {
  pollSeconds = normalizePollSeconds(process.env.POLL_SECONDS) ?? 60;
  logoType = null;
  try {
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    pollSeconds = normalizePollSeconds(saved.pollSeconds) ?? pollSeconds;
    if (logoTypes.has(saved.logoType) && existsSync(logoPath)) logoType = saved.logoType;
  } catch {
    // The first run uses the environment default until Settings is saved.
  }
}

async function saveSettings() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ pollSeconds, logoType }));
}

function logoMatches(type, body) {
  const signature = logoTypes.get(type);
  if (!signature || body.length < 12) return false;
  const bytes = signature.every((byte, index) => body[index] === byte);
  if (!bytes) return false;
  if (type === "image/webp") return body.subarray(8, 12).toString("ascii") === "WEBP";
  return true;
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(historyPath, "utf8"));
  } catch {
    return { seeded: false, devices: {}, isp: {} };
  }
}

async function saveHistory(next) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(historyPath, JSON.stringify(next));
}

function payloadFor(user) {
  const sites = visibleSites(snapshot.sites || [], user);
  const singleSite = Boolean(user && !user.fullAccess && (user.siteIds || []).length === 1);
  return {
    updatedAt: snapshot.updatedAt,
    error: snapshot.error,
    demo: snapshot.demo,
    ispNote: snapshot.ispNote || null,
    sites,
    pollSeconds,
    checking,
    access: user
      ? { email: user.email, fullAccess: Boolean(user.fullAccess), admin: Boolean(user.admin), singleSite }
      : null,
  };
}

function broadcast() {
  for (const client of clients) {
    const user = findUserByToken(client.token);
    if (!user) {
      client.response.write(`data: ${JSON.stringify({ unauthorized: true })}\n\n`);
      client.response.end();
      clients.delete(client);
      continue;
    }
    client.response.write(`data: ${JSON.stringify(payloadFor(user))}\n\n`);
  }
}

function scheduleNextPoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await tick();
    scheduleNextPoll();
  }, pollSeconds * 1000);
}

async function tick() {
  if (polling) return;
  polling = true;
  checking = true;
  broadcast();
  try {
    if (!demo && !apiKey) {
      snapshot = {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        error: "Add UNIFI_API_KEY to .env, then restart the dashboard.",
        demo: false,
      };
      return;
    }

    const input = demo
      ? demoInput()
      : {
          ...(await fetchSnapshot(apiKey)),
          history,
          now: new Date().toISOString(),
          repeatThreshold,
          packetLossLimit,
        };
    if (demo) input.repeatThreshold = repeatThreshold;
    const result = evaluate(input);
    history = result.history;
    if (!demo) await saveHistory(history);
    snapshot = {
      updatedAt: result.now,
      error: null,
      demo,
      ispNote: input.ispError || null,
      summary: result.summary,
      sites: result.sites,
      warnings: result.warnings,
    };
  } catch (error) {
    const status = error.status === 401 ? "The UniFi API key was rejected." : error.message;
    snapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      error: status,
      demo,
    };
  } finally {
    polling = false;
    checking = false;
    broadcast();
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(response, status, body, type = "application/json; charset=utf-8", headers = {}) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function requestUser(request) {
  return findUserByToken(readCookie(request.headers.cookie, "unifi_session"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const user = requestUser(request);
  const publicFile = url.pathname === "/styles.css" || url.pathname === "/login.js" || url.pathname === "/brand.js";

  if (url.pathname === "/logo" && request.method === "GET") {
    if (!logoType) {
      send(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    try {
      send(response, 200, await readFile(logoPath), logoType);
    } catch {
      send(response, 404, "Not found", "text/plain; charset=utf-8");
    }
    return;
  }

  if (url.pathname === "/login" && request.method === "GET") {
    if (user) {
      redirect(response, "/");
      return;
    }
    await serveFile(response, "/login.html");
    return;
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) {
      send(response, 400, JSON.stringify({ error: "Enter your email and password." }));
      return;
    }
    const result = await login(parsed.value.email, parsed.value.password);
    if (!result.token) {
      send(response, 401, JSON.stringify({ error: result.error }));
      return;
    }
    send(response, 200, JSON.stringify({ email: result.user.email }), "application/json; charset=utf-8", {
      "Set-Cookie": sessionCookie(result.token),
    });
    return;
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    await logout(readCookie(request.headers.cookie, "unifi_session"));
    send(response, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", {
      "Set-Cookie": clearSessionCookie(),
    });
    return;
  }

  if (!user && !publicFile) {
    if (url.pathname.startsWith("/api/")) {
      send(response, 401, JSON.stringify({ error: "Sign in required." }));
      return;
    }
    redirect(response, "/login");
    return;
  }

  if (url.pathname === "/api/warnings") {
    send(response, 200, JSON.stringify(payloadFor(user)));
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    send(response, 200, JSON.stringify({ pollSeconds, hasLogo: Boolean(logoType) }));
    return;
  }

  if (url.pathname === "/api/logo" && request.method === "POST") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    const type = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    let body;
    try {
      body = await readBuffer(request);
    } catch {
      send(response, 400, JSON.stringify({ error: "Use an image up to 1 MB." }));
      return;
    }
    if (!logoMatches(type, body)) {
      send(response, 400, JSON.stringify({ error: "Use a PNG, JPEG, WebP, or GIF." }));
      return;
    }
    if (body.length > 1024 * 1024) {
      send(response, 400, JSON.stringify({ error: "Use an image up to 1 MB." }));
      return;
    }
    await mkdir(dataDir, { recursive: true });
    await writeFile(logoPath, body);
    logoType = type;
    await saveSettings();
    send(response, 200, JSON.stringify({ hasLogo: true }));
    return;
  }

  if (url.pathname === "/api/logo" && request.method === "DELETE") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    logoType = null;
    await saveSettings();
    await unlink(logoPath).catch(() => {});
    send(response, 200, JSON.stringify({ hasLogo: false }));
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "POST") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    const parsed = await readJson(request);
    if (!parsed.ok) {
      send(response, 400, JSON.stringify({ error: "Enter a whole number of seconds." }));
      return;
    }
    const seconds = normalizePollSeconds(parsed.value.pollSeconds);
    if (seconds == null) {
      send(response, 400, JSON.stringify({ error: "Use a whole number from 5 to 86400 seconds." }));
      return;
    }
    pollSeconds = seconds;
    await saveSettings();
    scheduleNextPoll();
    broadcast();
    send(response, 200, JSON.stringify({ pollSeconds }));
    return;
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    send(response, 200, JSON.stringify({ users: listUsers(), sites: snapshot.sites || [] }));
    return;
  }

  if (url.pathname === "/api/users" && request.method === "POST") {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    const parsed = await readJson(request);
    if (!parsed.ok) {
      send(response, 400, JSON.stringify({ error: "Could not read that user." }));
      return;
    }
    const result = await createUser(parsed.value);
    send(response, result.error ? 400 : 200, JSON.stringify(result.error ? { error: result.error } : result));
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && (request.method === "PUT" || request.method === "DELETE")) {
    if (!user.admin) {
      send(response, 403, JSON.stringify({ error: "Admin access is required." }));
      return;
    }
    const id = decodeURIComponent(userMatch[1]);
    if (request.method === "DELETE") {
      const result = await deleteUser(id);
      broadcast();
      send(response, result.error ? 400 : 200, JSON.stringify(result.error ? { error: result.error } : result));
      return;
    }
    const parsed = await readJson(request);
    if (!parsed.ok) {
      send(response, 400, JSON.stringify({ error: "Could not read that user." }));
      return;
    }
    const result = await updateUser(id, parsed.value);
    broadcast();
    send(response, result.error ? 400 : 200, JSON.stringify(result.error ? { error: result.error } : result));
    return;
  }

  if (url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const client = { response, token: readCookie(request.headers.cookie, "unifi_session") };
    response.write(`data: ${JSON.stringify(payloadFor(user))}\n\n`);
    clients.add(client);
    request.on("close", () => clients.delete(client));
    return;
  }

  if ((url.pathname === "/settings" || url.pathname === "/users") && !user.admin) {
    redirect(response, "/");
    return;
  }

  const requested = url.pathname === "/settings"
    ? "/settings.html"
    : url.pathname === "/users"
      ? "/users.html"
      : url.pathname === "/"
        ? "/index.html"
        : decodeURIComponent(url.pathname);
  await serveFile(response, requested);
});

async function serveFile(response, requested) {
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  try {
    const body = await readFile(filePath);
    send(response, 200, body, types[path.extname(filePath)] || "application/octet-stream");
  } catch {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function readBuffer(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024 + 1) {
        request.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function readBody(request) {
  return readBuffer(request).then((body) => body.toString("utf8"));
}

async function readJson(request) {
  try {
    return { ok: true, value: JSON.parse((await readBody(request)) || "{}") };
  } catch {
    return { ok: false, value: null };
  }
}

await tick();
scheduleNextPoll();
server.listen(port, "127.0.0.1", () => {
  console.log(`Unifi Site Monitor at http://127.0.0.1:${port}`);
});
