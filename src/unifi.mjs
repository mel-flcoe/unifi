const API_ORIGIN = "https://api.ui.com";

function asList(body) {
  if (Array.isArray(body)) return { items: body, nextToken: null };
  if (Array.isArray(body?.data)) return { items: body.data, nextToken: body.nextToken || null };
  if (body?.data && typeof body.data === "object") return { items: [body.data], nextToken: null };
  return { items: [], nextToken: null };
}

async function apiGet(apiKey, pathname, params = {}) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
    });
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get("retry-after") || 2);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 180) };
    }
    if (!response.ok) {
      const message = body?.message || `UniFi API returned ${response.status} for ${pathname}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }
  throw new Error(`UniFi API returned 429 for ${pathname}`);
}

async function listPaged(apiKey, pathname) {
  const items = [];
  let nextToken = null;
  do {
    const body = await apiGet(apiKey, pathname, {
      pageSize: 200,
      nextToken,
    });
    const page = asList(body);
    items.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}

export async function fetchSnapshot(apiKey) {
  const [hosts, sites, deviceGroups] = await Promise.all([
    listPaged(apiKey, "/v1/hosts"),
    listPaged(apiKey, "/v1/sites"),
    listPaged(apiKey, "/v1/devices"),
  ]);

  let isp = null;
  let ispError = null;
  try {
    isp = await apiGet(apiKey, "/ea/isp-metrics/5m");
  } catch (error) {
    ispError = error.message;
  }

  return { hosts, sites, deviceGroups, isp, ispError };
}
