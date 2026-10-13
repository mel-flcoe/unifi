const HEALTHY_STATUS = new Set(["online", "connected", "ready"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hostIdOf(host) {
  return text(host?.id) || text(host?.hostId);
}

function hostConnection(host) {
  const members = host?.userData?.consoleGroupMembers;
  const memberState = Array.isArray(members)
    ? members.map((member) => member?.roleAttributes?.connectedState).find(text)
    : "";
  return (
    text(host?.state) ||
    text(host?.connectionState) ||
    text(host?.reportedState?.state) ||
    text(host?.reportedState?.connectedState) ||
    text(memberState)
  );
}

function isHostOffline(host) {
  const state = hostConnection(host).toLowerCase();
  if (!state) return false;
  return /disconnect|offline/.test(state);
}

function hostLabel(host) {
  return (
    text(host?.name) ||
    text(host?.hostName) ||
    text(host?.reportedState?.name) ||
    text(host?.userData?.fullName) ||
    "Console"
  );
}

function siteLabel(site, fallback) {
  const description = text(site?.meta?.desc);
  const name = text(site?.meta?.name);
  if (description && description.toLowerCase() !== "default") return description;
  if (fallback) return fallback;
  if (name && name.toLowerCase() !== "default") return name;
  return "Unknown network";
}

function siteCounts(site) {
  return site?.statistics?.counts || site?.siteStatistics?.counts || {};
}

function offlineCount(site) {
  return numberOrNull(siteCounts(site).offlineDevice ?? siteCounts(site).offlineDevices);
}

function totalCount(site) {
  return numberOrNull(siteCounts(site).totalDevice ?? siteCounts(site).totalDevices);
}

function isDeviceHealthy(device) {
  const status = text(device?.status).toLowerCase();
  return HEALTHY_STATUS.has(status);
}

function recordIsOffline(record) {
  if ((record?.missingStreak || 0) > 0) return true;
  const status = text(record?.samples?.at(-1)?.status).toLowerCase();
  if (!status || status === "unknown") return false;
  return !HEALTHY_STATUS.has(status);
}

function firmwareProblem(device) {
  return /fail|error/i.test(text(device?.firmwareStatus));
}

function formatUptime(startupTime, now) {
  if (!startupTime) return null;
  const elapsed = new Date(now).getTime() - new Date(startupTime).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function formatWhen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function metric(label, value) {
  if (value == null || value === "") return null;
  return { label, value: String(value) };
}

function metrics(pairs) {
  return pairs.map(([label, value]) => metric(label, value)).filter(Boolean);
}

function packetLossPercent(value) {
  const number = numberOrNull(value);
  if (number == null || number < 0) return null;
  if (number > 0 && number < 1) return number * 100;
  return number;
}

function collectIspSamples(node, context = {}, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) collectIspSamples(item, context, found);
    return found;
  }

  const next = {
    hostId: text(node.hostId) || context.hostId || "",
    siteId: text(node.siteId) || context.siteId || "",
  };
  const loss = packetLossPercent(
    node.packetLoss ?? node.packet_loss ?? node.lossPercentage ?? node.wan?.packetLoss,
  );
  const latency = numberOrNull(
    node.latency ?? node.avgLatency ?? node.latencyAvg ?? node.wan?.avgLatency ?? node.wan?.latency,
  );
  if (loss != null && (next.hostId || next.siteId)) {
    found.push({
      ...next,
      loss,
      latency,
      at: node.timestamp || node.time || node.updatedAt || null,
    });
  }
  for (const value of Object.values(node)) collectIspSamples(value, next, found);
  return found;
}

function latestIspBySite(samples) {
  const byKey = new Map();
  for (const sample of samples) {
    const key = sample.siteId || `host:${sample.hostId}`;
    byKey.set(key, sample);
  }
  return byKey;
}

function trailingProblems(samples) {
  let count = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (!samples[index].problem) break;
    count += 1;
  }
  return count;
}

function streakStart(samples) {
  let start = samples.at(-1)?.at ?? null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (!samples[index].problem) break;
    start = samples[index].at;
  }
  return start;
}

function remember(samples, sample, limit = 48) {
  const next = samples.concat(sample);
  return next.slice(-limit);
}

function deviceRecord(device, network, consoleName, updatedAt, hostId) {
  return {
    name: text(device.name) || text(device.mac) || text(device.id) || "Unnamed device",
    mac: text(device.mac),
    model: text(device.model),
    ip: text(device.ip),
    version: text(device.version),
    firmwareStatus: text(device.firmwareStatus),
    productLine: text(device.productLine),
    startupTime: device.startupTime || null,
    note: text(device.note),
    network,
    console: consoleName,
    hostId: hostId || "",
    siteId: "",
    updatedAt: updatedAt || null,
    samples: [],
    missingStreak: 0,
  };
}

function warningFromDevice(record, now, reason, severity, repeatThreshold) {
  const consecutive = trailingProblems(record.samples);
  const uptime = formatUptime(record.startupTime, now);
  return {
    id: `device:${record.id}`,
    severity,
    repeated: consecutive >= repeatThreshold,
    network: record.network,
    console: record.console,
    siteId: record.siteId || "",
    hostId: record.hostId || "",
    deviceName: record.name,
    reason,
    since: streakStart(record.samples),
    consecutive,
    metrics: metrics([
      ["Model", record.model],
      ["IP address", record.ip],
      ["MAC address", record.mac],
      ["Firmware", record.version],
      ["Firmware status", record.firmwareStatus],
      ["Uptime", uptime],
      ["Product", record.productLine],
      ["Last reported", formatWhen(record.updatedAt)],
      ["Checks in a row", consecutive > 0 ? String(consecutive) : null],
      ["Note", record.note],
    ]),
  };
}

export function evaluate({
  hosts = [],
  sites = [],
  deviceGroups = [],
  isp = null,
  history = {},
  now = new Date().toISOString(),
  repeatThreshold = 2,
  packetLossLimit = 2,
}) {
  const previous = {
    seeded: Boolean(history.seeded),
    devices: { ...(history.devices || {}) },
    isp: { ...(history.isp || {}) },
  };
  const nextDevices = {};
  const warnings = [];
  const seenIds = new Set();

  const hostsById = new Map();
  for (const host of hosts) {
    const id = hostIdOf(host);
    if (id) hostsById.set(id, host);
  }

  const sitesByHost = new Map();
  const sitesById = new Map();
  for (const site of sites) {
    const id = text(site.siteId) || text(site.id);
    if (id) sitesById.set(id, site);
    const hostKey = text(site.hostId);
    if (!hostKey) continue;
    const list = sitesByHost.get(hostKey) || [];
    list.push(site);
    sitesByHost.set(hostKey, list);
  }

  const siteKey = (site) => text(site?.siteId) || text(site?.id);

  const siteForDevice = (hostKey, device) => {
    const hostSites = sitesByHost.get(hostKey) || [];
    if (hostSites.length === 1) return hostSites[0];
    const mac = text(device?.mac).toLowerCase().replace(/[^a-f0-9]/g, "");
    return (
      hostSites.find((site) => {
        const gateway = text(site?.meta?.gatewayMac).toLowerCase().replace(/[^a-f0-9]/g, "");
        return gateway && gateway === mac;
      }) || null
    );
  };

  const networkForHost = (hostKey, hostName) => {
    const hostSites = sitesByHost.get(hostKey) || [];
    if (hostSites.length === 1) return siteLabel(hostSites[0], hostName);
    return hostName || "Unknown network";
  };

  const networkForDevice = (device, hostKey, hostName) => {
    const hostSites = sitesByHost.get(hostKey) || [];
    if (hostSites.length === 1) return siteLabel(hostSites[0], hostName);
    const mac = text(device.mac).toLowerCase().replace(/[^a-f0-9]/g, "");
    const match = hostSites.find((site) => {
      const gateway = text(site?.meta?.gatewayMac).toLowerCase().replace(/[^a-f0-9]/g, "");
      return gateway && gateway === mac;
    });
    if (match) return siteLabel(match, hostName);
    return hostName || "Unknown network";
  };

  for (const host of hosts) {
    if (!isHostOffline(host)) continue;
    const id = hostIdOf(host);
    const consoleName = hostLabel(host);
    const hostSites = id ? sitesByHost.get(id) || [] : [];
    const network = hostSites.length
      ? hostSites.map((site) => siteLabel(site, consoleName)).join(", ")
      : consoleName;
    warnings.push({
      id: `host:${id || consoleName}`,
      severity: "offline",
      repeated: false,
      network,
      console: consoleName,
      deviceName: consoleName,
      siteId: hostSites.length === 1 ? siteKey(hostSites[0]) : "",
      hostId: id || "",
      reason: "Console is offline",
      since: host.lastConnectionStateChange || null,
      consecutive: null,
      metrics: metrics([
        ["Console", consoleName],
        ["IP address", host.ipAddress || host.ip],
        ["State", hostConnection(host)],
        ["Last state change", formatWhen(host.lastConnectionStateChange)],
      ]),
    });
  }

  const namedOfflineByHost = new Map();
  let devicesChecked = 0;
  let seenProblems = 0;

  for (const group of deviceGroups) {
    const hostKey = text(group.hostId);
    const host = hostsById.get(hostKey);
    const consoleName = text(group.hostName) || (host ? hostLabel(host) : "Console");
    const devices = Array.isArray(group.devices) ? group.devices : [];
    for (const device of devices) {
      const id = text(device.id) || text(device.mac);
      if (!id) continue;
      devicesChecked += 1;
      seenIds.add(id);
      const network = networkForDevice(device, hostKey, consoleName);
      const siteId = siteKey(siteForDevice(hostKey, device));
      const prior = previous.devices[id] || deviceRecord(device, network, consoleName, group.updatedAt, hostKey);
      const offline = text(device.status) !== "" && !isDeviceHealthy(device);
      const firmware = !offline && firmwareProblem(device);
      const problem = offline || firmware;
      const record = {
        ...deviceRecord(device, network, consoleName, group.updatedAt, hostKey),
        id,
        siteId: siteId || prior.siteId || "",
        samples: remember(prior.samples || [], {
          at: now,
          status: text(device.status) || "unknown",
          problem,
        }),
        missingStreak: 0,
      };
      nextDevices[id] = record;
      if (!problem) continue;
      seenProblems += 1;
      if (offline) namedOfflineByHost.set(hostKey, (namedOfflineByHost.get(hostKey) || 0) + 1);
      const consecutive = trailingProblems(record.samples);
      const repeatedError = firmware && consecutive >= repeatThreshold;
      if (offline) {
        warnings.push(
          warningFromDevice(
            record,
            now,
            consecutive >= repeatThreshold ? "Offline on repeated checks" : "Offline",
            "offline",
            repeatThreshold,
          ),
        );
      } else if (firmware) {
        warnings.push(
        warningFromDevice(
          record,
          now,
          repeatedError ? "Firmware error on repeated checks" : "Firmware error",
          repeatedError ? "repeated" : "error",
          repeatThreshold,
        ),
        );
      }
    }
  }

  const emptyDeviceList = deviceGroups.length === 0 && Object.keys(previous.devices).length > 0;
  if (emptyDeviceList) {
    warnings.push({
      id: "feed:empty",
      severity: "offline",
      repeated: false,
      network: "All networks",
      console: "",
      deviceName: "Device list",
      reason: "UniFi returned no devices",
      since: now,
      consecutive: null,
      metrics: metrics([["Previously known devices", String(Object.keys(previous.devices).length)]]),
    });
    Object.assign(nextDevices, previous.devices);
  } else if (previous.seeded) {
    for (const [id, prior] of Object.entries(previous.devices)) {
      if (seenIds.has(id)) continue;
      const record = {
        ...prior,
        id,
        hostId: prior.hostId || "",
        siteId: prior.siteId || "",
        missingStreak: (prior.missingStreak || 0) + 1,
        samples: remember(prior.samples || [], { at: now, status: "missing", problem: true }),
      };
      nextDevices[id] = record;
      warnings.push(
        warningFromDevice(
          record,
          now,
          "Offline — no longer reported by UniFi",
          "offline",
          repeatThreshold,
        ),
      );
    }
  }

  for (const site of sites) {
    const reported = offlineCount(site);
    if (reported == null || reported <= 0) continue;
    const hostKey = text(site.hostId);
    const host = hostsById.get(hostKey);
    const consoleName = host ? hostLabel(host) : "Console";
    const named = namedOfflineByHost.get(hostKey) || 0;
    const missing = Object.values(nextDevices).filter(
      (record) => record.hostId === hostKey && record.missingStreak > 0,
    ).length;
    const accounted = named + missing;
    const hostSiteCount = (sitesByHost.get(hostKey) || []).length;
    if (hostSiteCount > 1) continue;
    if (accounted >= reported) continue;
    const unnamed = reported - accounted;
    warnings.push({
      id: `site-gap:${text(site.siteId) || hostKey}`,
      severity: "offline",
      repeated: false,
      network: siteLabel(site, consoleName),
      console: consoleName,
      deviceName: `${unnamed} unnamed device${unnamed === 1 ? "" : "s"}`,
      siteId: siteKey(site),
      hostId: hostKey,
      reason: "Site reports more offline devices than the device list",
      since: now,
      consecutive: null,
      metrics: metrics([
        ["Offline devices reported", String(reported)],
        ["Offline devices named", String(accounted)],
        ["Devices at site", totalCount(site) == null ? null : String(totalCount(site))],
        ["Wi-Fi clients", numberOrNull(siteCounts(site).wifiClient) == null ? null : String(siteCounts(site).wifiClient)],
      ]),
    });
  }

  const ispSamples = latestIspBySite(collectIspSamples(isp));
  const nextIsp = {};
  for (const [key, sample] of ispSamples) {
    const site = sitesById.get(sample.siteId);
    const host = hostsById.get(sample.hostId);
    const consoleName = host ? hostLabel(host) : "Console";
    const network = site ? siteLabel(site, consoleName) : networkForHost(sample.hostId, consoleName);
    const priorSamples = previous.isp[key]?.samples || [];
    const samples = remember(priorSamples, {
      at: now,
      loss: sample.loss,
      latency: sample.latency,
      problem: sample.loss >= packetLossLimit,
    });
    nextIsp[key] = { samples };
    const consecutive = trailingProblems(samples);
    if (consecutive < repeatThreshold) continue;
    const latest = samples.at(-1);
    warnings.push({
      id: `isp:${key}`,
      severity: "repeated",
      repeated: true,
      network,
      console: consoleName,
      deviceName: "Internet uplink",
      siteId: sample.siteId || "",
      hostId: sample.hostId || "",
      reason: "Repeated packet loss",
      since: streakStart(samples),
      consecutive,
      metrics: metrics([
        ["Packet loss", `${latest.loss.toFixed(1)}%`],
        ["Latency", latest.latency == null ? null : `${Math.round(latest.latency)} ms`],
        ["Checks in a row", String(consecutive)],
        ["Loss limit", `${packetLossLimit}%`],
      ]),
    });
  }

  const severityRank = { offline: 0, error: 1, repeated: 2 };
  warnings.sort((a, b) => {
    const rank = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
    if (rank !== 0) return rank;
    return `${a.network} ${a.deviceName}`.localeCompare(`${b.network} ${b.deviceName}`);
  });

  const siteTiles = sites.map((site) => {
    const id = siteKey(site);
    const hostKey = text(site.hostId);
    const host = hostsById.get(hostKey);
    const consoleName = host ? hostLabel(host) : "";
    const name = siteLabel(site, consoleName || "Unknown network");
    const singleSite = (sitesByHost.get(hostKey) || []).length <= 1;
    let detected = 0;
    for (const record of Object.values(nextDevices)) {
      const onSite = record.siteId
        ? record.siteId === id
        : singleSite && record.hostId === hostKey;
      if (onSite && recordIsOffline(record)) detected += 1;
    }
    const reported = offlineCount(site);
    const offline = Math.max(reported ?? 0, detected);
    const details = warnings.filter((warning) => {
      if (warning.siteId && warning.siteId === id) return true;
      if (warning.hostId === hostKey && warning.id === `host:${hostKey}`) return true;
      return !warning.siteId && singleSite && warning.hostId === hostKey;
    });
    return {
      id: id || hostKey || name,
      name,
      console: consoleName,
      offline,
      total: totalCount(site),
      wifiClients: numberOrNull(siteCounts(site).wifiClient),
      timezone: text(site?.meta?.timezone) || null,
      tone: offline <= 0 ? "clear" : offline === 1 ? "watch" : "alert",
      warnings: details,
    };
  });
  siteTiles.sort((a, b) => a.name.localeCompare(b.name));

  return {
    now,
    sites: siteTiles,
    warnings,
    summary: {
      networks: new Set(sites.map((site) => text(site.hostId)).filter(Boolean)).size || sites.length,
      devicesChecked,
      healthy: Math.max(0, devicesChecked - seenProblems),
      warnings: warnings.length,
      offline: warnings.filter((warning) => warning.severity === "offline").length,
      repeated: warnings.filter((warning) => warning.severity === "repeated" || warning.repeated).length,
    },
    history: {
      seeded: true,
      devices: nextDevices,
      isp: nextIsp,
    },
  };
}
