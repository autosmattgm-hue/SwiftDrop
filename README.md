# ⚡ SwiftDrop

A **Xender-style** file sharing web app. Send files, videos, audio and anything else
**directly between two phones (or any devices)** — as long as both have the page open
and are paired with a room code.

Unlike classic upload-based sharing, data flows **peer-to-peer** over WebRTC, so it's
extremely fast and doesn't burn through a server's bandwidth.

![how](https://img.shields.io/badge/P2P-WebRTC-ff7a18)
![deps](https://img.shields.io/badge/dependencies-ZERO-brightgreen)

## Features

- 📡 **Direct device-to-device transfer** via WebRTC DataChannels (nothing stored on the server)
- 🛟 **Automatic relay fallback** through the WebSocket server when NATs block P2P
- 🔢 **6-character room code** + **QR code** + **one-tap invite link** (deep-link auto-join)
- 🖼️ Sends photos, videos, audio, documents, APKs — any file
- 📊 Live progress bars, per-transfer and aggregate **speed (MB/s)**
- 📁 Drag & drop, tap-to-browse, clipboard/paste support, multi-file sending
- 📲 Mobile-first installable PWA (service worker + manifest)
- 🌍 **Built for public hosting** — gzip, security headers, `/api/health`, env-configurable TURN, fair-use relay caps
- 👤 Editable device names shown to peers

## Run it

**Requires Node.js 18+ (no npm install needed).**

```bash
node server.js
```

Then open the printed URL — e.g. `http://localhost:3000` — on **both** devices.

1. On device A press **Create a Room** → you get a 6-letter code + QR.
2. On device B press **Join** and type the code (or scan the QR).
3. Both devices are now connected — add files on either side and hit send.

## Tests

```bash
node test.js          # server end-to-end (rooms, signaling, binary relay, cleanup)
node test-client.js   # client smoke test (loads client.js in a VM with DOM stubs)
node test-qr.js       # vendored QR library generates a real QR matrix
```

### Sharing with phones on the same Wi-Fi

Use the **Network** URL printed by the server (e.g. `http://192.168.1.20:3000`).
Allow Node's port through your firewall if needed. Transfers then travel P2P over your
local Wi-Fi at full speed.

### Deploying online (so any two people anywhere can connect)

> ⚠️ **Do NOT use Vercel / Netlify / GitHub Pages for the live app.** They are
> **static hosts** — they can render the page but **cannot run SwiftDrop's Node
> server**, so the WebSocket ("wss://…Unexpected response code: 200") and `/api/config`
> (404) fail. SwiftDrop needs a host that runs a **persistent Node process**.

The `Procfile` and `PORT` env support work with any Node host — **Render, Railway,
Fly.io, Heroku, Koyeb, a VPS**.

**Fastest: one-click Render (free).** This repo includes `render.yaml`, so just:

1. Push this folder to GitHub.
2. On [render.com](https://render.com) → **New → Blueprint** → pick your repo.
3. Deploy. Done — you get `https://your-app.onrender.com` with an automatic health check.

Or manually: **New → Web Service** → repo → build command `npm install` →
start command `node server.js` → Deploy.

Share the Render URL with everyone — it works over mobile data for *both* phones;
transfers fall back to the built-in relay when P2P can't break through carrier NATs.

> **Keep your Vercel page?** You can leave the page on Vercel and point it at a
> Node server using the **"Server address"** box on the home screen (enter e.g.
> `https://your-app.onrender.com`). Invite links automatically carry the server
> (`#join=CODE&server=…`) so the other phone joins the right backend. For a
> no-friction experience, though, share the Render URL directly — it serves the
> whole app itself.

For **maximum P2P connectivity** (so phones on strict mobile networks connect directly
and use zero relay bandwidth), add a TURN server. Free options exist (e.g.
[Open Relay Project](https://www.metered.ca/tools/openrelay/), a small `coturn` VPS, or
a hosted TURN). Then set env vars (see `.env.example`):

```
TURN_URL=turn:your.turn.host:3478?transport=udp,turn:your.turn.host:3478?transport=tcp
TURN_USERNAME=user
TURN_CREDENTIAL=pass
```

The app fetches these from `/api/config` automatically — no code changes needed.
You can also override the whole ICE list with `ICE_SERVERS_JSON`.

#### Fair use & monitoring
- `/api/health` shows `{ ok, rooms, peers, uptime }`.
- Relayed (server-assisted) transfers are capped at `RELAY_MAX_MB` (default 256 MB)
  per file to protect your bandwidth — **direct P2P transfers are never limited**.
  Senders see a clear error if they hit the cap.
- Rooms hold only connection metadata; file bytes are never stored.

## How it works

| Layer | Technology |
|---|---|
| App server / static files | Node.js `http` (zero dependencies) |
| Signaling + relay | Hand-rolled RFC 6455 WebSocket server |
| Peer-to-peer transport | WebRTC `RTCDataChannel` (DTLS-encrypted) |
| Pairing | Room code + QR deep-link (`#join=CODE`) |
| File transport | 64 KB chunks, `streamId` framed, ordered & reliable |

A deterministic "initiator" rule (larger `peerId` offers) avoids ICE glare; a 12 s
timeout downgrades a stuck peer to the relay transport automatically on both sides.

## Project layout

```
server.js            WebSocket signaling + relay + static server
public/index.html    App shell
public/client.js     WebRTC, transfers, UI
public/styles.css    Styles
public/vendor/qrcode.js   QR generator (vendored, MIT)
public/sw.js         Service worker
public/manifest.json PWA manifest
```

## Notes

- Room codes are case-insensitive and unambiguous (no `0/O/1/I/L`).
- Rooms expire after 24 h idle; connections are encrypted with DTLS.
- Tested with `node server.js`; the server ships its own WebSocket implementation so
  there is genuinely nothing to install.