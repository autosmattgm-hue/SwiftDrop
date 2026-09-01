'use strict';
/* ============================================================
   SwiftDrop client
   Ships files directly between devices using WebRTC DataChannels
   with automatic fallback to the server-relay transport when
   strict NATs block direct peer-to-peer.
   ============================================================ */

/* ---------------- utils ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let uidCounter = 0;
function uid() {
  uidCounter += 1;
  return Date.now().toString(36).slice(-5) + '-' + (uidCounter).toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
function genStreamId() {
  return (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
}

function formatBytes(b) {
  if (!isFinite(b)) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function formatSpeed(bps) {
  if (!isFinite(bps)) return '';
  return formatBytes(bps) + '/s';
}

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif'];
const VID_EXT = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv', '3gp'];
const AUD_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma', 'mid'];
const ARCH_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];

function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function kindOf(name) {
  const e = extOf(name);
  if (IMG_EXT.includes(e)) return 'image';
  if (VID_EXT.includes(e)) return 'video';
  if (AUD_EXT.includes(e)) return 'audio';
  if (ARCH_EXT.includes(e)) return 'arch';
  return 'file';
}
function emojiOf(name) {
  const k = kindOf(name);
  if (k === 'image') return '🖼️';
  if (k === 'video') return '🎬';
  if (k === 'audio') return '🎵';
  if (k === 'arch') return '🗜️';
  const e = extOf(name);
  if (['pdf'].includes(e)) return '📄';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(e)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📊';
  if (['ppt', 'pptx'].includes(e)) return '📽️';
  if (['apk'].includes(e)) return '🤖';
  if (['js', 'html', 'css', 'json', 'py', 'java', 'cpp', 'c', 'ts', 'go', 'rs'].includes(e)) return '💻';
  return '📁';
}
function initialsOf(name) {
  const parts = (name || '?').trim().split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name || '?').slice(0, 2).toUpperCase();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- state ---------------- */
const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }];
let ICE_SERVERS = DEFAULT_ICE;
const CHUNK_SIZE = 64 * 1024;
const RTC_TIMEOUT_MS = 12000;
const CFG = {
  relayMaxMB: 256,       // will be refreshed from /api/config
  maxPeersPerRoom: 10,
  fetched: false,
};

// Pull servers + limits from the deployment so TURN and fair-use rules apply.
function fetchConfig() {
  if (!location || !location.host || location.protocol === 'file:') return;
  fetch(location.protocol + '//' + getSignalingHost() + '/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      CFG.fetched = true;
      if (cfg.rtc && Array.isArray(cfg.rtc.iceServers) && cfg.rtc.iceServers.length) {
        ICE_SERVERS = cfg.rtc.iceServers;
      }
      if (cfg.limits) {
        if (typeof cfg.limits.relayMaxMB === 'number') CFG.relayMaxMB = cfg.limits.relayMaxMB;
        if (typeof cfg.limits.maxPeersPerRoom === 'number') CFG.maxPeersPerRoom = cfg.limits.maxPeersPerRoom;
      }
    })
    .catch(() => { /* defaults are fine */ });
}

const S = {
  ws: null,
  wsReady: false,
  roomId: null,
  peerId: null,
  myName: '',
  peers: new Map(),        // peerId -> Peer
  transfers: new Map(),    // fileId -> sender transfer state
  received: new Map(),     // fileId -> received item (dedup display)
  streamOwner: new Map(),  // streamId -> peerId (for incoming relay data)
  activeSpeedTick: false,
  totalSpeed: 0,
  reconnectT: null,
  leaveFlag: false,
  pendingJoin: null,
  failedHandshake: false,
};

/* ---------------- Peer ---------------- */
class Peer {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'Device';
    this.mode = 'rtc';          // 'rtc' | 'relay'
    this.open = false;
    this.pc = null;
    this.cc = null;             // control channel
    this.dc = null;             // data channel (meta text + binary frames)
    this.pendingIce = [];
    this.connTimer = null;
    this.fallbackDone = false;
    this.destroyed = false;
    this.recv = new Map();      // streamId -> recv state
  }
}

/* ---------------- simple name persistence ---------------- */
function loadName() {
  try { return localStorage.getItem('sd_name') || ''; } catch (e) { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('sd_name', n); } catch (e) { /* noop */ }
}

function myDisplayName() {
  const n = (S.myName || '').trim();
  return n ? n : 'Device ' + Math.floor(Math.random() * 9000 + 1000);
}
/* ============================================================
   WebSocket signaling layer
   ============================================================ */
// Optional custom signaling server (for pages hosted on static hosts
// like Vercel/Netlify that cannot run Node WebSockets). Stored per-device
// and also carried in invite links via #join=…&server=… so the other
// phone joins the right server automatically.
function getSignalingHost() {
  try {
    const saved = localStorage.getItem('sd_server');
    if (saved) {
      const h = String(saved).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (h && h.indexOf('\\') === -1 && h.indexOf('/') === -1) return h;
    }
  } catch (e) { /* noop */ }
  return location.host;
}

function wsUrl() {
  const host = getSignalingHost();
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + host;
}

function ensureWsConnected() {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) return true;
  if (S.ws && S.ws.readyState === WebSocket.CONNECTING) return false;
  if (!S.reconnectT) {
    S.reconnectT = setTimeout(() => { S.reconnectT = null; connectWs(); }, 300);
  }
  return false;
}

function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  ensureWsConnected();
  return false;
}

function wsSendBinary(buf) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(buf);
    return true;
  }
  ensureWsConnected();
  return false;
}

function connectWs() {
  try { if (S.ws) S.ws.close(); } catch (e) { /* noop */ }
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    // e.g. opening the page via file:// -> ws:// with no host
    setHomeState(false, 'Cannot open connection here — open via http://' + (location.host || 'localhost:3000'));
    scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  S.wsReady = false;
  setHomeState(false, 'Connecting…');

  ws.onopen = () => {
    S.wsReady = true;
    clearTimeout(S.reconnectT);
    S.reconnectT = null;
    clearStaticWarning();
    setHomeState(true, 'Connected');
    // Rejoin the room after a reconnect (same peerId so identity survives)
    if (S.roomId) wsSend({ t: 'join', roomId: S.roomId, peerId: S.peerId, name: myDisplayName() });
    // flush any join/create requested before the socket was ready
    if (S.pendingJoin) {
      const pj = S.pendingJoin;
      S.pendingJoin = null;
      wsSend(pj);
    }
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string' || e.data instanceof String) {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleServerMsg(msg);
    } else {
      handleRelayChunk(e.data);
    }
  };
  ws.onclose = () => {
    S.wsReady = false;
    if (S.leaveFlag) return;
    if (S.failedHandshake) {
      setHomeState(false, '⚠ No SwiftDrop server here — static host detected. See the fix below.');
      detectStaticHost();
    } else if (!S.roomId) {
      setHomeState(false, 'Reconnecting…');
    }
    scheduleReconnect();
  };
  ws.onerror = () => { S.failedHandshake = true; try { ws.close(); } catch (e) { /* noop */ } };
}

let staticDetected = false;
let connAttempts = 0;

function detectStaticHost() {
  if (staticDetected && connAttempts <= 3) return; // only nag once during the first attempts
  staticDetected = true;
  const warn = $('#static-warning');
  if (warn) warn.hidden = false;
  if ($('#server-addr') && $('#server-addr').value.trim()) {
    // user already pointed at a custom server — don't nag, just retry
    const st = $('#home-status');
    if (st) st.textContent = 'Connecting to ' + getSignalingHost() + '…';
  } else {
    const st = $('#home-status');
    if (st) st.textContent = '⚠ No SwiftDrop server here — enter a server address above or deploy SwiftDrop to a Node host';
  }
}

function clearStaticWarning() {
  staticDetected = false;
  connAttempts = 0;
  const warn = $('#static-warning');
  if (warn) warn.hidden = true;
}

function reconnectDelay() {
  if (staticDetected) return 8000; // slow down hard when clearly a broken host
  return 1500;
}

function scheduleReconnect() {
  if (S.reconnectT) return;
  // If this is the page's own host and it's clearly not a SwiftDrop server,
  // stop the auto-loop: waiting/retrying can't fix a static host. The user
  // just needs to enter a server address (or use the Node-host URL).
  if (staticDetected && connAttempts >= 2) {
    setHomeState(false, 'Enter a server address above, or deploy SwiftDrop to Render — then press Create.');
    return;
  }
  S.reconnectT = setTimeout(() => {
    S.reconnectT = null;
    S.failedHandshake = false;
    connAttempts += 1;
    connectWs();
  }, reconnectDelay());
}

// Persisted so reconnect loops don't show stale banners.
function setHomeState(ok, text) {
  const el = $('#home-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'home-status ' + (ok ? 'ok' : 'warn');
}

// Show a toast the moment the user acts but the socket isn't ready.
function feedbackIfNotReady() {
  if (S.wsReady) return true;
  if (staticDetected) toast('No server connection — set the server address below or deploy SwiftDrop to a Node host');
  else if (S.failedHandshake) toast('Server unreachable — check the server is running');
  else toast('Connecting… trying again in a moment');
  ensureWsConnected();
  return false;
}

function handleServerMsg(msg) {
  switch (msg.t) {
    case 'created':
      S.roomId = msg.roomId;
      S.peerId = msg.peerId;
      enterRoom();
      break;
    case 'joined':
      S.roomId = msg.roomId;
      S.peerId = msg.peerId;
      clearPeers();
      (msg.peers || []).forEach((p) => addAndConnectPeer(p.id, p.name));
      enterRoom();
      break;
    case 'peer-added':
      if (msg.peer && msg.peer.id !== S.peerId) addAndConnectPeer(msg.peer.id, msg.peer.name);
      break;
    case 'peer-left':
      removePeer(msg.peerId);
      break;
    case 'error':
      if (msg.code === 'NOT_FOUND') {
        if (S.roomId) { toast('Room expired — create a new one'); resetToHome(); }
        else toast('Room code not found');
      } else if (msg.code === 'ROOM_FULL') toast('Room is full');
      else toast('Server error');
      break;
    case 'rtc':
      handleRtcMessage(msg.from, msg.msg);
      break;
    case 'ctrl':
      // Server can notify us about our own streams (e.g. relay fair-use hit)
      if (msg.from === S.peerId) { handleSelfCtrl(msg.msg); break; }
      handleCtrlMessage(msg.from, msg.msg);
      break;
  }
}

function handleRelayChunk(buf) {
  // 9-byte header: streamId:4 seq:4 flags:1 then payload
  const view = new DataView(buf);
  if (buf.byteLength < 9) return;
  const streamId = view.getUint32(0, true);
  const seq = view.getUint32(4, true);
  const flags = view.getUint8(8);
  const payload = buf.slice(9);
  const peerId = S.streamOwner.get(streamId);
  let peer;
  if (peerId && S.peers.has(peerId)) peer = S.peers.get(peerId);
  if (!peer) return;
  feedStreamData(peer, streamId, seq, flags, payload);
}

// Server pushed control about one of OUR outgoing streams (e.g. relay cap hit).
function handleSelfCtrl(msg) {
  if (!msg || msg.kind !== 'relay-lost') return;
  const streamId = Number(msg.streamId);
  for (const tf of S.transfers.values()) {
    for (const st of tf.streams.values()) {
      if (st.streamId === streamId && !st.finished) {
        st.failed = true;
        st.finished = true; // the sending while-loop checks this each iteration
        tf.lastError = msg.reason === 'size' ? 'Too large for relay (server cap ' + CFG.relayMaxMB + ' MB). Devices failed to connect P2P — try a smaller file.' : 'Relay connection lost';
        break;
      }
    }
  }
}
/* ============================================================
   Room lifecycle
   ============================================================ */
function enterRoom() {
  $('#home').hidden = true;
  $('#room').hidden = false;
  $('#room-code').textContent = S.roomId;
  $('#qr-code-text').textContent = S.roomId;
  renderPeers();
  renderStatus();
  updateCounts();
  pushQueuedSends();
}

function leaveRoom() {
  S.leaveFlag = true;
  wsSend({ t: 'leave' });
  for (const p of S.peers.values()) destroyPeer(p);
  S.peers.clear();
  S.roomId = null;
  S.peerId = null;
  S.streamOwner.clear();
  $('#room').hidden = true;
  $('#home').hidden = false;
  setTimeout(() => { S.leaveFlag = false; }, 400);
}

function clearPeers() {
  for (const p of S.peers.values()) destroyPeer(p);
  S.peers.clear();
  S.streamOwner.clear();
}

function addAndConnectPeer(id, name) {
  if (S.peers.has(id)) return;
  const p = new Peer(id, name);
  S.peers.set(id, p);
  createRtc(p);
  renderPeers();
  renderStatus();
  updateCounts();
}

function removePeer(id) {
  const p = S.peers.get(id);
  if (!p) return;
  destroyPeer(p);
  S.peers.delete(id);
  for (const tf of S.transfers.values()) {
    const st = tf.streams && tf.streams.get(id);
    if (st && !st.finished) {
      st.finished = true;
      st.failed = true;
      tf.activeStreams = Math.max(0, tf.activeStreams - 1);
    }
  }
  renderPeers();
  renderStatus();
  updateCounts();
  updateTransferList();
}

function destroyPeer(p) {
  p.destroyed = true;
  clearTimeout(p.connTimer);
  if (p.pc) {
    try { p.pc.onicecandidate = null; p.pc.ondatachannel = null; p.pc.onconnectionstatechange = null; } catch (e) { /* noop */ }
    try { p.pc.close(); } catch (e) { /* noop */ }
    p.pc = null;
  }
  p.cc = null;
  p.dc = null;
  p.recv.clear();
  p.pendingIce = [];
}
/* ============================================================
   WebRTC
   ============================================================ */
function createRtc(p) {
  if (p.destroyed) return;
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  } catch (e) {
    maybeFallback(p);
    return;
  }
  p.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ t: 'rtc', to: p.id, msg: { kind: 'ice', candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'failed' || st === 'disconnected') maybeFallback(p);
    else if (st === 'connected') clearTimeout(p.connTimer);
  };
  pc.ondatachannel = (e) => bindChannel(p, e.channel);

  const iInitiate = (S.peerId || '') > (p.id || ''); // deterministic initiator (no glare)
  if (iInitiate) {
    const cc = pc.createDataChannel('control');
    const dc = pc.createDataChannel('data');
    bindChannel(p, cc);
    bindChannel(p, dc);
    pc.onnegotiationneeded = () => { if (pc && pc.signalingState === 'stable') sendOffer(p); };
    p.connTimer = setTimeout(() => maybeFallback(p), RTC_TIMEOUT_MS);
  } else {
    p.connTimer = setTimeout(() => maybeFallback(p), RTC_TIMEOUT_MS * 1.4);
  }
}

function bindChannel(p, ch) {
  if (p.destroyed) return;
  const label = ch.label || '';
  ch.binaryType = 'arraybuffer';
  ch.onopen = () => {
    if (!p.open) {
      p.open = true;
      clearTimeout(p.connTimer);
      onPeerOpen(p);
    }
  };
  ch.onmessage = (e) => {
    if (label === 'control') {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      onPeerCtrl(p, msg);
    } else {
      onPeerData(p, e.data);
    }
  };
  ch.onclose = () => { if (p.open && p.mode === 'rtc') maybeFallback(p); };
  ch.onerror = () => { /* handled via close */ };
  if (label === 'control') p.cc = ch;
  else p.dc = ch;
}

async function sendOffer(p) {
  if (!p.pc || p.pc.signalingState === 'closed') return;
  try {
    const offer = await p.pc.createOffer();
    if (p.pc.signalingState !== 'stable') return;
    await p.pc.setLocalDescription(offer);
    const sdp = p.pc.localDescription;
    if (p.destroyed) return;
    wsSend({ t: 'rtc', to: p.id, msg: { kind: 'offer', sdp: { type: sdp.type, sdp: sdp.sdp } } });
  } catch (e) {
    maybeFallback(p);
  }
}

/* -------- fallback to server relay -------- */
function maybeFallback(p) {
  if (p.destroyed || p.mode !== 'rtc' || p.fallbackDone) return;
  p.fallbackDone = true;
  clearTimeout(p.connTimer);
  if ((S.peerId || '') <= (p.id || '')) return; // only initiator decides
  switchToRelay(p);
}

function switchToRelay(p) {
  if (p.destroyed) return;
  const wasRtc = p.mode === 'rtc';
  p.mode = 'relay';
  clearTimeout(p.connTimer);
  destroyPeer(p);
  p.destroyed = false;
  p.pc = null;
  p.cc = null;
  p.dc = null;
  p.fallbackDone = true;
  if (wasRtc && p.open) sendCtrl(p, { kind: 'sw-relay' });
  if (!p.open) {
    p.open = true;
    onPeerOpen(p);
  }
  renderPeers();
  renderStatus();
}

function onPeerOpen(p) {
  renderPeers();
  renderStatus();
  updateCounts();
  pushQueuedSends();
}

/* -------- low level send helpers -------- */
function sendCtrl(p, msg) {
  if (p.mode === 'rtc') {
    if (p.cc && p.cc.readyState === 'open') { p.cc.send(JSON.stringify(msg)); return true; }
    return false;
  }
  return wsSend({ t: 'ctrl', to: p.id, msg });
}

function sendMeta(p, msg) {
  // file meta always travels on the same ordered path as its chunks
  if (p.mode === 'rtc') {
    if (p.dc && p.dc.readyState === 'open') { p.dc.send(JSON.stringify(msg)); return true; }
    return false;
  }
  return wsSend({ t: 'ctrl', to: p.id, msg });
}

function routeStream(p, streamId, fileId, remove) {
  if (p.mode !== 'relay') return;
  wsSend({ t: 'route', to: p.id, streamId, remove: !!remove });
}

function handleRtcMessage(from, msg) {
  const p = S.peers.get(from);
  if (!p || p.destroyed || p.mode !== 'rtc') return;
  if (!p.pc) { maybeFallback(p); return; }

  if (msg.kind === 'offer') {
    if (p.pc.signalingState !== 'stable' && p.pc.signalingState !== 'have-remote-offer') return;
    p.pc.setRemoteDescription(msg.sdp)
      .then(async () => {
        const ans = await p.pc.createAnswer();
        if (!p.destroyed) {
          await p.pc.setLocalDescription(ans);
          const sdp = p.pc.localDescription;
          wsSend({ t: 'rtc', to: from, msg: { kind: 'answer', sdp: { type: sdp.type, sdp: sdp.sdp } } });
          flushIce(p);
        }
      })
      .catch(() => maybeFallback(p));
  } else if (msg.kind === 'answer') {
    p.pc.setRemoteDescription(msg.sdp)
      .then(() => flushIce(p))
      .catch(() => { /* glare etc. */ });
  } else if (msg.kind === 'ice') {
    if (p.pc.remoteDescription && p.pc.signalingState !== 'closed') {
      p.pc.addIceCandidate(msg.candidate).catch(() => { /* noop */ });
    } else {
      p.pendingIce.push(msg.candidate);
    }
  }
}

function flushIce(p) {
  if (!p.pc) return;
  for (const c of p.pendingIce.splice(0)) {
    try { p.pc.addIceCandidate(c).catch(() => { /* noop */ }); } catch (e) { /* noop */ }
  }
}
/* ============================================================
   Sending files
   ============================================================ */
function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!S.roomId) {
    toast('Create or join a room first');
    return;
  }
  for (const file of files) {
    const id = uid();
    const tf = {
      id,
      file,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      status: 'waiting',       // waiting | sending | done | failed | cancelled
      streams: new Map(),      // peerId -> stream state
      startedPeers: new Set(),
      activeStreams: 0,
      acked: new Set(),
      aborted: false,
      sentBytes: 0,
      totalBytes: 0,
      lastBytes: 0,
      lastTs: 0,
      speed: 0,
      el: null,
    };
    S.transfers.set(id, tf);
    appendTransferEl(tf);
  }
  updateCounts();
  pushQueuedSends();
}

function activePeers() {
  return Array.from(S.peers.values()).filter((p) => p.open);
}

function pushQueuedSends() {
  if (!S.roomId) return;
  for (const tf of S.transfers.values()) {
    if (tf.aborted || tf.status === 'done' || tf.status === 'failed' || tf.status === 'cancelled') continue;
    for (const p of activePeers()) {
      if (tf.startedPeers.has(p.id)) continue;
      tf.startedPeers.add(p.id);
      startStream(tf, p);
    }
    if (tf.status === 'waiting') tf.status = 'sending';
    if (tf.activeStreams === 0 && tf.startedPeers.size === 0) tf.status = 'waiting';
  }
  updateTransferList();
  ensureSpeedTick();
  updateCounts();
}

async function startStream(tf, p) {
  const streamId = genStreamId();
  const st = {
    streamId,
    peer: p,
    bytesSent: 0,
    seq: 0,
    finished: false,
    failed: false,
    tsStart: Date.now(),
  };
  tf.streams.set(p.id, st);
  tf.activeStreams += 1;
  tf.totalBytes = tf.size * tf.startedPeers.size;
  updateTransferList();

  try {
    // Pre-flight guard: relayed traffic respects the server fair-use cap.
    if (p.mode === 'relay' && tf.size > CFG.relayMaxMB * 1024 * 1024) {
      st.failed = true;
      tf.lastError = 'Too large for relay (server cap ' + CFG.relayMaxMB + ' MB). Connect on the same network for direct P2P, or pick a smaller file.';
      throw new Error('relay-size');
    }
    // register relay route first (no-op in rtc mode)
    if (p.mode === 'relay') wsSend({ t: 'route', to: p.id, streamId, remove: false });
    // announce file (ordered before its chunks)
    sendMeta(p, { kind: 'file-meta', streamId, fileId: tf.id, name: tf.name, size: tf.size, mime: tf.mime });
    S.streamOwner.set(streamId, p.id);

    const chunkSize = CHUNK_SIZE;
    let off = 0;
    while (off < tf.size && !tf.aborted && !st.finished) {
      if (!p.open || p.destroyed) throw new Error('peer closed');
      const end = Math.min(off + chunkSize, tf.size);
      const part = await tf.file.slice(off, end).arrayBuffer();
      const frame = new Uint8Array(9 + part.byteLength);
      const dv = new DataView(frame.buffer);
      dv.setUint32(0, streamId, true);
      dv.setUint32(4, st.seq, true);
      frame[8] = (end === tf.size) ? 1 : 0;
      frame.set(new Uint8Array(part), 9);
      st.seq += 1;

      if (p.mode === 'rtc') {
        const dc = p.dc;
        if (!dc || dc.readyState !== 'open') throw new Error('data channel closed');
        dc.send(frame.buffer);
        await waitDrainDc(dc);
      } else {
        if (!wsSendBinary(frame.buffer)) throw new Error('signaling connection lost');
        await waitDrainWs();
      }

      st.bytesSent = end;
      tf.sentBytes += part.byteLength;
      const pct = (tf.sentBytes / Math.max(1, tf.totalBytes)) * 100;
      tf.lastPct = pct;
      updateTransferEl(tf);
    }

    if (!tf.aborted && !st.finished && off >= tf.size) {
      // fully sent
      if (p.mode === 'relay') wsSend({ t: 'route', to: p.id, streamId, remove: true });
    } else if (tf.aborted && !st.finished) {
      // cancelled
      if (p.mode === 'relay') wsSend({ t: 'route', to: p.id, streamId, remove: true });
      sendCtrl(p, { kind: 'file-cancel', streamId, fileId: tf.id });
    }
  } catch (err) {
    st.failed = true;
    if (p.mode === 'relay') wsSend({ t: 'route', to: p.id, streamId, remove: true });
  } finally {
    st.finished = true;
    tf.activeStreams = Math.max(0, tf.activeStreams - 1);
    finishTransferIfDone(tf);
  }
}

function waitDrainDc(dc) {
  const HIGH = 2 * 1024 * 1024;
  if (dc.bufferedAmount < HIGH) return Promise.resolve();
  dc.bufferedAmountLowThreshold = 512 * 1024;
  return new Promise((res) => {
    const t = setTimeout(res, 6000);
    dc.addEventListener('bufferedamountlow', () => { clearTimeout(t); res(); }, { once: true });
    if (dc.bufferedAmount < 512 * 1024) { clearTimeout(t); res(); }
  });
}

function waitDrainWs() {
  if (!S.ws || S.ws.bufferedAmount < 2 * 1024 * 1024) return Promise.resolve();
  return new Promise((res) => setTimeout(res, 60));
}

function finishTransferIfDone(tf) {
  if (tf.aborted && tf.activeStreams === 0) {
    tf.status = 'cancelled';
    updateTransferEl(tf);
    updateCounts();
    return;
  }
  if (tf.activeStreams === 0 && tf.startedPeers.size > 0) {
    const anyFailed = Array.from(tf.streams.values()).some((s) => s.failed);
    if (!anyFailed && !tf.aborted) {
      tf.status = 'done';
      toast('Sent ' + tf.name);
    } else if (!tf.aborted) {
      tf.status = 'failed';
    }
    updateTransferEl(tf);
    updateCounts();
  }
}

function cancelTransfer(id) {
  const tf = S.transfers.get(id);
  if (!tf || tf.status === 'done' || tf.status === 'cancelled') return;
  tf.aborted = true;
  if (tf.status === 'waiting') {
    tf.status = 'cancelled';
    updateTransferEl(tf);
    updateCounts();
    for (const st of tf.streams.values()) { st.finished = true; }
  }
}
/* ============================================================
   Receiving files
   ============================================================ */
function handleCtrlMessage(from, msg) {
  const p = S.peers.get(from);
  if (!p || p.destroyed) return;
  onPeerCtrl(p, msg);
}

function onPeerCtrl(p, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'file-meta': {
      const r = {
        streamId: msg.streamId,
        fileId: msg.fileId,
        name: String(msg.name || 'file'),
        size: Number(msg.size) || 0,
        mime: msg.mime || 'application/octet-stream',
        parts: [],
        recved: 0,
        done: false,
        from: p.name,
      };
      p.recv.set(msg.streamId, r);
      S.streamOwner.set(msg.streamId, p.id);
      ensureReceivingCard(r);
      break;
    }
    case 'file-ok':
      break; // informational
    case 'file-cancel': {
      const r = p.recv.get(msg.streamId);
      if (r && !r.done) {
        p.recv.delete(msg.streamId);
        removeReceivingCard(msg.fileId);
        toast('Transfer of ' + r.name + ' was cancelled by sender');
      }
      break;
    }
    case 'sw-relay':
      if (p.mode === 'rtc') switchToRelay(p);
      break;
    case 'name':
      p.name = String(msg.name || p.name);
      renderPeers();
      break;
  }
}

function onPeerData(p, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    onPeerCtrl(p, msg);
    return;
  }
  const view = new DataView(data);
  if (data.byteLength < 9) return;
  const streamId = view.getUint32(0, true);
  const seq = view.getUint32(4, true);
  const flags = view.getUint8(8);
  const payload = data.slice(9);
  feedStreamData(p, streamId, seq, flags, payload);
}

function feedStreamData(p, streamId, seq, flags, payload) {
  const r = p.recv.get(streamId);
  if (!r || r.done) return;
  if (seq !== r.parts.length) return; // ordered transports mean this should not happen
  r.parts.push(payload);
  r.recved += payload.byteLength;
  updateReceivingCard(r);
  if (flags & 1) finalizeStream(p, r);
}

function finalizeStream(p, r) {
  if (r.done) return;
  r.done = true;
  p.recv.delete(r.streamId);
  try {
    const blob = new Blob(r.parts, { type: r.mime });
    completeReceivedItem(r, blob);
    sendCtrl(p, { kind: 'file-ok', streamId: r.streamId, fileId: r.fileId });
  } catch (e) {
    toast('Failed to assemble ' + r.name);
  }
}
/* ============================================================
   UI rendering
   ============================================================ */
function renderPeers() {
  const wrap = $('#peer-list');
  wrap.innerHTML = '';

  // me
  const me = document.createElement('div');
  me.className = 'peer-chip';
  me.innerHTML = '<div class="avatar">' + initialsOf(myDisplayName()) + '</div>' +
    '<div><div class="pname">' + esc(myDisplayName()) + ' <span style="color:var(--text-3);font-size:10px">(you)</span></div>' +
    '<div class="pstat good">Ready to share</div></div>';
  wrap.appendChild(me);

  for (const p of S.peers.values()) {
    const chip = document.createElement('div');
    chip.className = 'peer-chip';
    const statCls = !p.open ? '' : (p.mode === 'relay' ? 'relay' : 'good');
    const statTxt = !p.open ? 'connecting…' : (p.mode === 'relay' ? 'relay mode' : 'direct P2P');
    chip.innerHTML = '<div class="avatar">' + initialsOf(p.name) + '</div>' +
      '<div><div class="pname">' + esc(p.name) + '</div>' +
      '<div class="pstat ' + statCls + '">' + statTxt + '</div></div>';
    wrap.appendChild(chip);
  }
}

function renderStatus() {
  const line = $('#status-line');
  const txt = $('#status-text');
  const open = activePeers().length;
  const total = S.peers.size;
  if (!S.roomId) { line.className = 'status-line'; txt.textContent = 'Connecting…'; return; }
  if (total === 0) {
    line.className = 'status-line';
    txt.textContent = 'Waiting for another device… share your room code or QR';
    return;
  }
  if (open === total) {
    line.classList.add('ok');
    const mode = S.peers.size === 1 && Array.from(S.peers.values())[0].mode === 'relay' ? 'server relay' : 'direct P2P';
    txt.textContent = 'Connected to ' + total + ' device' + (total > 1 ? 's' : '') + ' · ' + mode;
  } else {
    line.className = 'status-line';
    txt.textContent = open + ' of ' + total + ' device' + (total > 1 ? 's' : '') + ' connected…';
  }
}

function updateCounts() {
  $('#peer-count').textContent = S.peers.size;
  const tcount = Array.from(S.transfers.values()).filter((t) => t.status !== 'cancelled').length;
  $('#transfer-count').textContent = tcount;
  $('#transfer-empty').hidden = tcount > 0;
  $('#received-count').textContent = S.received.size;
  $('#received-empty').hidden = S.received.size > 0;
}

/* ---------------- transfer cards ---------------- */
function appendTransferEl(tf) {
  const wrap = $('#transfer-list');
  const el = document.createElement('div');
  el.className = 't-item';
  el.dataset.id = tf.id;
  el.innerHTML =
    '<div class="t-icon type-' + kindOf(tf.name) + '">' + emojiOf(tf.name) + '</div>' +
    '<div class="t-body">' +
      '<div class="t-top"><span class="t-name">' + esc(tf.name) + '</span>' +
        '<span class="t-status"></span></div>' +
      '<div class="t-meta"></div>' +
      '<div class="t-progress"><i></i></div>' +
      '<div class="t-stats"><span class="ts-left"></span><span class="ts-right"></span></div>' +
    '</div>' +
    '<span class="t-cancel-wrap"></span>';
  tf.el = el;
  tf.refs = {
    status: el.querySelector('.t-status'),
    meta: el.querySelector('.t-meta'),
    bar: el.querySelector('.t-progress i'),
    left: el.querySelector('.ts-left'),
    right: el.querySelector('.ts-right'),
    cancelWrap: el.querySelector('.t-cancel-wrap'),
  };
  wrap.appendChild(el);
  updateTransferEl(tf);
}

function updateTransferEl(tf) {
  if (!tf.el || !tf.refs) return;
  const r = tf.refs;
  const done = tf.status === 'done';
  const total = tf.totalBytes || tf.size;
  const pct = done ? 100 : Math.min(100, ((tf.sentBytes || 0) / Math.max(1, total)) * 100);
  const stCls = done ? 'done' : (tf.status === 'failed' || tf.status === 'cancelled' ? 'fail' : (tf.status === 'sending' ? 'sending' : 'waiting'));
  const stTxt = done ? '✓ Sent' : (tf.status === 'failed' ? '✗ Failed' : (tf.status === 'cancelled' ? 'Cancelled' : (tf.status === 'sending' ? 'Sending' : 'Waiting')));

  r.status.className = 't-status ' + stCls;
  r.status.textContent = stTxt;
  r.meta.textContent = formatBytes(tf.size) + (tf.startedPeers.size > 1 ? ' → ' + tf.startedPeers.size + ' devices' : '') +
    (tf.status === 'failed' && tf.lastError ? ' · ' + tf.lastError : '');
  r.bar.style.width = pct + '%';
  r.left.textContent = (done ? '100%' : Math.floor(pct) + '%') + (tf.speed > 0 && !done ? ' · ' + formatSpeed(tf.speed) : '');
  r.right.textContent = formatBytes(Math.min(tf.sentBytes || 0, tf.size)) + ' / ' + formatBytes(tf.size);
  if (tf.status === 'waiting' || tf.status === 'sending') {
    if (!r.cancelBtn) {
      const b = document.createElement('button');
      b.className = 't-cancel';
      b.title = 'Cancel';
      b.dataset.cancel = tf.id;
      b.textContent = '✕';
      r.cancelBtn = b;
      r.cancelWrap.appendChild(b);
    }
  } else if (r.cancelBtn) {
    r.cancelBtn.remove();
    r.cancelBtn = null;
  }
}

function updateTransferList() {
  for (const tf of S.transfers.values()) updateTransferEl(tf);
}

/* ---------------- speed tick ---------------- */
function ensureSpeedTick() {
  const anyActive = Array.from(S.transfers.values()).some((t) => t.status === 'sending' && t.activeStreams > 0);
  if (anyActive) {
    S.totalSpeed = 0;
    if (!S.activeSpeedTick) {
      S.activeSpeedTick = true;
      const tick = () => {
        const now = Date.now();
        let total = 0;
        for (const tf of S.transfers.values()) {
          if (tf.status !== 'sending') continue;
          if (!tf.lastTs) { tf.lastTs = now; tf.lastBytes = tf.sentBytes; tf.speed = 0; continue; }
          const dt = now - tf.lastTs;
          const db = tf.sentBytes - tf.lastBytes;
          tf.speed = dt > 0 ? (db * 1000) / dt : 0;
          tf.lastBytes = tf.sentBytes;
          tf.lastTs = now;
          total += tf.speed;
          updateTransferEl(tf);
        }
        S.totalSpeed = total;
        const note = $('#speed-note');
        if (S.totalSpeed > 0) note.textContent = 'Current speed: ' + formatSpeed(S.totalSpeed);
        else if (note.textContent) note.textContent = '';
        if (Array.from(S.transfers.values()).some((t) => t.status === 'sending' && t.activeStreams > 0)) {
          requestAnimationFrame(tick);
        } else {
          S.activeSpeedTick = false;
          $('#speed-note').textContent = '';
        }
      };
      tick();
    }
  }
}

/* ---------------- receiving cards ---------------- */
const receivingCards = new Map(); // fileId -> el

function ensureReceivingCard(r) {
  let el = receivingCards.get(r.fileId);
  if (!el) {
    const wrap = $('#received-list');
    el = document.createElement('div');
    el.className = 'r-card grid';
    el.dataset.fileId = r.fileId;
    el.innerHTML =
      '<div class="r-media"><div class="audio-box">' + emojiOf(r.name) + '</div></div>' +
      '<div class="r-body"><div class="r-name">' + esc(r.name) + '</div>' +
      '<div class="r-meta">incoming from ' + esc(r.from) + '</div></div>' +
      '<div class="r-actions r-incoming">…</div>';
    receivingCards.set(r.fileId, el);
    wrap.insertBefore(el, wrap.firstChild);
  }
  updateCounts();
  updateReceivingCard(r);
}

function updateReceivingCard(r) {
  const el = receivingCards.get(r.fileId);
  if (!el) return;
  if (r.done) return;
  const pct = r.size ? (r.recved / r.size) * 100 : 0;
  el.querySelector('.r-meta').textContent = 'receiving · ' + Math.floor(pct) + '% · ' + formatBytes(r.recved) + ' / ' + formatBytes(r.size);
}

function removeReceivingCard(fileId) {
  const el = receivingCards.get(fileId);
  if (el) el.remove();
  receivingCards.delete(fileId);
  updateCounts();
}

function completeReceivedItem(r, blob) {
  const url = URL.createObjectURL(blob);
  const size = blob.size;
  const kind = kindOf(r.name);
  const existing = S.received.get(r.fileId);
  if (existing && existing.size === size) {
    // dedupe when the same file was streamed from several devices
    existing.count += 1;
    const el = existing.el;
    if (existing.count > 1) el.querySelector('.r-meta').textContent = size + ' · via ' + existing.count + ' devices';
    URL.revokeObjectURL(url);
    removeReceivingCard(r.fileId);
    updateCounts();
    toast('Received ' + r.name);
    return;
  }

  const el = document.createElement('div');
  el.className = 'r-card grid';

  let media = '';
  if (kind === 'image' && size < 40 * 1024 * 1024) {
    media = '<div class="r-media"><img src="' + url + '" alt=""></div>';
  } else if (kind === 'video') {
    media = '<div class="r-media"><video src="' + url + '" muted></video></div>';
  } else if (kind === 'audio') {
    media = '<div class="r-media"><div class="audio-box">🎵</div></div>';
  } else {
    media = '<div class="r-media"><div class="audio-box">' + emojiOf(r.name) + '</div></div>';
  }

  const actions =
    '<button class="r-btn primary" data-dl="' + r.fileId + '">Save</button>' +
    (kind === 'video' || kind === 'audio' ? '<button class="r-btn" data-open="' + r.fileId + '">Play</button>' : '');

  el.innerHTML = media +
    '<div class="r-body"><div class="r-name">' + esc(r.name) + '</div>' +
    '<div class="r-meta">' + formatBytes(size) + ' · from ' + esc(r.from || 'peer') + '</div></div>' +
    '<div class="r-actions">' + actions + '</div>' +
    ((kind === 'video' || kind === 'audio') ? '<div class="media-player" hidden><video src="' + url + '" controls></video></div>' : '');

  const item = { fileId: r.fileId, name: r.name, size, url, blob, count: 1, el };
  S.received.set(r.fileId, item);

  el.addEventListener('click', (ev) => {
    const dl = ev.target.closest('[data-dl]');
    const op = ev.target.closest('[data-open]');
    if (dl) {
      const a = document.createElement('a');
      a.href = item.url;
      a.download = item.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    if (op) {
      const player = el.querySelector('.media-player');
      if (player) {
        player.hidden = !player.hidden;
        const v = player.querySelector('video');
        if (v && !player.hidden) v.play().catch(() => { /* noop */ });
      } else {
        window.open(item.url, '_blank');
      }
    }
  });

  const wrap = $('#received-list');
  wrap.insertBefore(el, wrap.firstChild);
  removeReceivingCard(r.fileId);
  updateCounts();
  if (r.size > 30 * 1024 * 1024) toast('Receiving ' + r.name + ' done ✓');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* ============================================================
   QR code
   ============================================================ */
function roomJoinUrl() {
  const base = location.origin + location.pathname + '#join=' + S.roomId;
  const host = getSignalingHost();
  // If the page lives on a different host than the signaling server
  // (e.g. Vercel frontend + Render server), put the server in the link
  // so the other device connects to the right place automatically.
  if (host && host !== location.host) return base + '&server=' + encodeURIComponent(host);
  return base;
}

function drawQr(canvas, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 6;
  const pad = 24;
  canvas.width = n * scale + pad * 2;
  canvas.height = n * scale + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0b1020';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(pad + c * scale, pad + r * scale, scale, scale);
    }
  }
}

function showQr() {
  if (!S.roomId) return;
  drawQr($('#qr-canvas'), roomJoinUrl());
  $('#qr-code-text').textContent = S.roomId;
  $('#qr-overlay').hidden = false;
}

// Offline/LAN: show a QR of the page URL itself so the other phone can
// open the same local server page straight from its camera.
function showPageQr() {
  const url = location.href;
  if (!url || url.indexOf('http') !== 0) { toast('Open this page over http:// first'); return; }
  const title = $('#qr-overlay h3');
  if (title) title.textContent = 'Scan to open this page';
  $('#qr-code-text').textContent = url;
  drawQr($('#qr-canvas'), url);
  $('#qr-code-text').hidden = true;
  $('#qr-overlay').hidden = false;
  $('#btn-qr-close').addEventListener('click', hideQr, { once: true });
}

function copyPageLink() {
  const url = location.href;
  const done = () => toast('Address copied ✓');
  const fail = () => toast('Address: ' + url);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(fail);
  } else fail();
}

function hideQr() { $('#qr-overlay').hidden = true; }

function copyCode() {
  if (!S.roomId) return;
  const done = () => toast('Room code copied ✓');
  const fail = () => toast('Room code: ' + S.roomId);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(S.roomId).then(done).catch(fail);
  } else fail();
}

function copyLink() {
  if (!S.roomId) return;
  const link = roomJoinUrl();
  const done = () => toast('Invite link copied ✓');
  const fail = () => toast('Invite link: ' + link);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done).catch(fail);
  } else fail();
}

function invitePeers() {
  if (!S.roomId) return;
  const link = roomJoinUrl();
  const payload = {
    title: 'SwiftDrop',
    text: 'Join my SwiftDrop room — send files straight to me, device to device.',
    url: link,
  };
  if (navigator.share) {
    navigator.share(payload)
      .catch(() => copyLink());
  } else {
    copyLink();
  }
}

/* -------- QR camera scanning (optional) -------- */
let scanStream = null;
function scanQr() {
  if (!navigator.mediaDevices || !window.BarcodeDetector) {
    toast('QR scanning is not supported on this browser');
    return;
  }
  if (!S.roomId) {
    toast('Create a room first — others scan its QR');
    return;
  }
  const bd = new BarcodeDetector({ formats: ['qr_code'] });
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then((stream) => {
      scanStream = stream;
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.id = 'scan-overlay';
      overlay.innerHTML = '<div class="qr-card"><h3>Point at a SwiftDrop QR code</h3>' +
        '<video id="scan-video" style="width:100%;border-radius:12px"></video>' +
        '<button class="btn btn-ghost" id="scan-cancel" style="margin-top:14px">Cancel</button></div>';
      document.body.appendChild(overlay);
      const video = $('#scan-video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.play().catch(() => { /* noop */ });
      const loop = () => {
        if (!overlay.isConnected) return;
        bd.detect(video).then((codes) => {
          for (const c of codes || []) {
            const m = /#join=([A-Z0-9]{6})/i.exec(c.rawValue);
            if (m) {
              closeScan();
              tryJoin(m[1].toUpperCase());
              return;
            }
          }
          setTimeout(loop, 350);
        }).catch(() => setTimeout(loop, 500));
      };
      setTimeout(loop, 700);
      $('#scan-cancel').onclick = closeScan;
    })
    .catch(() => toast('Camera permission denied'));
}

function closeScan() {
  const ov = $('#scan-overlay');
  if (ov) ov.remove();
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}

/* ============================================================
   Actions
   ============================================================ */
function tryJoin(code) {
  const clean = (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 6) { toast('Enter a valid 6-character room code'); return; }
  $('#join-code').value = clean;
  const msg = { t: 'join', roomId: clean, peerId: S.peerId || undefined, name: myDisplayName() };
  if (!wsSend(msg)) {
    S.pendingJoin = msg;
    feedbackIfNotReady();
  } else {
    toast('Joining ' + clean + '…');
  }
}

function resetToHome() {
  for (const p of S.peers.values()) destroyPeer(p);
  S.peers.clear();
  S.roomId = null;
  S.peerId = null;
  S.streamOwner.clear();
  $('#room').hidden = true;
  $('#home').hidden = false;
}

function createRoom() {
  S.peerId = null;
  const msg = { t: 'create', name: myDisplayName() };
  if (!wsSend(msg)) {
    S.pendingJoin = msg;
    feedbackIfNotReady();
  }
}

/* ============================================================
   Drag & drop / paste / input wiring
   ============================================================ */
function setupDrop() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  if (!dz || !input) return;

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    document.body.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    document.body.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
    });
  });
  document.body.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });

  document.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && !S.roomId) { toast('Join a room first'); return; }
    if (files && files.length) addFiles(files);
  });

  document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
}

/* ============================================================
   Init
   ============================================================ */
// Guarded wiring: a missing element must never take the app down.
function on(sel, ev, fn) {
  const el = $(sel);
  if (el) el.addEventListener(ev, fn);
  else console.warn('SwiftDrop: missing element', sel);
}

function hookGlobalErrors() {
  if (!window.addEventListener) return;
  window.addEventListener('error', (e) => {
    try { toast('Something went wrong (' + (e.message || 'error') + ') — please refresh'); } catch (err) { /* noop */ }
    console.error(e && e.error || e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { toast('Connection hiccup — retrying…'); } catch (err) { /* noop */ }
  });
}

function init() {
  hookGlobalErrors();
  S.myName = loadName() || ('Device ' + Math.floor(Math.random() * 9000 + 1000));
  saveName(S.myName);
  const nm = $('#my-name');
  if (nm) nm.value = S.myName;

  on('#my-name', 'input', () => {
    S.myName = nm.value.trim() || 'Device';
    saveName(S.myName);
    for (const p of S.peers.values()) sendCtrl(p, { kind: 'name', name: myDisplayName() });
    renderPeers();
  });

  // Optional custom signaling-server address (static-host workaround).
  const sa = $('#server-addr');
  if (sa) {
    const applyServerAddress = () => {
      const val = sa.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      try { localStorage.setItem('sd_server', val); } catch (e) { /* noop */ }
      clearStaticWarning();
      connectWs();
      fetchConfig();
      if (val) toast('Connecting to ' + val + '…');
      else toast('Server address cleared — using this page’s host');
    };
    try { sa.value = localStorage.getItem('sd_server') || ''; } catch (e) { /* noop */ }
    sa.addEventListener('change', applyServerAddress);
    sa.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyServerAddress(); } });
  }

  on('#btn-create', 'click', createRoom);
  on('#btn-join', 'click', () => tryJoin($('#join-code').value));

  // Offline/LAN sharing box: shows the local page URL so a phone on the same
  // WiFi/hotspot can open the exact same server page (no internet needed).
  const lanBox = $('#lan-box');
  const lanUrl = $('#lan-url');
  if (lanBox && lanUrl && location && typeof location.href === 'string' &&
      location.href.indexOf('http') === 0 && location.hostname !== 'localhost' &&
      !/(^|\.)vercel\.app$|netlify|github\.io/i.test(location.hostname || '')) {
    lanUrl.value = location.href;
    lanBox.hidden = false;
    on('#btn-copy-lan', 'click', copyPageLink);
    on('#btn-lan-qr', 'click', showPageQr);
  }
  on('#join-code', 'keydown', (e) => { if (e.key === 'Enter') tryJoin(e.target.value); });
  on('#join-code', 'input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  on('#btn-copy', 'click', copyCode);
  on('#btn-invite', 'click', invitePeers);
  on('#btn-qr', 'click', showQr);
  on('#btn-qr-close', 'click', hideQr);
  on('#qr-overlay', 'click', (e) => { if (e.target === $('#qr-overlay')) hideQr(); });
  on('#btn-leave', 'click', () => { leaveRoom(); });

  if ('BarcodeDetector' in window) {
    const scanBtn = $('#btn-scan');
    if (scanBtn) scanBtn.hidden = false;
  }
  on('#btn-scan', 'click', scanQr);

  on('#transfer-list', 'click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-cancel]') : null;
    if (btn) cancelTransfer(btn.dataset.cancel);
  });

  setupDrop();

  // auto-join from QR/deep-link hash:  #join=ABC123 or #join=ABC123&server=host
  const hashMatch = /#join=([A-Z0-9]{6})(?:&server=([^&]*))?/i.exec(location.hash);
  if (hashMatch && hashMatch[2]) {
    try { localStorage.setItem('sd_server', decodeURIComponent(hashMatch[2])); } catch (e) { /* noop */ }
    const sa2 = $('#server-addr');
    if (sa2) sa2.value = getSignalingHost();
  }

  connectWs();
  fetchConfig();

  if (hashMatch) {
    S.peerId = null;
    const msg = { t: 'join', roomId: hashMatch[1].toUpperCase(), peerId: undefined, name: myDisplayName() };
    if (!wsSend(msg)) S.pendingJoin = msg;
  }

  // register service worker for installable PWA (only on https/localhost where supported)
  if ('serviceWorker' in navigator && location.protocol !== 'http:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* noop */ });
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}