import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./evaluate.mjs";
import { fetchSnapshot } from "./unifi.mjs";
import { demoInput } from "./demo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const historyPath = path.join(dataDir, "history.json");
const settingsPath = path.join(dataDir, "settings.json");

loadEnv(path.join(root, ".env"));

const demo = process.env.UNIFI_DEMO === "1";
const port = Number(process.env.PORT || 8787);
const repeatThreshold = Number(process.env.REPEAT_THRESHOLD || 2);
const packetLossLimit = Number(process.env.PACKET_LOSS_PERCENT || 2);
const apiKey = process.env.UNIFI_API_KEY || "";
const clients = new Set();

let pollSeconds = await loadPollSeconds();
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

async function loadPollSeconds() {
  try {
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    return normalizePollSeconds(saved.pollSeconds) ?? normalizePollSeconds(process.env.POLL_SECONDS) ?? 60;
  } catch {
    return normalizePollSeconds(process.env.POLL_SECONDS) ?? 60;
  }
}

async function savePollSeconds(seconds) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ pollSeconds: seconds }));
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

function livePayload() {
  return { ...snapshot, pollSeconds, checking };
}

function broadcast() {
  const chunk = `data: ${JSON.stringify(livePayload())}\n\n`;
  for (const client of clients) client.write(chunk);
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

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/api/warnings") {
    send(response, 200, JSON.stringify(livePayload()));
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    send(response, 200, JSON.stringify({ pollSeconds }));
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = await readBody(request);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      send(response, 400, JSON.stringify({ error: "Enter a whole number of seconds." }));
      return;
    }
    const seconds = normalizePollSeconds(parsed.pollSeconds);
    if (seconds == null) {
      send(response, 400, JSON.stringify({ error: "Use a whole number from 5 to 86400 seconds." }));
      return;
    }
    pollSeconds = seconds;
    await savePollSeconds(seconds);
    scheduleNextPoll();
    broadcast();
    send(response, 200, JSON.stringify({ pollSeconds }));
    return;
  }

  if (url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify(livePayload())}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  const requested = url.pathname === "/settings" ? "/settings.html" : url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
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
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

await tick();
scheduleNextPoll();
server.listen(port, "127.0.0.1", () => {
  console.log(`UniFi warnings dashboard at http://127.0.0.1:${port}`);
});
