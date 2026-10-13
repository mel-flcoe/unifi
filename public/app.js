const status = document.querySelector("#status");
const main = document.querySelector("#main");
const dialog = document.querySelector("#site-dialog");
const siteBody = document.querySelector("#site-body");
const closeSite = document.querySelector("#close-site");
let latest = null;
let openSiteId = null;
let tileSignature = "";

closeSite.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  openSiteId = null;
});

main.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-site-id]");
  if (!tile) return;
  openSite(tile.dataset.siteId);
});

function openSite(siteId) {
  const site = (latest?.sites || []).find((item) => item.id === siteId);
  if (!site) return;
  openSiteId = siteId;
  fillDialog(site);
  if (!dialog.open) dialog.showModal();
}

let navMarkup = "";

function renderNav() {
  const nav = document.querySelector("#nav");
  if (!nav || !latest?.access) return;
  const links = [];
  if (latest.access.admin) {
    links.push(`<a class="settings-link" href="/users">Users</a>`);
    links.push(`<a class="settings-link" href="/settings">Settings</a>`);
  }
  links.push(`<span class="who">${escapeHtml(latest.access.email)}</span>`);
  const markup = links.join("");
  if (markup === navMarkup) return;
  navMarkup = markup;
  nav.innerHTML = markup;
}

function renderSites() {
  if (!latest) return;
  const { error, sites = [] } = latest;
  renderNav();
  if (latest.access?.singleSite) {
    renderSingleSite(sites[0]);
    return;
  }
  document.querySelector("h1").textContent = "Sites";

  if (!latest.updatedAt && error) {
    main.innerHTML = setupPanel(error);
    return;
  }

  if (error && sites.length === 0) {
    main.innerHTML = `<section class="panel"><h2>Check failed</h2><p>${escapeHtml(error)}</p></section>`;
    return;
  }

  if (sites.length === 0) {
    main.innerHTML = `<section class="panel empty"><h2>No sites</h2><p>UniFi has not returned any sites yet.</p></section>`;
    return;
  }

  const signature = sites.map((site) => `${site.id}:${site.offline}:${site.tone}`).join("|");
  if (signature !== tileSignature) {
    tileSignature = signature;
    main.innerHTML = `<div class="site-grid">${sites.map(renderTile).join("")}</div>`;
  }
  if (openSiteId) {
    const site = sites.find((item) => item.id === openSiteId);
    if (site) fillDialog(site);
  }
}

let singleSignature = "";

function renderSingleSite(site) {
  const heading = document.querySelector("h1");
  if (!site) {
    heading.textContent = "Site";
    main.innerHTML = `<section class="panel"><h2>Site unavailable</h2><p>The assigned site was not in the latest UniFi check.</p></section>`;
    singleSignature = "missing";
    return;
  }
  heading.textContent = site.name;
  const signature = `${site.id}:${site.offline}:${site.tone}:${(site.warnings || []).map((warning) => `${warning.id}:${warning.reason}`).join("|")}`;
  if (signature === singleSignature) return;
  singleSignature = signature;
  main.innerHTML = `<section class="single-site">${siteDetail(site)}</section>`;
}

function renderTile(site) {
  const label = site.offline === 1 ? "device offline" : "devices offline";
  return `<button type="button" class="site-tile ${site.tone}" data-site-id="${escapeHtml(site.id)}">
    <span class="site-name">${escapeHtml(site.name)}</span>
    <span class="site-count">${site.offline}</span>
    <span class="site-caption">${label}</span>
  </button>`;
}

function siteDetail(site) {
  const facts = [
    ["Console", site.console],
    ["Devices", site.total],
    ["Wi-Fi clients", site.wifiClients],
    ["Timezone", site.timezone],
  ].filter(([, value]) => value != null && value !== "");
  const factList = facts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  const problems = site.warnings || [];
  const body = problems.length
    ? problems.map(renderWarning).join("")
    : `<p class="quiet">No devices are offline at this site.</p>`;
  return `<header class="dialog-head ${site.tone}">
      <p class="eyebrow">Site</p>
      <h2>${escapeHtml(site.name)}</h2>
      <p class="dialog-count">${site.offline} offline</p>
    </header>
    <dl class="metrics dialog-facts">${factList}</dl>
    <div class="dialog-list">${body}</div>`;
}

function fillDialog(site) {
  siteBody.innerHTML = siteDetail(site);
}

function renderWarning(warning) {
  const tone = warning.severity === "offline" ? "offline" : warning.repeated || warning.severity === "repeated" ? "repeated" : "error";
  const metrics = (warning.metrics || [])
    .map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`)
    .join("");
  return `<article class="warning ${tone}">
    <div>
      <div class="kind">${labelFor(warning)}</div>
      <h3 class="device">${escapeHtml(warning.deviceName)}</h3>
      <p class="reason">${escapeHtml(warning.reason)}</p>
    </div>
    <dl class="metrics">${metrics}</dl>
  </article>`;
}

function labelFor(warning) {
  if (warning.severity === "offline") return "Offline";
  if (warning.repeated || warning.severity === "repeated") return "Repeated error";
  return "Error";
}

function setupPanel(error) {
  return `<section class="panel"><h2>Connect UniFi</h2><p>${escapeHtml(error)}</p><ol>
    <li>Sign in at unifi.ui.com and open API.</li>
    <li>Create an API key and copy it once.</li>
    <li>Copy <code>.env.example</code> to <code>.env</code> and set <code>UNIFI_API_KEY</code>.</li>
    <li>Restart <code>node src/server.mjs</code>.</li>
  </ol></section>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function paintStatus() {
  if (!latest) return;
  const { error, updatedAt, demo, pollSeconds, checking } = latest;
  if (checking) {
    status.textContent = "Checking UniFi…";
    return;
  }
  if (error) {
    status.textContent = error;
    return;
  }
  const when = updatedAt ? new Date(updatedAt).toLocaleTimeString() : "not yet";
  const elapsed = updatedAt ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000) : 0;
  const remaining = Math.max(0, (pollSeconds || 0) - elapsed);
  const next = pollSeconds ? ` · next check in ${remaining}s` : "";
  status.textContent = `Last check ${when}${next}${demo ? " · sample data" : ""}`;
}

function render() {
  paintStatus();
  renderSites();
}

const events = new EventSource("/api/events");
events.onmessage = (event) => {
  latest = JSON.parse(event.data);
  if (latest.unauthorized) {
    location.href = "/login";
    return;
  }
  render();
};
setInterval(paintStatus, 1000);