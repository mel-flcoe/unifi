import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./evaluate.mjs";

const now = "2026-10-13T20:00:00.000Z";

function device(overrides) {
  return {
    id: "ap-1",
    mac: "aa:bb:cc:dd:ee:01",
    name: "AP-Lobby",
    model: "U6 Pro",
    ip: "10.4.0.20",
    productLine: "network",
    status: "online",
    version: "6.6.77",
    firmwareStatus: "upToDate",
    startupTime: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    now,
    repeatThreshold: 2,
    packetLossLimit: 2,
    hosts: [{ id: "host-1", name: "Plant Console", state: "connected", ipAddress: "10.4.0.1" }],
    sites: [
      {
        siteId: "site-1",
        hostId: "host-1",
        meta: { desc: "North Plant", name: "default" },
        statistics: { counts: { totalDevice: 2, offlineDevice: 0, wifiClient: 8 } },
      },
    ],
    deviceGroups: [
      {
        hostId: "host-1",
        hostName: "Plant Console",
        updatedAt: now,
        devices: [device(), device({ id: "sw-1", name: "SW-Core", status: "online" })],
      },
    ],
    history: { seeded: false, devices: {}, isp: {} },
    ...overrides,
  };
}

test("colors each site tile from how many devices are offline", () => {
  const result = evaluate(
    input({
      hosts: [
        { id: "host-clear", name: "East Console", state: "connected" },
        { id: "host-watch", name: "West Console", state: "connected" },
        { id: "host-alert", name: "North Console", state: "connected" },
      ],
      sites: [
        {
          siteId: "site-clear",
          hostId: "host-clear",
          meta: { desc: "East Yard", name: "default" },
          statistics: { counts: { totalDevice: 1, offlineDevice: 0, wifiClient: 2 } },
        },
        {
          siteId: "site-watch",
          hostId: "host-watch",
          meta: { desc: "West Gate", name: "default" },
          statistics: { counts: { totalDevice: 2, offlineDevice: 1, wifiClient: 1 } },
        },
        {
          siteId: "site-alert",
          hostId: "host-alert",
          meta: { desc: "North Plant", name: "default" },
          statistics: { counts: { totalDevice: 4, offlineDevice: 3, wifiClient: 8 } },
        },
      ],
      deviceGroups: [
        {
          hostId: "host-clear",
          hostName: "East Console",
          updatedAt: now,
          devices: [device({ id: "ok", name: "SW-East" })],
        },
        {
          hostId: "host-watch",
          hostName: "West Console",
          updatedAt: now,
          devices: [device({ id: "gate", name: "AP-Gate", status: "offline", ip: "10.8.0.9" })],
        },
        {
          hostId: "host-alert",
          hostName: "North Console",
          updatedAt: now,
          devices: [device({ id: "boiler", name: "AP-Boiler", status: "offline" })],
        },
      ],
    }),
  );

  const byName = Object.fromEntries(result.sites.map((site) => [site.name, site]));
  assert.equal(byName["East Yard"].offline, 0);
  assert.equal(byName["East Yard"].tone, "clear");
  assert.equal(byName["West Gate"].offline, 1);
  assert.equal(byName["West Gate"].tone, "watch");
  assert.equal(byName["West Gate"].warnings.some((warning) => warning.deviceName === "AP-Gate"), true);
  assert.equal(byName["North Plant"].offline, 3);
  assert.equal(byName["North Plant"].tone, "alert");
});

test("hides healthy devices and names the network on an offline device", () => {
  const result = evaluate(
    input({
      sites: [
        {
          siteId: "site-1",
          hostId: "host-1",
          meta: { desc: "North Plant", name: "default" },
          statistics: { counts: { totalDevice: 2, offlineDevice: 1, wifiClient: 8 } },
        },
      ],
      deviceGroups: [
        {
          hostId: "host-1",
          hostName: "Plant Console",
          updatedAt: now,
          devices: [device({ status: "offline" }), device({ id: "sw-1", name: "SW-Core" })],
        },
      ],
    }),
  );

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].deviceName, "AP-Lobby");
  assert.equal(result.warnings[0].network, "North Plant");
  assert.equal(result.warnings[0].severity, "offline");
  assert.equal(result.summary.healthy, 1);
  assert.ok(result.warnings[0].metrics.some((item) => item.label === "IP address" && item.value === "10.4.0.20"));
  assert.ok(result.warnings[0].metrics.some((item) => item.label === "Model" && item.value === "U6 Pro"));
});

test("uses the console name when the site is still called Default", () => {
  const result = evaluate(
    input({
      sites: [
        {
          siteId: "site-1",
          hostId: "host-1",
          meta: { desc: "Default", name: "default" },
          statistics: { counts: { offlineDevice: 1 } },
        },
      ],
      deviceGroups: [
        {
          hostId: "host-1",
          hostName: "Plant Console",
          updatedAt: now,
          devices: [device({ status: "offline" })],
        },
      ],
    }),
  );
  assert.equal(result.warnings[0].network, "Plant Console");
});

test("treats a device that disappears after the first poll as offline", () => {
  const first = evaluate(input());
  const second = evaluate(
    input({
      history: first.history,
      now: "2026-10-13T20:01:00.000Z",
      deviceGroups: [
        {
          hostId: "host-1",
          hostName: "Plant Console",
          updatedAt: now,
          devices: [device({ id: "sw-1", name: "SW-Core" })],
        },
      ],
    }),
  );
  const missing = second.warnings.find((warning) => warning.deviceName === "AP-Lobby");
  assert.ok(missing);
  assert.match(missing.reason, /no longer reported/);
  assert.equal(second.summary.healthy, 1);
});

test("does not invent missing devices on the first poll", () => {
  const result = evaluate(
    input({
      history: {
        seeded: false,
        devices: {
          ghost: { id: "ghost", name: "Ghost", samples: [], network: "North Plant", console: "Plant Console" },
        },
        isp: {},
      },
    }),
  );
  assert.equal(result.warnings.some((warning) => warning.deviceName === "Ghost"), false);
});

test("marks a firmware failure as repeated only after consecutive checks", () => {
  const first = evaluate(
    input({
      deviceGroups: [
        {
          hostId: "host-1",
          hostName: "Plant Console",
          updatedAt: now,
          devices: [device({ firmwareStatus: "updateFailed" })],
        },
      ],
    }),
  );
  assert.equal(first.warnings[0].severity, "error");
  assert.equal(first.warnings[0].repeated, false);

  const second = evaluate(
    input({
      history: first.history,
      now: "2026-10-13T20:01:00.000Z",
      deviceGroups: [
        {
          hostId: "host-1",
          hostName: "Plant Console",
          updatedAt: now,
          devices: [device({ firmwareStatus: "updateFailed" })],
        },
      ],
    }),
  );
  assert.equal(second.warnings[0].severity, "repeated");
  assert.match(second.warnings[0].reason, /repeated/);
});

test("warns when a console is disconnected", () => {
  const result = evaluate(
    input({
      hosts: [{ id: "host-1", name: "Plant Console", state: "disconnected", ipAddress: "10.4.0.1" }],
    }),
  );
  assert.equal(result.warnings[0].deviceName, "Plant Console");
  assert.equal(result.warnings[0].reason, "Console is offline");
});

test("warns when the site count includes offline devices the list did not name", () => {
  const result = evaluate(
    input({
      sites: [
        {
          siteId: "site-1",
          hostId: "host-1",
          meta: { desc: "North Plant", name: "default" },
          statistics: { counts: { totalDevice: 5, offlineDevice: 3, wifiClient: 4 } },
        },
      ],
    }),
  );
  const gap = result.warnings.find((warning) => warning.id.startsWith("site-gap:"));
  assert.ok(gap);
  assert.equal(gap.network, "North Plant");
  assert.match(gap.deviceName, /3 unnamed/);
});

test("raises repeated packet loss only after it persists", () => {
  const isp = { data: [{ hostId: "host-1", siteId: "site-1", packetLoss: 8, latency: 90 }] };
  const first = evaluate(input({ isp }));
  assert.equal(first.warnings.some((warning) => warning.id.startsWith("isp:")), false);
  const second = evaluate(input({ isp, history: first.history, now: "2026-10-13T20:01:00.000Z" }));
  const warning = second.warnings.find((warning) => warning.id.startsWith("isp:"));
  assert.ok(warning);
  assert.equal(warning.network, "North Plant");
  assert.equal(warning.deviceName, "Internet uplink");
  assert.match(warning.metrics.find((item) => item.label === "Packet loss").value, /8\.0%/);
});
