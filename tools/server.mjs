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
import { candles, INTERVALS } from './candles.mjs';
import { createParlons } from './parlons.mjs';
import { secrets, secretDir } from './secrets.mjs';
import { createBay } from './bay.mjs';
import { createPilot } from './pilot.mjs';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import os from 'node:os';
const pilot = createPilot(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'data', 'pilot.json'));

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
// Minima Bay (paper mode): The Rapids and The Pool, with test tokens, through the app's own node.
const bay = createBay({ root: ROOT, rpc: () => node.rpc(), secretDir, mode: () => settings.mode });
let bayBusy = false;
const bayTick = async () => { if (bayBusy) return; bayBusy = true; try { await bay.refresh(); } catch { /* shown in its view */ } finally { bayBusy = false; } };
setInterval(bayTick, 10000); setTimeout(bayTick, 3000);
let latest = null;
let history = [];
let parlonsStop = false;   // the last disarm came from a Parlons "stop": not an alert
const deskRef = {};
const parlons = createParlons({
  file: path.join(ROOT, 'data', 'parlons.json'), call: (cmd, t) => node.maxima(cmd, t), port: PORT,
  actions: {
    status: () => {
      const d = desk.view(latestMid()), n = node.view(), mx = latest?.venues?.MEXC;
      return [`Mode: ${settings.mode}. Desk: ${d.armed ? 'ARMED' : 'disarmed'}${d.envelope ? `, run ${d.run}` : ', no envelope'}${d.blocks.length ? `, ${d.blocks.length} block(s)` : ''}, ${d.today} trade(s) today.`,
        `Node: ${n.phase}${n.live ? `, block ${n.live.tip}, ${n.live.tipAge} s old` : ''}.`,
        `MEXC ${mx?.bid ?? '-'} / ${mx?.ask ?? '-'}. Maker: ${maker.view().running ? 'running on paper' : 'stopped'}. Scans: ${scan.ok ? 'ok' : scan.error || 'starting'}.`].join(' ');
    },
    price: () => {
      const v = latest?.venues; if (!v) return 'No scan yet.';
      const mid = (x) => (x?.bid && x?.ask ? ((x.bid + x.ask) / 2).toFixed(6) : '-');
      const NM = { FAST: 'Dexicon', POOL: 'PandaPools', MEXC: 'MEXC', XT: 'XT' };
      const r = (latest.routes || []).filter((x) => x.qty > 0).sort((a, b) => b.afterRisk - a.afterRisk)[0];
      return `Mids: MEXC ${mid(v.MEXC)}, XT ${mid(v.XT)}, Dexicon ${mid(v.FAST)}, PandaPools ${mid(v.POOL)}.${r ? ` Best route: buy ${NM[r.buy]}, sell ${NM[r.sell]}, ${Math.round(r.qty)} MINIMA, ${r.afterRisk.toFixed(3)} MxUSD after time risk.` : ''}`;
    },
    stop: () => {
      parlonsStop = true; desk.disarm('stopped from Parlons');
      const m = maker.view().running ? (maker.stop(), ' The paper maker is stopped.') : '';
      return `Stopped: automatic trading is off (the desk is disarmed).${m} Your own trades from the page still work in live mode.`;
    },
    cannotArm: () => {
      const d = desk.view(latestMid());
      if (settings.mode === 'paper') return 'the app is in paper mode.';
      if (!d.envelope) return 'no envelope is written.';
      if (d.armed) return 'it is already armed.';
      if (d.blocks.length) return 'something is blocked: release it in Settings first.';
      return null;
    },
    locked: () => secrets.view().locked && (mexc.hasStoredKey() || xt.hasStoredKey()),
    unlock: async (pass) => { const r = await unlockVault(pass); return r.error ? `Not unlocked: ${r.error}` : 'Unlocked: the exchange keys are readable again. Delete the message with the passphrase from this chat.'; },
    arm: () => { const r = desk.arm(); if (r.error) return `Not armed: ${r.error}`; parlonsStop = false; return 'ARMED: automatic trading is on inside the envelope. Send "stop" to turn it off.'; },
  },
});
const desk = createDesk({ root: ROOT, node, clients: { mexc, xt }, depths: { mexc: mexcDepth, xt: xtDepth }, timing: () => latest?.timing, isPaper: () => settings.mode === 'paper' });

try {
  const cutoff = Date.now() - WEEK;
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.t >= cutoff) history.push(r); } catch { /* a torn last line */ }
  }
  history = history.slice(-MAX_HISTORY);
} catch { /* first run */ }

// Small on purpose: this computer's disk is nearly full.
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
      // The shared node is down (after a reboot it may not be up yet): read from its own node instead,
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
    parlonsWatch();
  } catch (e) {
    scan.ok = false; scan.error = e.message;
    maker.tick(null);
    parlonsWatch();
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
  // Near the market, plus every level that holds one of your open orders on that exchange, however far out.
  const mine = { MEXC: mexc.view(mid)?.openOrders || [], XT: xt.view()?.openOrders || [] };
  const near = (k, rows) => { const own = new Set((mine[k] || []).map((o) => Number(o.price).toFixed(8))); return (mid ? rows.filter((r) => Math.abs(r.price / mid - 1) <= DEPTH_BAND || own.has(Number(r.price).toFixed(8))) : rows).slice(0, MAX_ROWS); };
  return Object.fromEntries(Object.entries(latest.books).map(([k, b]) => [k, { asks: near(k, b.asks), bids: near(k, b.bids) }]));
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

/* The chain tip, followed between scans: from its own node every 5 s once it runs and is in sync, otherwise from
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
    Object.assign(tipNow, { block: Number(b.block), timemilli: Number(b.timemilli), source: useOwn ? 'node' : 'shared node', readAt: Date.now(), error: null });
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

// The MEXC mid about 24 hours ago, from the scan log (the first scan in the hour after that time).
function mid24h() {
  const t0 = Date.now() - 86400000, r = history.find((h) => h.t >= t0 && h.t < t0 + 3600000 && h.v?.MEXC?.[0] && h.v?.MEXC?.[1]);
  return r ? (r.v.MEXC[0] + r.v.MEXC[1]) / 2 : null;
}
// Several levels at once: each is an alert above or below, from where the mid is now.
function addLevels(text) {
  const mid = latestMid(), list = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!list.length) return { error: 'Type one or more prices, like 0.0028, 0.0030, 0.0032.', field: 'pLevels' };
  if (!(mid > 0)) return { error: 'No MEXC price yet: wait for a scan.' };
  for (const p of list) { const r = parlons.addPrice(Number(p) >= mid ? 'above' : 'below', p); if (r.error) return r; }
  return { ok: true };
}
// The key store (a server's passphrase vault): unlocking reads the exchange keys again.
async function unlockVault(pass) {
  const r = await secrets.unlock(pass);
  if (r.error) return r;
  await mexc.reloadKey(); await xt.reloadKey();
  mexc.sync().catch(() => {}); xt.sync().catch(() => {});
  return { ok: true };
}
async function setupVault(pass) { const r = await secrets.setup(pass); return r; }
// This app's version: the VERSION file a server install writes, or here the git commit (+local when changed since).
function appVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { /* not an install */ }
  try {
    const h = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, windowsHide: true }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, windowsHide: true }).toString().trim();
    return h + (dirty ? '+local' : '');
  } catch { return 'unknown'; }
}
// The program sent to a server: tools, dashboard, vendor, the licence and README, and its VERSION (never data/ or keys).
function appArchive() {
  const v = appVersion(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-pack-'));
  fs.writeFileSync(path.join(tmp, 'VERSION'), v + '\n');
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar', out = tmp + '.tgz';
  return new Promise((resolve, reject) => {
    const child = spawnChild(tar, ['-czf', out, '-C', ROOT, 'tools', 'dashboard', 'vendor', 'LICENSE', 'README.md', '-C', tmp, 'VERSION'], { windowsHide: true, stdio: 'ignore' });
    child.on('close', (code) => { fs.rmSync(tmp, { recursive: true, force: true }); code === 0 ? resolve(out) : reject(new Error('The app could not be packed.')); });
    child.on('error', reject);
  });
}
const pilotView = () => ({ ...pilot.view(), laptopVersion: appVersion() });
function parlonsWatch() {
  parlons.watch({ scan, snapshot: latest, desk: desk.view(latestMid()), node: node.view(), ownStop: () => parlonsStop, mid24: mid24h() }).catch(() => {});
}

function stateJson() {
  return {
    now: Date.now(), tip: tipNow, scan, scanSeconds: SCAN_SECONDS, historyCount: history.length, maker: maker.view(), mexc: mexc.view(latestMid()), xt: xt.view(), node: node.view(), settings, desk: desk.view(latestMid()), parlons: parlons.view(), vault: secrets.view(), platform: process.platform, version: appVersion(), pilot: pilotView(), bay: bay.view(),
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

  if (req.method === 'GET' && pilot.active() && url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/state') {
      try { const r = await pilot.remoteState(); if (r) return send(res, 200, { ...r, pilot: pilotView(), remote: true }); } catch (e) { /* below */ }
      return send(res, 200, { ...stateJson(), remote: false, remoteError: 'The server is not reachable: this page shows this computer until the tunnel is back.' });
    }
    return pilot.forward(req, res);
  }
  if (req.method === 'GET') {
    try {
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
      if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico') return send(res, 200, fs.readFileSync(path.join(ROOT, 'dashboard', 'logo.svg')), 'image/svg+xml');
      if (url.pathname === '/api/state') return send(res, 200, stateJson());
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    if (url.pathname === '/api/history') return send(res, 200, history);
    if (url.pathname === '/api/bay/candles') {
      const iv = INTERVALS[String(url.searchParams.get('interval'))], venue = url.searchParams.get('venue') === 'POOL' ? 'POOL' : 'RAPIDS';
      const r = !iv ? { error: 'Unknown interval.' } : { candles: bay.candles(String(url.searchParams.get('market')), venue, iv.ms), source: `${venue === 'POOL' ? "The Pool's" : "The Rapids'"} mid price, read by this app once a minute` };
      return send(res, r.error ? 400 : 200, r.error ? { ok: false, ...r } : r);
    }
    if (url.pathname === '/api/candles') {
      const r = await candles(String(url.searchParams.get('venue')), String(url.searchParams.get('interval')), history).catch((e) => ({ error: e.message }));
      return send(res, r.error ? 400 : 200, r.error ? { ok: false, ...r } : r);
    }
    return send(res, 404, { ok: false, error: 'not found' });
  }

  // The node's webhook: a secret path, from this computer only. Only the paired Parlons key is acted on.
  if (req.method === 'POST' && url.pathname.startsWith('/api/hook/')) {
    const ok = url.pathname === `/api/hook/${parlons.token()}` && req.socket.remoteAddress && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress);
    if (!ok) return send(res, 404, { ok: false, error: 'not found' });
    let ev; try { ev = await readBody(req); } catch { return send(res, 400, 'bad'); }
    parlons.onEvent(ev).catch(() => {});
    return send(res, 200, 'ok', 'text/plain');
  }

  if (req.method === 'POST') {
    const sameSite = (!req.headers.origin || ORIGINS.has(req.headers.origin)) && String(req.headers['content-type']).startsWith('application/json');
    if (!sameSite) return send(res, 403, { ok: false, error: 'refused' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    const pilotCalls = {
      '/api/pilot/key': async () => ({ publicKey: await pilot.publicKey() }),
      '/api/pilot/add': () => pilot.add(body),
      '/api/pilot/remove': () => pilot.remove(String(body.id)),
      '/api/pilot/rename': () => pilot.rename(String(body.id), body.name),
      '/api/pilot/connect': () => pilot.connect(String(body.id)),
      '/api/pilot/disconnect': () => pilot.disconnect(),
      '/api/pilot/check': () => pilot.check(String(body.id)),
      '/api/pilot/install': () => pilot.install(String(body.id), { password: String(body.password || ''), app: appArchive, jar: node.view().config.jarPath, setup: body.setup === true, startNode: body.startNode === true }),
    };
    if (pilotCalls[url.pathname]) {
      let r; try { r = await pilotCalls[url.pathname](); } catch (e) { r = { error: e.message }; }
      return send(res, r.error ? 400 : 200, r.error ? { ok: false, ...r, pilot: pilotView() } : { ...r, ok: true, pilot: pilotView() });
    }
    if (pilot.active()) return pilot.forward(req, res, JSON.stringify(body));
    const actions = {
      '/api/bay/order': () => bay.order(body),
      '/api/bay/cancel': () => bay.cancel(body),
      '/api/bay/deposit': () => bay.deposit(body),
      '/api/bay/address': () => bay.address(),
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
      '/api/vault/setup': () => setupVault(body.passphrase),
      '/api/vault/unlock': () => unlockVault(body.passphrase),
      '/api/vault/lock': () => secrets.lock(),
      '/api/parlons/pair': () => parlons.pair(body),
      '/api/parlons/unpair': () => parlons.unpair(),
      '/api/parlons/test': () => parlons.test(),
      '/api/parlons/alerts': () => parlons.setAlerts(body),
      '/api/parlons/price': () => (body.remove ? parlons.removePrice(String(body.remove)) : body.levels !== undefined ? addLevels(body.levels) : parlons.addPrice(String(body.dir), String(body.price).trim())),
      '/api/node/resync': () => (desk.armed() ? { error: 'Disarm the desk in Settings first: a trade must never wait on a node that is rebuilding its chain.' } : node.resync(body)),
      '/api/live/envelope': () => desk.writeEnvelope(body),
      '/api/live/arm': () => { const r = desk.arm(); if (!r.error) parlonsStop = false; return r; },
      '/api/live/disarm': () => { parlonsStop = true; return desk.disarm(); },
      '/api/live/release': () => desk.release(body),
      '/api/live/preview': () => desk.preview(body),
      '/api/live/send': () => desk.send(body),
      '/api/live/cancel': () => desk.cancelOrder(body),
      '/api/live/modify': () => desk.modifyOrder(body),
      '/api/live/rest': () => desk.restOrder(body),
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
  node.refresh().then(() => {
    // A server that rebooted starts its node again, when that is set.
    const v = node.view();
    if (v.config.autoStart && !v.watching && v.phase === 'stopped') node.start(v.config).then((r) => console.log(r.error ? `Node autostart: ${r.error}` : 'Node autostart: starting')).catch(() => {});
  });
  setInterval(() => node.refresh(), 15000);
  setTimeout(() => parlons.ensureHook(), 20000);
  pilot.resume().catch(() => {});
  setInterval(() => parlons.ensureHook(), 300000);
  setInterval(parlonsWatch, 30000);
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
