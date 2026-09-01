#!/data/data/com.termux/files/usr/bin/bash
# SwiftDrop offline host — Android (Termux)
# Turns THIS phone into the local server.
#  1. Put the other phone on this phone's hotspot (or the same WiFi).
#  2. Run:  bash host.sh
#  3. Open the printed http://192.168.x.x:3000 link on the other phone.
# No internet needed (Node only needs installing once — see ANDROID-OFFLINE.md).

set -e

if ! command -v node >/dev/null 2>&1; then
  echo ">> Installing Node.js (one-time, needs internet for this step)..."
  pkg update -y && pkg install -y nodejs-lts
fi

if [ ! -f offline-server.js ]; then
  echo ">> offline-server.js not found in this folder."
  echo "   Copy it here first (see ANDROID-OFFLINE.md)," 
  echo "   or run \"node server.js\" from a full SwiftDrop project folder."
  exit 1
fi

echo ""
echo ">> Starting SwiftDrop… keep this screen on."
echo "   Other phone: connect to this phone's hotspot/WiFi,"
echo "   then open the Network address printed below."
echo ""
node offline-server.js