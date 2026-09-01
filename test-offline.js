/* Test for the self-contained offline-server.js (single-file, no internet). */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3999;
const server = spawn(process.execPath, ['offline-server.js'], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'inherit'],
});

function get() {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/' }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}
function wsc() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:' + PORT);
    ws.binaryType = 'arraybuffer';
    const t = setTimeout(() => reject(new Error('ws timeout')), 5000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => reject(new Error('ws error'));
  });
}
function waitFor(ws, pred, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting')), timeout || 6000);
    const h = (e) => {
      let d = e.data;
      if (d instanceof ArrayBuffer) d = Buffer.from(d);
      else if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { /* keep */ } }
      if (pred(d)) { clearTimeout(t); ws.removeEventListener('message', h); resolve(d); }
    };
    ws.addEventListener('message', h);
  });
}

(async () => {
  try {
    await new Promise((r) => setTimeout(r, 900));
    const home = await get();
    if (home.status !== 200) throw new Error('page status ' + home.status);
    if (home.data.indexOf('SwiftDrop') < 0) throw new Error('page missing SwiftDrop');
    if (home.data.indexOf('<script src=') >= 0) throw new Error('not fully inlined — external script tag present');
    if (home.data.indexOf('lan-box') < 0) throw new Error('lan-box missing from bundled html');
    console.log('single-file page served, fully inlined (' + (home.data.length / 1024).toFixed(1) + ' KB)');

    const a = await wsc();
    const b = await wsc();
    a.send(JSON.stringify({ t: 'create', name: 'Phone A' }));
    const created = await waitFor(a, (m) => m.t === 'created');
    b.send(JSON.stringify({ t: 'join', roomId: created.roomId, name: 'Phone B' }));
    const joined = await waitFor(b, (m) => m.t === 'joined');
    if (joined.peers.length !== 1) throw new Error('peer list wrong');
    console.log('offline room works:', created.roomId);

    // relay a binary blob
    const streamId = 0xABCDEF;
    a.send(JSON.stringify({ t: 'route', to: joined.peerId, streamId, remove: false }));
    const payload = Buffer.from('offline relay test payload '.repeat(50));
    const header = Buffer.alloc(9);
    header.writeUInt32LE(streamId, 0);
    header.writeUInt32LE(3, 4);
    header[8] = 1;
    a.send(Buffer.concat([header, payload]));
    const got = await waitFor(b, (m) => Buffer.isBuffer(m));
    if (!got.slice(9).equals(payload)) throw new Error('binary mismatch');
    console.log('offline binary relay OK (' + payload.length + ' bytes)');

    console.log('\nOFFLINE SERVER TESTS PASSED ✓');
    process.exit(0);
  } catch (e) {
    console.error('\nOFFLINE TEST FAILED ✗', e && e.stack || e);
    process.exit(1);
  } finally {
    try { server.kill(); } catch (e) { /* noop */ }
  }
})();