# ⚡ SwiftDrop

A **Xender-style** file sharing web app. Send files, videos, audio and anything else
**directly between two phones (or any devices)** — as long as both have the page open
and are paired with a room code.

Unlike classic upload-based sharing, data flows **peer-to-peer** over WebRTC, so it's
extremely fast on the same Wi-Fi network and doesn't burn through a server's bandwidth.

![how](https://img.shields.io/badge/P2P-WebRTC-ff7a18)
![deps](https://img.shields.io/badge/dependencies-ZERO-brightgreen)

## Features

- 📡 **Direct device-to-device transfer** via WebRTC DataChannels (nothing stored on the server)
- 🛟 **Automatic relay fallback** through the WebSocket server when strict NATs block P2P
- 🔢 **6-character room code** + **QR code** for painless pairing
- 🖼️ Sends photos, videos, audio, documents, APKs — any file
- 📊 Live progress bars, per-transfer and aggregate **speed (MB/s)**
- 📁 Drag & drop, tap-to-browse, clipboard/paste support, multi-file sending
- 📲 Mobile-first installable PWA (service worker + manifest)
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

Push this folder to any Node host (Render, Railway, Fly, Heroku, a VPS…) and run
`node server.js` with `PORT` set. HTTPS is ideal — WebRTC works best in a secure
context, and the PWA becomes installable.

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