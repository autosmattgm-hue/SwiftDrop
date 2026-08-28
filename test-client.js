/* Headless smoke test for public/client.js using DOM/WS stubs. */
'use strict';
const fs = require('fs');
const vm = require('vm');

function makeStubEl() {
  const t = {};
  return new Proxy(function () {}, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'dataset') return {};
      if (prop === 'classList') return { add() {}, remove() {}, contains() { return false; } };
      if (prop === 'style') return {};
      if (prop === 'children') return [];
      if (prop === 'files') return [];
      if (prop === 'then') return undefined;
      if (prop in target) {
        return target[prop];
      }
      return () => makeStubEl(); // unknown methods return a usable element stub
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}

class WsMock {
  static get OPEN() { return 1; }
  static get CONNECTING() { return 0; }
  static get CLOSED() { return 3; }
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    const self = this;
    setTimeout(() => { if (self.onopen) self.onopen(); }, 0);
  }
  set binaryType(v) { this._bt = v; }
  send() { return true; }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  addEventListener(ev, fn) { if (ev === 'open' && fn) { const self = this; setTimeout(() => fn({}), 0); } }
  removeEventListener() {}
}

const documentStub = makeStubEl();
documentStub.readyState = 'complete';
documentStub.body = makeStubEl();
documentStub.addEventListener = () => {};
documentStub.createElement = () => makeStubEl();
documentStub.querySelector = () => makeStubEl();
documentStub.querySelectorAll = () => [];

const sandbox = {
  console,
  document: documentStub,
  window: documentStub, // `'BarcodeDetector' in window` -> false
  location: { protocol: 'http:', host: 'localhost:3210', origin: 'http://localhost:3210', pathname: '/', hash: '' },
  navigator: { serviceWorker: undefined, mediaDevices: undefined, clipboard: undefined },
  localStorage: { getItem() { return ''; }, setItem() {} },
  WebSocket: WsMock,
  RTCPeerConnection: undefined,
  RTCDataChannel: function () {},
  URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
  qrcode() { return { addData() {}, make() {}, getModuleCount() { return 21; }, isDark() { return false; } }; },
  Blob: function Blob() { this.size = 0; },
  requestAnimationFrame: () => 0,
  DataView,
  Uint8Array,
  ArrayBuffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
sandbox.globalThis = sandbox;

const src = fs.readFileSync(require('path').join(__dirname, 'public', 'client.js'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures += 1; console.error('  ✗ FAIL: ' + msg); }
}

try {
  vm.runInNewContext(src, sandbox, { filename: 'client.js' });

  // Wait for async open handlers to fire
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    await tick(30);

    const top = sandbox;
    const need = ['init', 'createRoom', 'tryJoin', 'enterRoom', 'leaveRoom', 'addFiles',
      'pushQueuedSends', 'startStream', 'finishTransferIfDone', 'cancelTransfer',
      'maybeFallback', 'switchToRelay', 'bindChannel', 'sendOffer', 'handleRtcMessage',
      'flushIce', 'handleServerMsg', 'handleRelayChunk', 'onPeerCtrl', 'feedStreamData',
      'finalizeStream', 'renderPeers', 'renderStatus', 'updateCounts', 'ensureSpeedTick',
      'ensureReceivingCard', 'updateReceivingCard', 'removeReceivingCard', 'completeReceivedItem',
      'showQr', 'copyCode', 'resetToHome', 'setupDrop', 'connectWs', 'wsSend', 'wsSendBinary',
      'esc', 'formatBytes', 'formatSpeed', 'uid', 'genStreamId'];
    let ok = true;
    for (const fn of need) {
      if (typeof top[fn] !== 'function') { ok = false; console.error('  ✗ missing function: ' + fn); failures += 1; }
    }
    if (ok) console.log('  ✓ all ' + need.length + ' expected top-level functions exist');

    assert(typeof top.formatBytes(2048) === 'string', 'formatBytes works');
    assert(top.esc('<b>&"') === '&lt;b&gt;&amp;&quot;', 'esc works');

    // simulate: create room
    top.handleServerMsg({ t: 'created', roomId: 'ABC123', peerId: 'aaa111' });
    const SV = (expr) => vm.runInContext(expr, sandbox);
    assert(SV('S.roomId') === 'ABC123', 'created sets roomId');
    assert(SV('S.peerId') === 'aaa111', 'created sets peerId');

    // simulate: another peer joins
    top.handleServerMsg({ t: 'peer-added', peer: { id: 'zzz999', name: 'Phone B' } });
    assert(SV('S.peers.size') === 1, 'peer-added creates Peer');
    assert(SV('S.peers.has("zzz999")') === true, 'peer stored by id');

    // init a second time to prove idempotence/no throw during wiring
    top.init();

    // addFiles with a fake File (still in the room)
    top.addFiles([{ name: 'movie.mp4', size: 2 * 1024 * 1024, type: 'video/mp4', slice: () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) }]);
    assert(SV('S.transfers.size') === 1, 'addFiles registers a transfer');
    assert(SV('S.transfers.values().next().value.status') === 'waiting', 'transfer is queued waiting (no open peers)');

    // expired/unknown room flows through without throwing
    top.handleServerMsg({ t: 'error', code: 'NOT_FOUND' });
    top.handleServerMsg({ t: 'peer-left', peerId: 'zzz999' });
    assert(SV('S.peers.size') === 0, 'peer-left removes peer');

    if (failures === 0) { console.log('\nCLIENT SMOKE TESTS PASSED ✓'); process.exit(0); }
    process.exit(1);
  })().catch((e) => { console.error('ASYNC FAIL:', e); process.exit(1); });
} catch (e) {
  console.error('BOOT FAIL:', e && e.stack || e);
  process.exit(1);
}