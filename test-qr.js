'use strict';
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('public/vendor/qrcode.js', 'utf8');
const sandbox = { console, window: {}, document: undefined };
try {
  vm.runInNewContext(src, sandbox, { filename: 'qrcode.js' });
  const qr = sandbox.qrcode || sandbox.window.qrcode;
  if (typeof qr !== 'function') throw new Error('qrcode global not found (typeof ' + typeof qr + ')');
  const inst = qr(0, 'M');
  inst.addData('ABC123');
  inst.make();
  const modules = inst.getModuleCount();
  let dark = 0;
  for (let r = 0; r < modules; r++) for (let c = 0; c < modules; c++) if (inst.isDark(r, c)) dark++;
  console.log('qrcode module count:', modules, 'dark modules:', dark);
  if (typeof inst.createSvgTag === 'function') console.log('createSvgTag:', typeof inst.createSvgTag);
  if (modules > 0 && dark > 0) { console.log('QR LIB OK ✓'); process.exit(0); }
  throw new Error('qr made no dark modules');
} catch (e) {
  console.error('QR LIB FAIL ✗', e.message);
  process.exit(1);
}