#!/usr/bin/env node
/* The dashboard's local server: scans the venues once a minute, logs each scan to data/scan-history.jsonl, runs the paper
 * market maker, and serves dashboard/index.html.
 *
 *   node tools/server.mjs            then open http://127.0.0.1:8765
 *   --port 8765  --rpc http://127.0.0.1:9105
 *
 * It listens on this computer only. Requests naming another host are refused (a web page cannot reach it by a DNS trick),
 * and a change must be sent as JSON from this page (another site's form cannot press Start).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, setRpc, setRelays, DEFAULT_RELAYS, defaultRpc } from './scan.mjs';
import { createMaker } from './mm.mjs';
import { createMexc, publicDepth as mexcDepth } from './mexc.mjs';
import { createXt, xtDepth } from './xt.mjs';
import { createNode } from './node.mjs';
import { createDesk } from './desk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(opt('port', 8765));
const PAGE = path.join(ROOT, 'dashboard', 'index.html');
const HISTORY_FILE = path.join(ROOT, 'data', 'scan-history.jsonl');
const SCAN_SECONDS = 60, WEEK = 7 * 86400000, MAX_HISTORY = 10080;
const DEPTH_BAND = 0.15, MAX_ROWS = 400;

const maker = createMaker(path.join(ROOT, 'data', 'mm-paper.json'));
const mexc = createMexc(path.join(ROOT, 'data', 'mexc-trades.jsonl'));
const xt = createXt();
const node = createNode(path.join(ROOT, 'data', 'node.json'));
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');
const SETTING_DEFAULTS = { poolConfirms: 3, fastConfirms: 1, relays: DEFAULT_RELAYS, mode: 'live' };   // PandaPools shows "Confirming n/3"; Dexicon calls a fill final after one block
let settings = { ...SETTING_DEFAULTS };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }
if (settings.mode !== 'paper' && maker.view().running) maker.stop();   // the paper maker runs only in paper mode
const scan = { ok: false, error: null, lastAt: null, nextAt: Date.now(), running: false };
setRelays(settings.relays);
let latest = null;
let history = [];
const desk = createDesk({ root: ROOT, node, clients: { mexc, xt }, depths: { mexc: mexcDepth, xt: xtDepth }, timing: () => latest?.timing, isPaper: () => settings.mode === 'paper' });

try {
  const cutoff = Date.now() - WEEK;
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.t >= cutoff) history.push(r); } catch { /* a torn last line */ }
  }
  history = history.slice(-MAX_HISTORY);
} catch { /* first run */ }

// Small on purpose: this laptop's disk is nearly full.
/* How long a route takes, and what the price can do meanwhile. Time is the block time times the confirmations waited for;
 * the risk is one standard deviation of the MEXC price over that time, on the MINIMA carried. */
function volatility() {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i], ma = a.v?.MEXC, mb = b.v?.MEXC, dt = (b.t - a.t) / 60000;
    if (!ma?.[0] || !mb?.[0] || dt < 0.4 || dt > 3) continue;
    out.push(Math.log((mb[0] + mb[1]) / (ma[0] + ma[1])) / Math.sqrt(dt));
  }
  if (out.length < 30) return { perMinute: 0.004, measured: false, samples: out.length };
  const mean = out.reduce((x, y) => x + y, 0) / out.length;
  return { perMinute: Math.sqrt(out.reduce((x, y) => x + (y - mean) ** 2, 0) / (out.length - 1)), measured: true, samples: out.length };
}

function addTiming(s) {
  const vol = volatility(), v = s.venues.MEXC, mid = v.bid && v.ask ? (v.bid + v.ask) / 2 : 0;
  const leg = (k) => (k === 'MEXC' || k === 'XT' ? 2 : (k === 'POOL' ? settings.poolConfirms : settings.fastConfirms) * s.blockSeconds);
  for (const r of s.routes) {
    r.seconds = leg(r.buy) + leg(r.sell);
    r.risk = r.qty * mid * vol.perMinute * Math.sqrt(r.seconds / 60);
    r.afterRisk = r.profit - r.risk;
  }
  s.timing = { blockSeconds: s.blockSeconds, poolSeconds: settings.poolConfirms * s.blockSeconds, fastSeconds: settings.fastConfirms * s.blockSeconds, volatility: vol, ...settings };
}

function compact(s) {
  const pair = (v) => [v.bid, v.ask];
  const best = (rows) => rows.reduce((a, r) => (r.profit > (a?.profit ?? 0) ? r : a), null);
  const paying = s.routes.filter((r) => r.profit > 0).map((r) => [r.buy, r.sell, r.qty, r.profit]);
  const top = best(s.routes), topChain = best(s.routes.filter((r) => r.onChain));
  return {
    t: Date.parse(s.at), tip: s.tip, tipAge: s.tipAge,
    v: Object.fromEntries(Object.entries(s.venues).map(([k, v]) => [k, pair(v)])),
    best: top?.profit ?? 0, bestChain: topChain?.profit ?? 0, bestAfter: Math.max(0, ...s.routes.map((r) => r.afterRisk)), blockSeconds: s.blockSeconds, paying,
    pools: s.detail.pools.list.map((p) => [p.x, p.y]),
  };
}

async function runScan() {
  const began = Date.now();
  scan.running = true;
  try {
    scan.readingFrom = setRpc(node.scanTarget());
    let s;
    try { s = await snapshot({ books: true }); }
    catch (e) {
      // The shared node is down (after a reboot it may not be up yet): read from the bot's own node instead,
      // when it runs. Reads only, as always.
      if (!node.view().live) await node.refresh().catch(() => {});
      const own = node.view().live;
      if (!/ECONNREFUSED|timed out|ECONNRESET/.test(e.message) || !own || scan.readingFrom === node.rpc()) throw e;
      scan.readingFrom = setRpc(node.rpc());
      s = await snapshot({ books: true });
    }
    addTiming(s);
    keepBooks(s);
    latest = s;
    const row = compact(s);
    history.push(row);
    history = history.slice(-MAX_HISTORY);
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(row) + '\n');
    scan.ok = true; scan.error = null; scan.lastAt = Date.now();
    maker.tick(s);
    desk.onScan(s).catch(() => {});   // take when crossed, if the armed envelope allows it
  } catch (e) {
    scan.ok = false; scan.error = e.message;
    maker.tick(null);
  }
  await mexc.sync().catch(() => {});
  await xt.sync().catch(() => {});
  scan.running = false;
  const next = Math.max(5000, began + SCAN_SECONDS * 1000 - Date.now());
  scan.nextAt = Date.now() + next;
  setTimeout(runScan, next);
}

function trimBooks() {
  if (!latest) return null;
  const v = latest.venues.MEXC, mid = v.bid && v.ask ? (v.bid + v.ask) / 2 : null;
  const near = (rows) => (mid ? rows.filter((r) => Math.abs(r.price / mid - 1) <= DEPTH_BAND) : rows).slice(0, MAX_ROWS);
  return Object.fromEntries(Object.entries(latest.books).map(([k, b]) => [k, { asks: near(b.asks), bids: near(b.bids) }]));
}

function latestMid() { const v = latest?.venues.MEXC; return v?.bid && v?.ask ? (v.bid + v.ask) / 2 : null; }

/* The Dexicon relays the scan reads. Anything a relay says is checked anyway (signatures, coins on the node), so a bad
 * relay can hide orders but never fake one. https only, at most 6. */
/* The app's mode. Paper: the live desk is disarmed and refuses to arm, send or take; the paper maker may run. Live: the
 * paper maker is stopped (its record kept). */
function setMode(body) {
  const mode = body?.mode;
  if (mode !== 'live' && mode !== 'paper') return { error: 'The mode is live or paper.' };
  if (mode === 'paper' && desk.armed()) desk.disarm('the app switched to paper mode');
  if (mode === 'live' && maker.view().running) maker.stop();
  settings = { ...settings, mode };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
  return { ok: true };
}

function setRelaysSetting(body) {
  const raw = Array.isArray(body?.relays) ? body.relays : String(body?.relays ?? '').split(/[\s,]+/);
  const list = [...new Set(raw.map((x) => String(x).trim().replace(/\/+$/, '')).filter(Boolean))];
  if (!list.length) return { error: 'Give at least one relay.', field: 'relays' };
  if (list.length > 6) return { error: 'At most 6 relays.', field: 'relays' };
  for (const r of list) {
    let u; try { u = new URL(r); } catch { return { error: `Not an address: ${r}`, field: 'relays' }; }
    if (u.protocol !== 'https:' || u.search || u.hash || u.username) return { error: `A relay is a plain https address, like https://eurobuddha.com/dex-relay: ${r}`, field: 'relays' };
  }
  settings = { ...settings, relays: list };
  setRelays(list);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
  return { ok: true };
}
function setSettings(body) {
  const p = Number(body?.poolConfirms), f = Number(body?.fastConfirms);
  if (!Number.isInteger(p) || p < 1 || p > 20) return { error: 'Pool confirmations must be a whole number from 1 to 20.', field: 'poolConfirms' };
  if (!Number.isInteger(f) || f < 1 || f > 20) return { error: 'Dexicon confirmations must be a whole number from 1 to 20.', field: 'fastConfirms' };
  settings = { ...settings, poolConfirms: p, fastConfirms: f };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
  if (latest) addTiming(latest);
  return { ok: true };
}

/* The chain tip, followed between scans: from the bot's own node every 5 s once it runs and is in sync, otherwise from
 * the shared read node every 30 s (the handshake: shared nodes are polled no faster than that). One command only: block. */
const TIP_OWN_MS = 5000, TIP_SHARED_MS = 30000;
const tipNow = { block: null, timemilli: null, source: null, readAt: null, error: null };
function readBlock(rpcUrl) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from('block', 'utf8');
    const req = http.request(rpcUrl, { method: 'POST', agent: false, insecureHTTPParser: true, timeout: 8000, headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (d) => { text += d; });
      res.on('end', () => { try { const j = JSON.parse(text); j.status ? resolve(j.response) : reject(new Error(j.error || 'block failed')); } catch { reject(new Error('block: reply was not JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('block: timed out'))); req.on('error', reject); req.end(body);
  });
}
async function followTip() {
  const own = node.view().live, useOwn = !!(own && own.tipAge < 600);
  const url = useOwn ? node.rpc() : defaultRpc();
  try {
    const b = await readBlock(url);
    Object.assign(tipNow, { block: Number(b.block), timemilli: Number(b.timemilli), source: useOwn ? 'bot node' : 'shared node', readAt: Date.now(), error: null });
  } catch (e) { tipNow.error = e.message; }
  setTimeout(followTip, useOwn ? TIP_OWN_MS : TIP_SHARED_MS);
}

/* A venue that did not answer this scan (MEXC, XT, or every Dexicon relay): its last good book stands in, for the order
 * book view only and at most 10 minutes old, marked with its age. Prices, routes and trades use only this scan's reads. */
const STALE_LIMIT = 600000, lastGood = {};
function keepBooks(s) {
  const failed = { MEXC: !!s.detail.mexcError, XT: !!s.detail.xtError, FAST: s.detail.fast.relays.every((r) => !r.ok) };
  s.staleBooks = {};
  for (const k of Object.keys(failed)) {
    const b = s.books[k];
    if (!failed[k]) { lastGood[k] = { at: Date.now(), book: b }; continue; }
    if (lastGood[k] && Date.now() - lastGood[k].at < STALE_LIMIT) { s.books[k] = lastGood[k].book; s.staleBooks[k] = Math.round((Date.now() - lastGood[k].at) / 1000); }
  }
}

function stateJson() {
  return {
    now: Date.now(), tip: tipNow, scan, scanSeconds: SCAN_SECONDS, historyCount: history.length, maker: maker.view(), mexc: mexc.view(latestMid()), xt: xt.view(), node: node.view(), settings, desk: desk.view(latestMid()),
    snapshot: latest && { at: latest.at, tip: latest.tip, tipAge: latest.tipAge, timing: latest.timing, venues: latest.venues, routes: latest.routes, detail: latest.detail, books: trimBooks(), staleBooks: latest.staleBooks || {} },
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (d) => { size += d.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('not JSON')); } });
    req.on('error', reject);
  });
}

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));

const server = http.createServer(async (req, res) => {
  if (!HOSTS.has(req.headers.host)) return send(res, 403, { ok: false, error: 'wrong host' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    try {
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
      if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico') return send(res, 200, fs.readFileSync(path.join(ROOT, 'dashboard', 'logo.svg')), 'image/svg+xml');
      if (url.pathname === '/api/state') return send(res, 200, stateJson());
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    if (url.pathname === '/api/history') return send(res, 200, history);
    return send(res, 404, { ok: false, error: 'not found' });
  }

  if (req.method === 'POST') {
    const sameSite = (!req.headers.origin || ORIGINS.has(req.headers.origin)) && String(req.headers['content-type']).startsWith('application/json');
    if (!sameSite) return send(res, 403, { ok: false, error: 'refused' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    const actions = {
      '/api/mm/config': () => maker.setConfig(body.config),
      '/api/mm/start': () => (settings.mode === 'paper' ? maker.start(body.config) : { error: 'The paper maker runs only in paper mode. Switch to paper in Settings.' }),
      '/api/mm/stop': () => maker.stop(),
      '/api/mm/reset': () => maker.reset(),
      '/api/settings': () => setSettings(body),
      '/api/settings/relays': () => setRelaysSetting(body),
      '/api/settings/mode': () => setMode(body),
      '/api/mexc/connect': () => mexc.connect(body),
      '/api/mexc/disconnect': () => mexc.disconnect(),
      '/api/xt/connect': () => xt.connect(body),
      '/api/xt/disconnect': () => xt.disconnect(),
      '/api/node/config': () => node.setConfig(body.config),
      '/api/node/start': () => node.start(body.config),
      '/api/node/stop': () => node.stop(),
      '/api/node/peer': () => node.addPeer(body),
      '/api/node/resync': () => (desk.armed() ? { error: 'Disarm the desk in Settings first: a trade must never wait on a node that is rebuilding its chain.' } : node.resync(body)),
      '/api/live/envelope': () => desk.writeEnvelope(body),
      '/api/live/arm': () => desk.arm(),
      '/api/live/disarm': () => desk.disarm(),
      '/api/live/release': () => desk.release(body),
      '/api/live/preview': () => desk.preview(body),
      '/api/live/send': () => desk.send(body),
    };
    const act = actions[url.pathname];
    if (!act) return send(res, 404, { ok: false, error: 'not found' });
    let r;
    try { r = await act(); } catch (e) { r = { error: e.message }; }
    return send(res, r.error ? 400 : 200, r.error ? { ok: false, ...r } : { ...stateJson(), ...r, ok: true });
  }
  return send(res, 405, { ok: false, error: 'method' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${PORT}`);
  mexc.loadKey();
  xt.loadKey();
  node.refresh();
  setInterval(() => node.refresh(), 15000);
  runScan();
  setTimeout(followTip, 3000);
  // A heartbeat in data/server.log: any moment this server was held up over 2 s (a busy machine, a stuck call), and one
  // line an hour, so a stall leaves a trace of when it happened.
  let beat = Date.now(), lastHourly = Date.now();
  setInterval(() => {
    const now = Date.now(), late = now - beat - 5000;
    const last = scan.lastAt ? new Date(scan.lastAt).toISOString() : 'none';
    if (late > 2000) console.log(`${new Date(now).toISOString()} held up ${Math.round(late / 1000)} s (scan ${scan.running ? 'running' : 'idle'}, last scan ${last})`);
    if (now - lastHourly > 3600000) { console.log(`${new Date(now).toISOString()} alive, last scan ${last}`); lastHourly = now; }
    beat = now;
  }, 5000).unref();
});
