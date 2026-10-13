# UniFi warnings

A local dashboard for UniFi sites. It asks the [UniFi Site Manager API](https://developer.ui.com/site-manager-api/) for every console, site, and device, then shows only what needs attention:

- devices and consoles that are offline
- devices UniFi stopped reporting after they had been seen
- sites whose offline count is higher than the named device list
- firmware failures and WAN packet loss that persist across consecutive checks

Healthy devices stay off the page. Each warning includes the network, the device name, and the metrics the API provides: model, IP, MAC, firmware, uptime, and how many checks the problem has lasted.

## Run

Install Node.js 22 or newer, then from this folder:

```powershell
Copy-Item .env.example .env
```

Put your API key in `.env`. Create that key at [unifi.ui.com](https://unifi.ui.com) under **API**. The key is read-only and is only shown once.

```powershell
node src/server.mjs
```

Open http://127.0.0.1:8787

To preview the warning layout without an API key:

```powershell
$env:UNIFI_DEMO = "1"
node src/server.mjs
```

## Checks

```powershell
node --test
```

History of recent checks is stored in `data/history.json` so a problem can be marked repeated after `REPEAT_THRESHOLD` polls. That file is local and is not committed.
