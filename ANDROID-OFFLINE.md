# 📶 SwiftDrop — phone‑to‑phone sharing with NO internet (Android)

Connect two phones on the **same WiFi or a phone hotspot** and transfer files
device‑to‑device. **No cloud, no Render, no internet, no accounts.**

> **Bluetooth note:** browsers cannot transfer files over Bluetooth (Web Bluetooth
> is only for accessories like headphones). Xender itself uses **WiFi/hotspot TCP**
> — this guide does the same.

## How it works

One Android phone (the **host**) runs a tiny file that serves the app over your
WiFi/hotspot. The other phone opens one link and they're paired. Files then flow
**directly between the phones** over WebRTC — at hotspot/WiFi speed.

## Step 1 — install Termux (one time, needs internet for this step only)

1. Install **[Termux](https://f-droid.org/packages/com.termux.termuxapp/)** from
   F‑Droid (the Play version is outdated).
2. Open Termux and run:
   ```
   termux-setup-storage
   pkg update -y
   pkg install -y nodejs-lts
   ```
   (This needs an internet connection *once* to download Node ~20 MB.)

## Step 2 — put the app file on the phone

On your computer, build the self‑contained server file:

```
node tools/bundle-offline.js
```

Which creates **`offline-server.js`** — the *entire* app in one file
(~260 KB). Get it onto the phone any way you like:
- copy from PC over USB cable, or
- send it to yourself over WhatsApp / email and "Save to files".

Then in Termux:

```
cd ~
cp /sdcard/Download/offline-server.js .   # adjust path if you saved it elsewhere
```

## Step 3 — host from your phone

Turn **ON your phone's hotspot** (or join the same WiFi as the other phone).
In Termux run:

```
bash host.sh
```

(or simply `node offline-server.js`)

You'll see the address printed, e.g. `Network: http://192.168.43.17:3000`.

## Step 4 — pair & send

1. On the **other phone** (or your second device), open that `http://192.168.x.x:3000`
   link in Chrome.
2. On one device press **Create a Room**, on the other press **Join** and enter the
   6‑letter code — or use the invite link / QR.
3. Tap the big **＋** box, pick photos/videos/audio, and send. Done.

No internet connection is needed on either phone — it all runs over your hotspot/WiFi.

---

## Windows / Mac / Linux alternative

If you have a laptop on the same network, you don't need Android at all:
`node offline-server.js` (or `node server.js`) on the laptop, then both phones open
`http://<laptop-ip>:3000`.

## Troubleshooting

- **Other phone can't open the page** → both devices must be on the **same network**;
  make sure your phone's hotspot is ON and the other phone is connected to *it*.
- **Windows firewall blocks it** → allow node / port 3000; on Android you may need
  to accept the "Allow this USB/network device?" prompt or disable AP isolation
  on the router.
- **Phones can't find each other after opening the page** → both are already on the
  same server; create a room on one, join with the code on the other. If they stay
  "connecting", the built‑in relay still routes through the host phone over WiFi.

## Why a tiny host file is needed

Browsers can't open raw sockets or broadcast to discover each other — WebRTC always
needs a *signaling* handshake. Running one small file on your own hotspot-connected
device provides that handshake **locally**; the actual file bytes still travel
directly between the phones (P2P when possible, or through the local relay) — nothing
leaves your network.