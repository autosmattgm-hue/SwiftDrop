'use strict';
const http = require('http');
const fs = require('fs');
function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 3000, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}
(async () => {
  const html = await get('/');
  const js = await get('/client.js');
  console.log('HTML has btn-invite:', html.includes('btn-invite'));
  console.log('HTML has help-card:', html.includes('help-card'));
  console.log('JS has fetchConfig:', js.includes('fetchConfig'));
  console.log('JS has invitePeers:', js.includes('invitePeers'));
  const src = fs.readFileSync('public/client.js', 'utf8');
  const modern = [];
  if (/\?\./.test(src)) modern.push('optional chaining ?.');
  if (/\?\?/.test(src)) modern.push('nullish coalescing ??');
  if (/\.replaceAll\(/.test(src)) modern.push('replaceAll');
  if (/\.at\(/.test(src)) modern.push('.at()');
  if (/\bstructuredClone\b/.test(src)) modern.push('structuredClone');
  if (/Object\.fromEntries/.test(src)) modern.push('Object.fromEntries');
  if (/\.flat\(/.test(src)) modern.push('.flat()');
  console.log('modern-API usage in client.js:', modern.length ? modern.join(', ') : 'NONE');
})().catch((e) => { console.error(e); process.exit(1); });