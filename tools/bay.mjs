/* Minima Bay: the test platform for our two DEXes (founder, 2026-11-12: "the paper trade should be all linked to our app
 * Minima Bay ... the onchain one from The Pool and the offchain one from The Rapids ... the testing platform for our 2
 * dexes"; real test orders, Winiwa/USDx and ETHx/USDx, the Pool read from the app's own node).
 *
 *   - The Rapids: an off-chain book run by three matchers (https://rapids.minimabay.org/m1..m3). Read over HTTPS; an
 *     order or a cancel is signed with a session key (Ed25519) that the app's node authorised once with one signature.
 *     Funds are deposited into the venue's vault on chain first (a send with the owner in its state).
 *   - The Pool: an on-chain book, every order a coin held by a covenant. Read, placed, taken and cancelled by The
 *     Pool's own engine (The bay\Rapids\mm\pool-engine.mjs, which runs The Pool's page files unedited), against the
 *     app's own node.
 *
 * Neither venue's code is copied here: it is imported at run time from the Minima Bay folder (BAY_DIR, by default
 * Documents\The bay), and without that folder this part of the app is simply off.
 *
 * TEST ASSETS ONLY. Every command to the node from here goes through vet(): a send, an output, an input or a
 * consolidation may move only Winiwa, USDx or ETHx (never MINIMA, MxUSD or any other token), a send goes only to The
 * Pool's contracts, a Rapids vault or the node's own address, the only signature is the Rapids session authorisation,
 * and nothing that reads or exports a seed, a key or a backup exists here. The node is the app's own (never a shared
 * port). Nothing here is audited. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TOKENS = {
  '0xD4F5DD3546F25D327CBF2B6867E193CE5DB6491AC9C65BBDCECACA1A6688063F': 'Winiwa',
  '0xF4771A12F9BBF8259EFF50AB5B2E8C3D0088C64AD692EBC782F506A4B2F6E9FA': 'USDx',
  '0xA01DBBFB26105B4FD0A8250FE0A5015BEED4F92CB115A79E7088305CFFDB926E': 'ETHx',
};
const TEST = new Set(Object.keys(TOKENS));
const WINIWA = '0xD4F5DD3546F25D327CBF2B6867E193CE5DB6491AC9C65BBDCECACA1A6688063F';
// The Pool's own contracts (Pool/2_development/contracts/deployed/manifest.json): order covenant v2.2, book snapshot head and pages.
const POOL_CONTRACTS = ['0xF139672988BA32DBC5BA85A5A1BA969C4864DD1BCFAB090F40DA5FAE9540641A',
  '0xEE2092615F1B217394B51D9F3226667DDA9FE98A4324654391A866EF942F5A33', '0xB7B8313D31E6B56ADD1DBA1A74A0C0E33956EDE4A8A71609816381551E31387A'];
const SHARED_RPC_PORTS = new Set([9005, 9105, 9205, 9305, 9405, 10005]);
export const MATCHERS = ['https://rapids.minimabay.org/m1', 'https://rapids.minimabay.org/m2', 'https://rapids.minimabay.org/m3'];
const ATOMS = 100000000n;
const up = (h) => String(h || '').toUpperCase().replace(/^0X/, '0x');

// Decimal text <-> atoms (1e8), exactly, never through a float.
export function atomsOf(v) {
  const s = String(v).replace(/,/g, '').trim();
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m) throw new Error('Enter a number with up to 8 decimals.');
  return BigInt(m[1]) * ATOMS + BigInt((m[2] || '').padEnd(8, '0') || '0');
}
export const unitsOf = (a) => { const b = BigInt(a), w = b / ATOMS, f = (b % ATOMS).toString().padStart(8, '0').replace(/0+$/, ''); return f ? `${w}.${f}` : String(w); };

const READS = new Set(['block', 'status', 'balance', 'coins', 'getaddress', 'keys', 'scripts', 'checkaddress', 'history', 'txpow',
  'coinexport', 'coincheck', 'coinimport', 'newscript', 'hash', 'verify', 'txnlist', 'txnexport']);
const TXN = new Set(['txncreate', 'txndelete', 'txnbasics', 'txnstate', 'txncheck', 'txnsign', 'txnpost']);
const arg = (c, k) => ((new RegExp(`(?:^|\\s)${k}:(\\S+)`).exec(c) || [])[1] || '');

export function createBay({ root, rpc, secretDir, mode, log = () => {} }) {
  const BAY = process.env.BAY_DIR || path.join(os.homedir(), 'Documents', 'The bay');
  const ENGINE = path.join(BAY, 'Rapids', 'matcher', 'engine.mjs'), ADAPTERS = path.join(BAY, 'Rapids', 'matcher', 'adapters.mjs');
  const POOLENG = path.join(BAY, 'Rapids', 'mm', 'pool-engine.mjs');
  const available = () => [ENGINE, ADAPTERS, POOLENG].every((f) => fs.existsSync(f));
  const DATA = path.join(root, 'data', 'bay');
  const KEYFILE = path.join(secretDir(), 'bay', 'rapids-session.json');
  const journal = path.join(DATA, 'journal.jsonl');
  const note = (o) => { try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch {} };

  let R = null;            // the Rapids modules, once loaded
  let conf = null, confAt = 0;
  let pool = null, poolOpening = null, poolBook = null, poolAt = 0, poolErr = null, rebuiltAt = 0, poolBusy = false;
  let rapids = {}, rapidsAt = 0, rapidsErr = null, status = [];
  let account = null, wallet = null, ident = null, mine = [];
  const vaults = new Set();
  // Each venue's mid, once a minute, for the chart (The Rapids trades too rarely for candles of its own trades).
  const MIDS = path.join(DATA, 'mids.jsonl');
  let mids = [];
  try { const since = Date.now() - 8 * 86400000; mids = fs.readFileSync(MIDS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t >= since); } catch { /* none yet */ }
  const midOf = (b) => (b && b.bids[0] && b.asks[0] ? (b.bids[0].price + b.asks[0].price) / 2 : null);
  function keepMids() {
    const now = Date.now();
    if (mids.length && now - mids.at(-1).t < 55000) return;
    const r = { t: now, m: {} };
    for (const [k, b] of Object.entries(rapids)) { const x = midOf(b); if (x) r.m['R' + k.slice(2, 10)] = x; }
    const p = poolBook && midOf(poolBook); if (p) r.m.P = p;
    if (!Object.keys(r.m).length) return;
    mids.push(r); mids = mids.filter((x) => x.t >= now - 8 * 86400000);
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(MIDS, JSON.stringify(r) + '\n'); } catch {}
  }
  const signable = new Set();   // the one data value a `sign` may carry, set just before it is sent
  const owned = new Map();      // address -> the node said it is its own

  /* ---- the node, through vet() ---- */
  const nodeUrl = () => {
    const u = rpc();
    const p = new URL(u);
    if (SHARED_RPC_PORTS.has(Number(p.port)) || !/^(127\.0\.0\.1|localhost)$/.test(p.hostname)) throw new Error('Minima Bay works only through the app\'s own node on this computer.');
    return u.replace(/\/$/, '');
  };
  function raw(cmd, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(cmd, 'utf8');
      const req = http.request(nodeUrl() + '/', { method: 'POST', agent: false, timeout, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length } }, (res) => {
        const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      });
      req.on('timeout', () => req.destroy(new Error('the node timed out')));
      req.on('error', reject); req.end(body);
    });
  }
  async function own(addr) {
    const a = up(addr);
    if (!owned.has(a)) { const r = JSON.parse(await raw('checkaddress address:' + a).catch(() => '{}') || '{}'); owned.set(a, !!(r.status && r.response && r.response.relevant === true)); }
    return owned.get(a);
  }
  async function coinToken(id) {
    const r = JSON.parse(await raw('coins coinid:' + id).catch(() => '{}') || '{}');
    const c = Array.isArray(r.response) ? r.response[0] : null;
    return c ? up(c.tokenid) : null;
  }
  // null when the command may go; otherwise why not.
  async function vet(one) {
    const c = String(one).trim(), verb = (c.split(/\s+/)[0] || '').toLowerCase();
    if (/\bburn:/i.test(c)) return 'nothing is burnt from here';   // a burn adds MINIMA from the wallet
    if (/\b(file|password|phrase|seed):/i.test(c)) return 'no file, password or seed travels through here';
    if (READS.has(verb)) return null;
    if (verb === 'sign') return /^sign publickey:0x[0-9A-F]{64} data:(0x[0-9A-F]{64})$/.test(c) && signable.has(arg(c, 'data')) ? null : 'only the Rapids session can be signed';
    if (TXN.has(verb)) return null;
    if (verb === 'txnoutput') return TEST.has(up(arg(c, 'tokenid'))) ? null : 'an output may carry only Winiwa, USDx or ETHx';
    if (verb === 'txninput') {
      const id = arg(c, 'coinid');
      if (!/^0x[0-9A-Fa-f]{64}$/.test(id)) return 'an input is taken only by its coin id';
      return TEST.has(await coinToken(id)) ? null : 'an input may spend only a Winiwa, USDx or ETHx coin';
    }
    if (verb === 'consolidate') return TEST.has(up(arg(c, 'tokenid'))) ? null : 'only a test token can be consolidated';
    if (verb === 'send') {
      if (/\b(multi|fromaddress|signkey|password|mine):/i.test(c)) return 'that kind of send is not used here';
      if (!TEST.has(up(arg(c, 'tokenid')))) return 'a send may move only Winiwa, USDx or ETHx';
      const to = up(arg(c, 'address'));
      if (POOL_CONTRACTS.includes(to) || vaults.has(to) || (to && await own(to))) return null;
      return 'a send goes only to The Pool, a Rapids vault or this node';
    }
    return `"${verb}" is not used here`;
  }
  async function node(cmd, timeout) {
    for (const p of cmd.split(';')) { const why = await vet(p); if (why) { note({ refused: p.slice(0, 160), why }); throw new Error('Refused: ' + why + '.'); } }
    const j = JSON.parse(await raw(cmd, timeout));
    if (!j.status) throw new Error(j.error || 'the node said no');
    return j.response;
  }
  // The Pool engine's node: a local stand-in in front of the real one, where every command is vetted the same way.
  let proxy = null;
  function proxyUrl() {
    if (proxy) return proxy.url;
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const parts = []; req.on('data', (d) => parts.push(d));
        req.on('end', async () => {
          const cmd = req.method === 'POST' ? Buffer.concat(parts).toString('utf8') : decodeURIComponent(req.url.slice(1));
          const answer = (t) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(t); };
          for (const p of cmd.split(';').filter((x) => x.trim())) {
            const why = await vet(p);
            if (why) { note({ refused: p.slice(0, 160), why }); return answer(JSON.stringify({ status: false, error: 'Refused by the app: ' + why })); }
          }
          raw(cmd).then(answer, (e) => { res.writeHead(502); res.end(String(e.message)); });
        });
      });
      srv.listen(0, '127.0.0.1', () => { proxy = { srv, url: `http://127.0.0.1:${srv.address().port}` }; resolve(proxy.url); });
    });
  }

  /* ---- The Rapids ---- */
  const load = async () => {
    if (R) return R;
    const [e, a] = await Promise.all([import(pathToFileURL(ENGINE).href), import(pathToFileURL(ADAPTERS).href)]);
    R = { orderMessage: e.orderMessage, cancelMessage: e.cancelMessage, orderId: e.orderId, sessionData: a.sessionData };
    return R;
  };
  const get = (m, p, ms = 8000) => fetch(m + p, { cache: 'no-store', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // The first matcher that answers; a 502/503/504 tries the next, and if all say so their own reason is given.
  async function call(p, body) {
    let why = null;
    for (const m of MATCHERS) {
      try {
        const r = await fetch(m + p, body === undefined ? { cache: 'no-store', signal: AbortSignal.timeout(15000) } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if ([502, 503, 504].includes(r.status)) { why = (await r.json().catch(() => null))?.why || why; continue; }
        return await r.json();
      } catch { /* the next matcher */ }
    }
    throw new Error(why ? 'The Rapids: ' + why : 'No Rapids matcher answered.');
  }
  async function venue() {
    if (conf && Date.now() - confAt < 600000) return conf;
    const c = await call('/config');
    const markets = (Array.isArray(c.markets) && c.markets.length ? c.markets : [c.market]).filter((m) => m && TEST.has(up(m.base)) && TEST.has(up(m.quote)));
    for (const t of Object.values(c.contracts || {})) if (t && t.vault) vaults.add(up(t.vault));
    conf = { venue: c.venue, markets: markets.map((m) => ({ base: up(m.base), quote: up(m.quote), baseName: m.baseName, quoteName: m.quoteName, ref: Number(m.refPrice) / 1e8 })), contracts: c.contracts || {} };
    confAt = Date.now();
    return conf;
  }
  const lv = (rows) => (rows || []).map(([p, s]) => ({ price: Number(p) / 1e8, qty: Number(s) }));
  async function readRapids() {
    const c = await venue(), out = {};
    status = await Promise.all(MATCHERS.map(async (m, i) => { const s = await get(m, '/status', 6000); return { id: 'm' + (i + 1), ok: !!s, block: s?.block ?? null, leader: s?.leader ?? null, frozen: s?.frozen ?? null, batches: s?.batches ?? null }; }));
    for (const mk of c.markets) {
      const books = (await Promise.all(MATCHERS.map((m) => get(m, `/book?market=${mk.base}&depth=60`)))).filter((b) => b && Array.isArray(b.bids) && Array.isArray(b.asks));
      const top = (b) => `${b.bids[0]?.[0] ?? '-'}|${b.asks[0]?.[0] ?? '-'}`;
      const agreed = books.some((b, i) => books.some((x, j) => j !== i && top(x) === top(b)));
      const best = books.sort((a, b) => (b.batch ?? 0) - (a.batch ?? 0))[0];
      out[mk.base] = best ? { bids: lv(best.bids), asks: lv(best.asks), last: best.last ? Number(best.last) / 1e8 : null, batch: best.batch, answered: books.length, agreed } : { bids: [], asks: [], answered: 0, agreed: false };
    }
    rapids = out; rapidsAt = Date.now(); rapidsErr = null;
  }

  /* who trades: one of the node's addresses, kept, with a session key it authorised once */
  async function identity(needSession = true) {
    if (ident) return ident;
    await load();
    let k = null; try { k = JSON.parse(fs.readFileSync(KEYFILE, 'utf8')); } catch { /* first time */ }
    if (k && k.owner && !(await own(k.owner))) k = null;   // another node: a new identity
    if (!k) {
      const a = await node('getaddress');
      const kp = crypto.generateKeyPairSync('ed25519');
      k = { owner: up(a.address), publickey: up(a.publickey), key: kp.publicKey.export({ format: 'jwk' }).x, private: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }), signature: null };
    }
    if (!k.signature) {
      const data = R.sessionData(k.owner, k.key);
      signable.add(data);
      try { const s = await node(`sign publickey:${k.publickey} data:${data}`); k.signature = typeof s === 'string' ? s : s && s.signature; } finally { signable.delete(data); }
      if (!k.signature) throw new Error('The node did not sign the Rapids session.');
      fs.mkdirSync(path.dirname(KEYFILE), { recursive: true });
      fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
      note({ session: 'made', owner: k.owner });
    }
    if (!needSession) return k;   // the address alone (receiving test tokens) needs no session
    const acc = await call('/account?owner=' + k.owner).catch(() => null);
    if (!acc || acc.session !== k.key) {
      const r = await call('/input', { input: { type: 'session', owner: k.owner, key: k.key, publickey: k.publickey, signature: k.signature } });
      if (!r || r.ok === false) throw new Error('The matchers did not take the session: ' + ((r && r.why) || 'no answer'));
      note({ session: 'sent', owner: k.owner });
    }
    k.priv = crypto.createPrivateKey(k.private);
    ident = k;
    return k;
  }
  const sign = (k, m) => crypto.sign(null, Buffer.from(m), k.priv).toString('base64url');
  let nonceN = 0;
  const nonce = () => String(Date.now()) + String(nonceN++ % 1000).padStart(3, '0');
  async function result(id, ms = 12000) {
    for (const until = Date.now() + ms; Date.now() < until;) {
      const rs = (await Promise.all(MATCHERS.map((m) => get(m, '/result?id=' + encodeURIComponent(id), 5000)))).filter((r) => r && r.n != null);
      const said = rs.map((r) => (r.result == null ? 'ok' : String(r.result)));
      const two = said.find((x, i) => said.indexOf(x) !== i);
      if (two) return two;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }
  async function readAccount() {
    let k = null; try { k = ident || JSON.parse(fs.readFileSync(KEYFILE, 'utf8')); } catch {}
    const bal = await node('balance').catch(() => null);
    wallet = Array.isArray(bal) ? Object.fromEntries(bal.filter((b) => TEST.has(up(b.tokenid))).map((b) => [up(b.tokenid), { sendable: Number(b.sendable) }])) : null;   // only what the wallet can spend: the tracked covenant counts other traders escrow as confirmed
    if (!k || !k.owner) { account = null; return; }
    const a = await call('/account?owner=' + k.owner).catch(() => null);
    if (!a) return;
    account = {
      owner: k.owner, session: !!a.session && a.session === k.key,
      balances: (a.balances || []).map((b) => ({ token: up(b.token), name: TOKENS[up(b.token)] || b.token, amount: Number(b.amount), free: Number(b.free) })),
      orders: (a.orders || []).map((o) => ({ id: o.id, market: up(o.market || WINIWA), side: o.side, price: Number(o.price) / 1e8, size: Number(o.size ?? o.left), left: Number(o.left), tif: o.tif || 'gtc' })),
      deposits: (a.deposits || []).slice(-10).map((d) => ({ token: up(d.token), amount: Number(d.amount), counted: !!d.counted, coinid: d.coinid })),
      fills: (a.fills || []).slice(-30), batch: a.batch,
    };
  }

  /* ---- The Pool ---- */
  async function openP() {
    if (pool) return pool;
    if (poolOpening) return poolOpening;
    poolOpening = (async () => {
      const { openPool } = await import(pathToFileURL(POOLENG).href);
      fs.mkdirSync(DATA, { recursive: true });
      const p = await openPool({ rpc: await proxyUrl(), state: path.join(DATA, 'pool-state.json'), market: { base: WINIWA, quote: '0xF4771A12F9BBF8259EFF50AB5B2E8C3D0088C64AD692EBC782F506A4B2F6E9FA', baseName: 'Winiwa', quoteName: 'USDx' },
        onRefused: (p, why) => note({ poolRefused: p.slice(0, 160), why }), log: () => {} });
      pool = p; return p;
    })().finally(() => { poolOpening = null; });
    return poolOpening;
  }
  const levels = (orders, side) => {
    const m = new Map();
    for (const o of orders) m.set(o.price, (m.get(o.price) || 0) + Number(o.size));
    return [...m].map(([price, qty]) => ({ price, qty })).sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price));
  };
  async function readPool() {
    if (poolBusy) return;
    poolBusy = true;
    try {
      const p = await openP();
      // The orders placed before this node watched the covenant come from The Pool's own snapshots, imported (every 15 min).
      if (Date.now() - rebuiltAt > 900000) { await p.win.Anchor.rebuild(() => {}).catch((e) => note({ rebuild: String(e && e.message || e) })); rebuiltAt = Date.now(); }
      const b = await p.book();
      let m = [];
      try { m = await p.mine(b); } catch { /* no keys listed */ }
      mine = m.map((o) => ({ id: o.coinid, side: o.side === 'bid' ? 'buy' : 'sell', price: o.price, size: Number(o.size), placedat: o.placedat }));
      poolBook = { bids: levels(b.bids || [], 'bids'), asks: levels(b.asks || [], 'asks'), reconciled: b.reconciled, orders: (b.bids || []).length + (b.asks || []).length, raw: b };
      poolAt = Date.now(); poolErr = null;
    } catch (e) { poolErr = e.message; } finally { poolBusy = false; }
  }

  /* ---- what the page asks ---- */
  async function refresh(full) {
    if (!available() || mode() !== 'paper') return;
    await Promise.all([readRapids().catch((e) => { rapidsErr = e.message; }), readAccount().catch(() => {}), full || Date.now() - poolAt > 30000 ? readPool() : null]);
    keepMids();
  }
  const marketOf = (base) => (conf?.markets || []).find((m) => m.base === up(base));
  function check(b) {
    const mk = marketOf(b.market);
    if (!mk) return { error: 'Pick a Minima Bay market.' };
    if (!['buy', 'sell'].includes(b.side)) return { error: 'Pick Buy or Sell.' };
    let price, size;
    try { price = atomsOf(b.price); size = atomsOf(b.size); } catch (e) { return { error: e.message }; }
    if (!(price > 0n) || !(size > 0n)) return { error: 'Enter a price and a size above zero.' };
    return { mk, price, size };
  }
  async function order(b) {
    if (!available()) return { error: 'The Minima Bay folder is not on this computer.' };
    if (mode() !== 'paper') return { error: 'Minima Bay orders are for paper mode (test tokens). Switch to paper in Settings.' };
    await venue();
    const v = check(b); if (v.error) return v;
    if (b.venue === 'POOL') {
      if (v.mk.base !== WINIWA) return { error: 'The Pool has only Winiwa/USDx.' };
      const p = await openP();
      const price = unitsOf(v.price), size = unitsOf(v.size);
      note({ pool: 'order', side: b.side, price, size, take: !!b.take });
      try {
        if (b.take) {
          const r = await p.take(b.side, size, String(v.price));
          note({ pool: 'take', r: r.taken ? 'taken' : r.why || 'not taken' });
          poolAt = 0;
          return r.taken ? { ok: true, said: 'Taken on chain: it shows once it is in a block.' } : { error: r.why || 'Nothing was taken.' };
        }
        const r = await p.place(b.side, size, price);
        poolAt = 0;
        return r.pending ? { ok: true, said: 'The node put it in its Pending list: approve it there.' } : { ok: true, said: 'Placed on chain: it rests once it is in a block.' };
      } catch (e) { note({ pool: 'error', e: e.message }); return { error: e.message, unknown: p.unknown(e) }; }
    }
    if (b.venue !== 'RAPIDS') return { error: 'Pick The Rapids or The Pool.' };
    const k = await identity();
    const tip = Number((await node('block')).block);
    const x = { type: 'order', owner: k.owner, market: v.mk.base, side: b.side, price: String(v.price), size: unitsOf(v.size), expiry: String(tip + 20000), nonce: nonce(), tif: b.tif === 'ioc' ? 'ioc' : 'gtc' };
    x.sig = sign(k, R.orderMessage(x));
    const id = R.orderId(x);
    note({ rapids: 'order', id, side: x.side, price: unitsOf(v.price), size: x.size, tif: x.tif });
    const r = await call('/input', { input: x }).catch((e) => ({ ok: false, why: e.message }));
    if (r && r.ok === false) { note({ rapids: 'not taken', id, why: r.why }); return { error: r.why || 'The matchers did not take it.' }; }
    const res = await result(id);
    note({ rapids: 'result', id, res });
    setTimeout(() => readAccount().catch(() => {}), 1500);
    if (res === 'ok') return { ok: true, id, said: x.tif === 'ioc' ? 'Sent: what did not fill at once was dropped.' : 'Taken by the matchers.' };
    if (res) return { error: 'Refused by the matchers: ' + res, id };
    return { ok: true, id, said: 'Sent; the matchers have not agreed on its result yet.' };
  }
  async function cancel(b) {
    if (mode() !== 'paper') return { error: 'Switch to paper in Settings.' };
    if (b.venue === 'POOL') {
      const o = (poolBook?.raw ? [...(poolBook.raw.bids || []), ...(poolBook.raw.asks || [])] : []).find((x) => up(x.coinid) === up(b.id));
      if (!o || !mine.some((m) => up(m.id) === up(b.id))) return { error: 'That order is not one of this node\'s on The Pool.' };
      const p = await openP();
      note({ pool: 'cancel', id: b.id });
      try { const r = await p.cancel(o); poolAt = 0; return { ok: true, said: r.pending ? 'In the node\'s Pending list: approve it there.' : 'Cancel sent: the escrow comes back once it is in a block.' }; }
      catch (e) { return { error: e.message }; }
    }
    const k = await identity();
    if (!account?.orders?.some((o) => o.id === b.id)) return { error: 'That order is not one of this account\'s in The Rapids.' };
    const x = { type: 'cancel', owner: k.owner, id: String(b.id) };
    x.sig = sign(k, R.cancelMessage(x));
    note({ rapids: 'cancel', id: x.id });
    const r = await call('/input', { input: x }).catch((e) => ({ ok: false, why: e.message }));
    setTimeout(() => readAccount().catch(() => {}), 1500);
    return r && r.ok === false ? { error: r.why || 'Not taken.' } : { ok: true, said: 'Cancel sent.' };
  }
  async function deposit(b) {
    if (mode() !== 'paper') return { error: 'Switch to paper in Settings.' };
    const c = await venue(), token = up(b.token);
    if (!TEST.has(token)) return { error: 'Only Winiwa, USDx or ETHx.' };
    const vault = up(c.contracts[token]?.vault || '');
    if (!vault) return { error: 'The Rapids has no vault for that token.' };
    let amount; try { amount = atomsOf(b.amount); } catch (e) { return { error: e.message }; }
    if (!(amount > 0n)) return { error: 'Enter an amount.' };
    const k = await identity(false);   // a deposit names the owner; the session is not needed for it
    note({ rapids: 'deposit', token: TOKENS[token], amount: unitsOf(amount) });
    try {
      const r = await node(`send address:${vault} amount:${unitsOf(amount)} tokenid:${token} state:${JSON.stringify({ 200: '1', 201: k.owner })}`, 120000);
      setTimeout(() => readAccount().catch(() => {}), 3000);
      return { ok: true, said: 'Sent to the vault: free to trade once the matchers count it (a few blocks).', txpowid: r && r.txpowid };
    } catch (e) { return { error: e.message }; }
  }
  async function address() {
    try { const k = await identity(false); return { address: k.owner }; } catch (e) { note({ identity: e.message }); return { error: e.message }; }
  }
  async function trades(base) {
    const r = await call(`/trades?market=${up(base)}&limit=500`).catch(() => null);
    return (r?.trades || []).map((t) => ({ at: t.at, price: Number(t.price) / 1e8, base: Number(t.base) }));
  }

  // Candles from the mids kept above: { t, o, h, l, c, v: null }, oldest first.
  function candles(base, venue, ms) {
    const key = venue === 'POOL' ? 'P' : 'R' + up(base).slice(2, 10), out = [];
    let cur = null;
    for (const r of mids) {
      const x = r.m[key]; if (!x) continue;
      const t = Math.floor(r.t / ms) * ms;
      if (!cur || cur.t !== t) { cur = { t, o: x, h: x, l: x, c: x, v: null }; out.push(cur); } else { cur.h = Math.max(cur.h, x); cur.l = Math.min(cur.l, x); cur.c = x; }
    }
    return out.slice(-300);
  }
  function view() {
    if (!available()) return { available: false };
    return {
      available: true, active: mode() === 'paper', markets: conf?.markets || [], rapids, rapidsAt, rapidsError: rapidsErr, matchers: status,
      pool: poolBook ? { bids: poolBook.bids, asks: poolBook.asks, reconciled: poolBook.reconciled, orders: poolBook.orders } : null, poolAt, poolError: poolErr,
      account, wallet, mine, owner: account?.owner || ident?.owner || null, tokens: TOKENS,
    };
  }
  return { _vet: vet, refresh, view, candles, order, cancel, deposit, address, trades, available, close: () => { pool?.close(); proxy?.srv.close(); } };
}
