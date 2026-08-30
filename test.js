/* End-to-end test for the SwiftDrop server over real WebSockets. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3210;
const server = spawn(process.execPath, ['server.js'], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'inherit'],
});

const url = 'ws://localhost:' + PORT;

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: p }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], data }));
    }).on('error', reject);
  });
}

function wsc() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

function waitFor(ws, pred, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeout || 6000);
    const handler = (e) => {
      let data = e.data;
      if (data instanceof ArrayBuffer) data = Buffer.from(data);
      else if (typeof data === 'string') { try { data = JSON.parse(data); } catch (err) { /* keep string */ } }
      if (pred(data)) {
        clearTimeout(t);
        ws.removeEventListener('message', handler);
        resolve(data);
      }
    };
    ws.addEventListener('message', handler);
  });
}

(async () => {
  try {
    await new Promise((r) => setTimeout(r, 900));

    // ---- HTTP static serving + compression + security ----
    const home = await get(PORT, '/');
    if (home.status !== 200 || !home.data.includes('SwiftDrop')) throw new Error('index.html not served');
    if (!home.ct.includes('text/html')) throw new Error('index.html content-type wrong');
    const css = await get(PORT, '/styles.css');
    if (css.status !== 200) throw new Error('css not served');
    const js = await get(PORT, '/client.js');
    if (js.status !== 200) throw new Error('js not served');
    const gz = new Promise((resolve, reject) => {
      http.get({ host: 'localhost', port: PORT, path: '/client.js', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], len: Buffer.concat(chunks).length }));
      }).on('error', reject);
    });
    const gzRes = await gz;
    if (gzRes.encoding !== 'gzip') throw new Error('gzip not applied');
    console.log('HTTP static serving + gzip OK (' + gzRes.len + ' bytes compressed)');

    // ---- API endpoints ----
    const cfg = await get(PORT, '/api/config');
    const cfgJson = JSON.parse(cfg.data);
    if (cfg.status !== 200 || !Array.isArray(cfgJson.rtc.iceServers) || !cfgJson.limits.relayMaxMB) throw new Error('config wrong');
    console.log('/api/config OK (iceServers: ' + cfgJson.rtc.iceServers.length + ', relayMaxMB: ' + cfgJson.limits.relayMaxMB + ')');
    const health = await get(PORT, '/api/health');
    if (!health.data.includes('"ok":true')) throw new Error('health wrong');
    console.log('/api/health OK');

    const a = await wsc();
    const b = await wsc();

    // ---- create room ----
    a.send(JSON.stringify({ t: 'create', name: 'Device A' }));
    const created = await waitFor(a, (m) => m.t === 'created');
    const roomId = created.roomId;
    const peerA = created.peerId;
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomId)) throw new Error('bad room code: ' + roomId);
    console.log('room created:', roomId);

    // ---- join room ----
    b.send(JSON.stringify({ t: 'join', roomId, name: 'Device B' }));
    const joined = await waitFor(b, (m) => m.t === 'joined');
    const peerB = joined.peerId;
    if (joined.peers.length !== 1 || joined.peers[0].id !== peerA) throw new Error('peer list wrong');
    console.log('join OK, B peer =', peerB.slice(0, 6) + '…');

    const added = await waitFor(a, (m) => m.t === 'peer-added');
    if (added.peer.id !== peerB || added.peer.name !== 'Device B') throw new Error('peer-added wrong');
    console.log('peer-added notification OK');

    // ---- rtc signaling relay ----
    a.send(JSON.stringify({ t: 'rtc', to: peerB, msg: { kind: 'offer', sdp: { type: 'offer', sdp: 'x' } } }));
    const offer = await waitFor(b, (m) => m.t === 'rtc' && m.msg && m.msg.kind === 'offer');
    if (offer.from !== peerA) throw new Error('rtc from wrong');
    console.log('RTC offer relayed OK');

    b.send(JSON.stringify({ t: 'ctrl', to: peerA, msg: { kind: 'answer', ok: true } }));
    const answer = await waitFor(a, (m) => m.t === 'ctrl' && m.msg && m.msg.kind === 'answer');
    if (answer.from !== peerB) throw new Error('ctrl from wrong');
    console.log('CTRL relayed OK');

    // ---- relay binary routing ----
    const streamId = 0x1234567;
    a.send(JSON.stringify({ t: 'route', to: peerB, streamId, remove: false }));
    const payload = Buffer.from('hello swiftdrop binary ' .repeat(200));
    const header = Buffer.alloc(9);
    header.writeUInt32LE(streamId, 0);
    header.writeUInt32LE(7, 4);
    header[8] = 1;
    a.send(Buffer.concat([header, payload]));

    const got = await waitFor(b, (m) => Buffer.isBuffer(m));
    if (got.readUInt32LE(0) !== streamId || got.readUInt32LE(4) !== 7 ||
        got[8] !== 1 || !got.slice(9).equals(payload)) throw new Error('binary frame mismatch');
    console.log('binary relay OK (' + payload.length + ' bytes intact)');

    // ---- wrong room ----
    const c = await wsc();
    c.send(JSON.stringify({ t: 'join', roomId: 'ZZZZZZ', name: 'C' }));
    const err = await waitFor(c, (m) => m.t === 'error');
    if (err.code !== 'NOT_FOUND') throw new Error('expected NOT_FOUND');
    console.log('bad-room error OK');

    // ---- peer-left on disconnect ----
    b.close();
    const left = await waitFor(a, (m) => m.t === 'peer-left');
    if (left.peerId !== peerB) throw new Error('peer-left wrong');
    console.log('peer-left notification OK');

    // ---- room cleanup after host leaves ----
    a.send(JSON.stringify({ t: 'leave' }));
    await new Promise((r) => setTimeout(r, 300));

    console.log('\nALL SERVER TESTS PASSED ✓');
    process.exit(0);
  } catch (e) {
    console.error('\nTEST FAILED ✗', e && e.stack || e);
    process.exit(1);
  } finally {
    try { server.kill(); } catch (e) { /* noop */ }
  }
})();