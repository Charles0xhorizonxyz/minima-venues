// Run on the server after an install: start the app's Minima node with the server's own settings, read the venues from
// it, and start it again with the app after a reboot. Asks the app itself (127.0.0.1:8765), as the page would.
const B = 'http://127.0.0.1:8765', H = { origin: B, 'content-type': 'application/json' };
const s = await (await fetch(B + '/api/state', { headers: { origin: B } })).json();
const config = { ...s.node.config, autoStart: true, useForScan: true, peers: s.node.config.peers || 'megammr.minima.global:9001' };
if (['running', 'starting'].includes(s.node.phase)) {
  // already there: only make sure it starts with the app and is read
  await fetch(B + '/api/node/config', { method: 'POST', headers: H, body: JSON.stringify({ config }) });
  console.log(`NODE_OK already ${s.node.phase}`); process.exit(0);
}
const r = await (await fetch(B + '/api/node/start', { method: 'POST', headers: H, body: JSON.stringify({ config }) })).json();
const ok = r.ok || /already running/i.test(r.error || '');
console.log(ok ? 'NODE_OK started' : `NODE_FAIL ${r.error || 'refused'}`);
process.exit(ok ? 0 : 1);
