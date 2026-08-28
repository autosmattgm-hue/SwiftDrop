'use strict';
/**
 * SwiftDrop server
 * - Serves the static web app (public/)
 * - Provides a zero-dependency WebSocket signaling server for WebRTC pairing
 * - Provides a low-latency binary relay built into the WebSocket protocol as a
 *   fallback transport when direct P2P (WebRTC) cannot be established
 *
 * Run with:  node server.js
 * No npm install required.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

/* ----------------------------------------------------------------------- */
/* Configuration                                                           */
/* ----------------------------------------------------------------------- */

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I,L,O,0,1
const ROOM_CODE_LEN = 6;
const MAX_PEERS_PER_ROOM = 10;
const MAX_MSG_BYTES = 32 * 1024 * 1024; // server-side guard for single ws message
const FRAME_HEADER_SIZE = 9; // streamId:4 + seq:4 + flags:1
const IDLE_ROOM_MS = 24 * 60 * 60 * 1000; // rooms die after 24h of inactivity
const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/* ----------------------------------------------------------------------- */
/* Minimal WebSocket implementation (RFC 6455)                             */
/* ----------------------------------------------------------------------- */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}
class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragData = [];
    this.fragSize = 0;
    this.fragOpcode = 0;
    this.fragBinary = false;
    this.isOpen = true;
    this.ponged = true;
    this.lastSee = Date.now();

    socket.on('data', (d) => { this.lastSee = Date.now(); this._feed(d); });
    socket.on('error', () => { /* handled via close */ });
    socket.on('close', () => { this._closed(); });
    socket.on('end', () => { this._closed(); });
  }

  _closed() {
    if (!this.isOpen) return;
    this.isOpen = false;
    try { this.socket.destroy(); } catch (e) { /* noop */ }
    this.emit('close');
  }

  _feed(d) {
    if (!this.isOpen) return;
    this.buffer = Buffer.concat([this.buffer, d]);
    this._parse();
  }

  _parse() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MSG_BYTES)) { this.close(1009); return; }
        len = Number(big);
        off = 10;
      }

      if (len > MAX_MSG_BYTES) { this.close(1009); return; }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < off + maskLen + len) return;

      const payload = Buffer.allocUnsafe(len);
      if (masked) {
        const mask = this.buffer.slice(off, off + 4);
        for (let i = 0; i < len; i++) payload[i] = this.buffer[off + 4 + i] ^ mask[i & 3];
      } else {
        this.buffer.copy(payload, 0, off, off + len);
      }
      this.buffer = this.buffer.slice(off + maskLen + len);
      this._dispatch(fin, opcode, payload);
    }
  }

  _dispatch(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      try {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code, 0);
        this._sendFrame(0x8, b);
      } catch (e) { /* noop */ }
      this._closed();
      return;
    }
    if (opcode === 0x9) { // ping
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) { // pong
      this.ponged = true;
      return;
    }

    if (opcode === 0x0) { // continuation
      if (this.fragOpcode === 0) { this.close(1002); return; }
      this.fragData.push(payload);
      this.fragSize += payload.length;
      if (this.fragSize > MAX_MSG_BYTES) { this.close(1009); return; }
      if (fin) {
        const msg = Buffer.concat(this.fragData, this.fragSize);
        const isBinary = this.fragBinary;
        this.fragData = [];
        this.fragSize = 0;
        this.fragOpcode = 0;
        this.emit('message', msg, isBinary);
      }
      return;
    }

    if (fin) {
      this.emit('message', payload, opcode === 0x2);
    } else {
      if (opcode !== 0x1 && opcode !== 0x2) { this.close(1002); return; }
      this.fragOpcode = opcode;
      this.fragBinary = opcode === 0x2;
      this.fragData = [payload];
      this.fragSize = payload.length;
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.isOpen) return;
    let header;
    const len = payload.length;
    if (len <= 125) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendText(str) { this._sendFrame(0x1, Buffer.from(str, 'utf8')); }
  sendBinary(buf) { this._sendFrame(0x2, buf); }
  ping() { this.ponged = false; this._sendFrame(0x9, Buffer.alloc(0)); }
  close(code) {
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code || 1000, 0);
      this._sendFrame(0x8, b);
    } catch (e) { /* noop */ }
    this._closed();
  }
}
class WsServer extends EventEmitter {
  constructor(httpServer) {
    super();
    httpServer.on('upgrade', (req, socket) => this._upgrade(req, socket));
  }

  _upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || !version) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n'
    );
    const conn = new WsConnection(socket);
    this.emit('connection', conn);
  }
}

/* ----------------------------------------------------------------------- */
/* Room state                                                              */
/* ----------------------------------------------------------------------- */

const rooms = new Map();       // roomId -> { lastActive, peers: Map(peerId -> {conn, name}) }
const peerIndex = new Map();   // conn -> { roomId, peerId }
const streamRoutes = new Map(); // roomId -> Map(streamId -> peerId)

function genRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function genPeerId() {
  return crypto.randomBytes(16).toString('hex');
}

function genStreamId() {
  return (crypto.randomBytes(4).readUInt32LE(0)) >>> 0;
}

function broadcast(room, type, payload, exceptPeerId) {
  const data = JSON.stringify(Object.assign({ t: type }, payload));
  for (const [pid, p] of room.peers) {
    if (pid === exceptPeerId) continue;
    try { p.conn.sendText(data); } catch (e) { /* noop */ }
  }
}

function removeRoutesForPeer(roomId, peerId) {
  const routes = streamRoutes.get(roomId);
  if (!routes) return;
  for (const [sid, to] of routes) {
    if (to === peerId) routes.delete(sid);
  }
}

function dropPeer(conn) {
  const loc = peerIndex.get(conn);
  if (!loc) return;
  peerIndex.delete(conn);
  const room = rooms.get(loc.roomId);
  if (!room) return;
  const p = room.peers.get(loc.peerId);
  if (p && p.conn === conn) {
    room.peers.delete(loc.peerId);
    removeRoutesForPeer(loc.roomId, loc.peerId);
    broadcast(room, 'peer-left', { peerId: loc.peerId }, loc.peerId);
  }
  if (room.peers.size === 0) {
    rooms.delete(loc.roomId);
    streamRoutes.delete(loc.roomId);
  }
}

function registerPeer(conn, roomId, peerId, name) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { lastActive: Date.now(), peers: new Map() };
    rooms.set(roomId, room);
  }
  // Reuse peerId on rejoin: replace stale socket
  const existing = room.peers.get(peerId);
  if (existing && existing.conn !== conn) {
    existing.conn._ignored = true; // its close handler won't wipe us
    try { existing.conn.socket.destroy(); } catch (e) { /* noop */ }
  }
  room.peers.set(peerId, { conn, name });
  peerIndex.set(conn, { roomId, peerId });
  room.lastActive = Date.now();
}
/* ----------------------------------------------------------------------- */
/* Message dispatch                                                        */
/* ----------------------------------------------------------------------- */

function onBinary(conn, buf) {
  const loc = peerIndex.get(conn);
  if (!loc) return;
  if (buf.length < FRAME_HEADER_SIZE) return;
  const streamId = buf.readUInt32LE(0);
  const routes = streamRoutes.get(loc.roomId);
  const to = routes && routes.get(streamId);
  if (!to) return;
  const room = rooms.get(loc.roomId);
  if (!room) return;
  const target = room.peers.get(to);
  if (!target) return;
  target.conn.sendBinary(buf);
}

function onJson(conn, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'create') {
    const code = genRoomCode();
    const peerId = genPeerId();
    if (!code) return send(conn, { t: 'error', code: 'NO_CODE' });
    registerPeer(conn, code, peerId, String(msg.name || 'Device'));
    return send(conn, { t: 'created', roomId: code, peerId });
  }

  if (msg.t === 'join') {
    const roomId = String(msg.roomId || '').toUpperCase();
    const room = rooms.get(roomId);
    if (!room) return send(conn, { t: 'error', code: 'NOT_FOUND' });
    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      return send(conn, { t: 'error', code: 'ROOM_FULL' });
    }
    const wasRejoin = !!msg.peerId && room.peers.has(msg.peerId);
    const peerId = wasRejoin ? String(msg.peerId) : genPeerId();
    const name = String(msg.name || 'Device');
    registerPeer(conn, roomId, peerId, name);
    const rd = rooms.get(roomId);
    const myId = peerIndex.get(conn).peerId;
    const peers = [];
    for (const [id, p] of rd.peers) {
      if (id !== myId) peers.push({ id, name: p.name });
    }
    send(conn, { t: 'joined', roomId, peerId: myId, peers });
    broadcast(rd, 'peer-added', { peer: { id: myId, name } }, myId);
    return;
  }

  const loc = peerIndex.get(conn);
  if (!loc) return;

  if (msg.t === 'leave') {
    const room = rooms.get(loc.roomId);
    if (room && room.peers.has(loc.peerId)) {
      room.peers.delete(loc.peerId);
      removeRoutesForPeer(loc.roomId, loc.peerId);
      broadcast(room, 'peer-left', { peerId: loc.peerId }, loc.peerId);
    }
    peerIndex.delete(conn);
    if (room && room.peers.size === 0) {
      rooms.delete(loc.roomId);
      streamRoutes.delete(loc.roomId);
    }
    send(conn, { t: 'left' });
    setTimeout(() => { try { conn.close(1000); } catch (e) { /* noop */ } }, 30);
    return;
  }

  if (msg.t === 'rtc' || msg.t === 'ctrl') {
    const room = rooms.get(loc.roomId);
    if (!room) return;
    const target = room.peers.get(String(msg.to || ''));
    if (!target) return;
    target.conn.sendText(JSON.stringify({ t: msg.t, from: loc.peerId, msg: msg.msg }));
    return;
  }

  if (msg.t === 'route') {
    const room = rooms.get(loc.roomId);
    if (!room) return;
    const to = String(msg.to || '');
    if (!room.peers.has(to)) return;
    const streamId = Number(msg.streamId) >>> 0;
    let routes = streamRoutes.get(loc.roomId);
    if (!routes) { routes = new Map(); streamRoutes.set(loc.roomId, routes); }
    if (msg.remove) routes.delete(streamId);
    else routes.set(streamId, to);
    const target = room.peers.get(to);
    if (msg.forward && target && !msg.remove) {
      target.conn.sendText(JSON.stringify({
        t: 'ctrl',
        from: loc.peerId,
        msg: { kind: 'relay-stream', streamId, fileId: msg.fileId, name: msg.name, size: msg.size, mime: msg.mime },
      }));
    }
    return;
  }
}

function send(conn, obj) {
  try { conn.sendText(JSON.stringify(obj)); } catch (e) { /* noop */ }
}
/* ----------------------------------------------------------------------- */
/* Static file server                                                      */
/* ----------------------------------------------------------------------- */

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.includes('..')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const file = path.join(PUBLIC_DIR, urlPath);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

/* ----------------------------------------------------------------------- */
/* Boot                                                                     */
/* ----------------------------------------------------------------------- */

const server = http.createServer((req, res) => serveStatic(req, res));

const wss = new WsServer(server);

wss.on('connection', (conn) => {
  conn.on('message', (buf, isBinary) => {
    if (isBinary) onBinary(conn, buf);
    else {
      let msg = null;
      try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { /* drop */ }
      if (msg) onJson(conn, msg);
    }
  });
  conn.on('close', () => {
    if (conn._ignored) return;
    dropPeer(conn);
  });
});

// Heartbeat to reap dead sockets
setInterval(() => {
  const now = Date.now();
  for (const [conn] of peerIndex) {
    if (conn.isOpen && !conn.ponged && (now - conn.lastSee) > HEARTBEAT_TIMEOUT_MS) {
      try { conn.socket.destroy(); } catch (e) { /* noop */ }
    }
  }
}, HEARTBEAT_MS).unref();

// Periodic idle room sweep
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.lastActive > IDLE_ROOM_MS) {
      for (const [, p] of room.peers) {
        peerIndex.delete(p.conn);
        try { p.conn.socket.destroy(); } catch (e) { /* noop */ }
      }
      rooms.delete(roomId);
      streamRoutes.delete(roomId);
    }
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('==================================================');
  console.log('  SwiftDrop server is running');
  console.log('  Local:   http://localhost:' + PORT);
  for (const a of addrs) console.log('  Network: http://' + a + ':' + PORT);
  console.log('  Open the page on any phone/computer and pair using a room code or QR.');
  console.log('==================================================');
});