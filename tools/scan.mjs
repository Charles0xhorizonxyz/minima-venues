#!/usr/bin/env node
/* Read-only snapshot of the MINIMA/MxUSD venues: Dexicon FAST (relays), the PandaDEX covenant book, PandaPools, and MEXC
 * as the outside reference. It reports where one venue's asks sit under another's bids and how much that is worth.
 *
 * It holds no key and can move nothing: only the commands in READ_ONLY reach the node, and it never POSTs to a relay.
 * Everything read from a relay or a beacon is hostile input until checked.
 * Amounts use JS numbers: good enough to measure a market, never to build a transaction.
 *
 *   node tools/scan.mjs                               one snapshot, printed
 *   node tools/scan.mjs --json                        one snapshot, as JSON
 *   node tools/scan.mjs --log data/scan.jsonl --every 60   one JSON line per minute until stopped
 *   --rpc http://127.0.0.1:9105                       the node to read (default 9105)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);

const DEFAULT_RPC = opt('rpc', 'http://127.0.0.1:9105');
let RPC = DEFAULT_RPC;
export const setRpc = (url) => { RPC = url || DEFAULT_RPC; return RPC; };
export const defaultRpc = () => DEFAULT_RPC;
const READ_ONLY = new Set(['block', 'status', 'coins', 'runscript']);

const MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
const MARKET = 'MINIMA/MxUSD';
export const DEFAULT_RELAYS = ['https://eurobuddha.com/dex-relay', 'https://store.eurobuddha.com/dex-relay', 'https://minimammr.com/dex-relay'];
let RELAYS = [...DEFAULT_RELAYS];
export const setRelays = (list) => { RELAYS = list && list.length ? [...list] : [...DEFAULT_RELAYS]; return RELAYS; };
const LIVE_SECONDS = 65 * 60, FUTURE_SLACK_SECONDS = 10 * 60;   // Dexicon lib/relay.js `heard`
const BOOK_ADDRS = ['0xDCF621472F6A09D5978D24DEF133B756DCED87067FCA692C21374EC38EF2D80A', '0x2D43279DD85DABCA3EA90C9997DAB9169D8B7A0E8CB594236AF44542489774A5'];
const BOOK_DEPTH = 1000, BOOK_MAX_AGE = 570;                    // PandaDEX SCAN_DEPTH; EXPIRY 600 less its 30-block margin
const SENTINEL = '0x50414E4441504F4F4C53', SENTINEL_DEPTH = 1500;
const POOL_FEE = 0.005, POOL_SLICE = 50, POOL_STEPS = 600;
const MEXC_TAKER_FEE = 0.001;                                   // assumed, conservative (MEXC says 0.08% for API takers)
const XT_TAKER_FEE = 0.002;                                     // XT's public symbol data, 2026-11-10

const HEX = /^0x[0-9a-fA-F]+$/, HEX32 = /^0x[0-9a-fA-F]{64}$/, DEC = /^[0-9]+(\.[0-9]+)?$/;
const eq = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

/* POST, with the header spelled Content-Length (the node reads no body otherwise) and a lenient parser (its headers fail
 * Node's strict one). `;` would let one string carry a second command, so it is refused outright. */
function rpc(cmd) {
  const verb = cmd.split(' ')[0];
  if (!READ_ONLY.has(verb) || cmd.includes(';')) throw new Error(`refused, not a read: ${verb}`);
  return new Promise((resolve, reject) => {
    const body = Buffer.from(cmd, 'utf8');
    const req = http.request(RPC, {
      method: 'POST', agent: false, insecureHTTPParser: true, timeout: 30000,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(text);
          if (!j.status) return reject(new Error(`${verb}: ${j.error || 'failed'}`));
          resolve(j.response);
        } catch { reject(new Error(`${verb}: reply was not JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${verb}: timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'trading-scan' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// The first entry of a port: what the covenant reads (PandaDEX review of 7 Nov).
function state(coin, port) {
  const s = coin?.state;
  if (Array.isArray(s)) { const e = s.find((x) => Number(x?.port) === port); return e ? String(e.data) : null; }
  if (s && s[String(port)] !== undefined) return String(s[String(port)]);
  return null;
}
const coinValue = (c) => Number(eq(c.tokenid, '0x00') ? c.amount : c.tokenamount);

function verifyOrder(o) {
  try {
    if (!HEX32.test(o.signPk) || !/^0x[0-9a-fA-F]{128}$/.test(o.sig)) return false;
    if (!eq(o.pubId.slice(-64), o.signPk.slice(2))) return false;
    const { sig, ...rest } = o;
    const canon = '{' + Object.keys(rest).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(rest[k])}`).join(',') + '}';
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(o.signPk.slice(2), 'hex')]);
    const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canon, 'utf8'), key, Buffer.from(sig.slice(2), 'hex'));
  } catch { return false; }
}

async function readFast(now) {
  const best = new Map();
  const relays = await Promise.all(RELAYS.map(async (url) => {
    try {
      const j = await getJson(`${url}/dex/book?market=${encodeURIComponent(MARKET)}&since=0&hold=0`);
      for (const o of j.orders ?? []) {
        if (o?.t !== 'order' || o.market !== MARKET || o.v !== 1) continue;
        const k = `${String(o.signPk).toLowerCase()}|${o.orderId}`;
        if (!best.has(k) || best.get(k).seq < o.seq) best.set(k, o);
      }
      return { url, ok: true, orders: (j.orders ?? []).length };
    } catch (e) { return { url, ok: false, error: e.message }; }
  }));

  const stats = { heard: 0, badSignature: 0, stale: 0, unbacked: 0 };
  const asks = [], bids = [];
  for (const o of best.values()) {
    stats.heard++;
    if (!(o.expiry > now && o.seq >= now - LIVE_SECONDS && o.seq <= now + FUTURE_SLACK_SECONDS && Number(o.amount) > 0 && Number(o.price) > 0)) { stats.stale++; continue; }
    if ((o.side !== 'buy' && o.side !== 'sell') || !verifyOrder(o)) { stats.badSignature++; continue; }
    // What the advertised coins can really deliver, as a taker's node sees them.
    const token = o.side === 'sell' ? '0x00' : MXUSD;
    let backing = 0;
    for (const id of (o.coins ?? []).slice(0, 32)) {
      if (!HEX32.test(id)) continue;
      const rows = await rpc(`coins coinid:${id}`).catch(() => []);
      const c = Array.isArray(rows) ? rows[0] : null;
      if (c && !c.spent && eq(c.tokenid, token)) backing += coinValue(c);
    }
    const price = Number(o.price);
    const qty = Math.min(Number(o.amount), o.side === 'sell' ? backing : backing / price);
    if (!(qty > 0)) { stats.unbacked++; continue; }
    (o.side === 'sell' ? asks : bids).push({ price, qty, maker: o.signPk.slice(0, 10) });
  }
  return { relays, stats, asks, bids, makers: new Set([...asks, ...bids].map((x) => x.maker)).size };
}

async function readBook(tip) {
  const asks = [], bids = [];
  let seen = 0, skipped = 0;
  for (const addr of BOOK_ADDRS) {
    const rows = await rpc(`coins order:desc address:${addr} depth:${BOOK_DEPTH}`);
    for (const c of rows) {
      seen++;
      const side = state(c, 5), want = state(c, 2), wantTok = state(c, 3) || '0x00';
      const sell = side === '1';
      const shapeOk = (side === '0' || side === '1') && want && DEC.test(want) &&
        eq(c.tokenid, sell ? '0x00' : MXUSD) && eq(wantTok, sell ? MXUSD : '0x00');
      const locked = coinValue(c), w = Number(want);
      if (!shapeOk || !(locked > 0) || !(w > 0) || tip - Number(c.created) > BOOK_MAX_AGE) { skipped++; continue; }
      const minima = sell ? locked : w, usd = sell ? w : locked;
      (sell ? asks : bids).push({ price: usd / minima, qty: minima });
    }
  }
  return { seen, skipped, asks, bids };
}

async function readPools() {
  const beacons = await rpc(`coins simplestate:true order:desc depth:${SENTINEL_DEPTH} address:${SENTINEL}`);
  const params = new Map();
  let otherTokens = 0;
  for (const c of beacons) {
    const [tok, oadr, opk, kmin] = [2, 3, 4, 5].map((p) => state(c, p));
    if (![tok, oadr, opk].every((x) => x && HEX.test(x)) || !kmin || !DEC.test(kmin)) continue;
    if (!eq(tok, MXUSD)) { otherTokens++; continue; }
    params.set(`${opk}|${tok}|${kmin}`.toLowerCase(), { opk, oadr, tok, kmin });
  }
  const template = (p) => 'IF SIGNEDBY(' + p.opk + ') THEN IF VERIFYOUT(@INPUT ' + p.oadr + ' @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF ' +
    'RETURN GETOUTADDR(@INPUT) EQ @ADDRESS AND GETOUTTOK(@INPUT) EQ @TOKENID AND GETOUTAMT(@INPUT) GTE @AMOUNT ENDIF ' +
    'IF @TOKENID EQ 0x00 THEN ASSERT @INPUT % 2 EQ 0 LET s=@INPUT+1 ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ ' + p.tok + ' ' +
    'ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ ' + p.tok + ' LET x=@AMOUNT LET y=GETINAMT(s) LET nx=GETOUTAMT(@INPUT) LET ny=GETOUTAMT(s) ' +
    'ASSERT VERIFYOUT(@INPUT @ADDRESS nx 0x00 FALSE) ELSE ASSERT @TOKENID EQ ' + p.tok + ' AND @INPUT % 2 EQ 1 LET s=@INPUT-1 ' +
    'ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ 0x00 ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ 0x00 ' +
    'LET y=@AMOUNT LET x=GETINAMT(s) LET ny=GETOUTAMT(@INPUT) LET nx=GETOUTAMT(s) ASSERT VERIFYOUT(@INPUT @ADDRESS ny ' + p.tok + ' FALSE) ENDIF ' +
    'LET dx=nx-x LET dy=ny-y LET fx=MAX(dx 0)*5/1000 LET fy=MAX(dy 0)*5/1000 RETURN (nx-fx)*(ny-fy) GTE MAX(x*y ' + p.kmin + ')';

  const pools = [];
  for (const p of params.values()) {
    const r = await rpc(`runscript script:"${template(p)}"`).catch(() => null);
    if (!r || !(r.parseok === true || r.parseok === 'true') || !r.script?.address) continue;
    const coins = await rpc(`coins address:${r.script.address}`).catch(() => []);
    let m = 0, t = 0;
    for (const c of coins) {
      if (eq(c.tokenid, '0x00')) m = Math.max(m, Number(c.amount));
      else if (eq(c.tokenid, p.tok)) t = Math.max(t, Number(c.tokenamount));
    }
    if (m > 0 && t > 0) pools.push({ address: r.script.address, x: m, y: t, kmin: Number(p.kmin) });
  }
  return { beacons: beacons.length, otherTokens, pools, ...poolLadders(pools) };
}

/* The pools as a ladder: water-fill equal slices, each going to whichever pool pays best for it, repricing as it goes. */
function poolLadders(pools) {
  const sellInto = (p, dx) => { const y2 = Math.max(p.x * p.y, p.kmin) / (p.x + dx * (1 - POOL_FEE)); return p.y - y2; };
  const buyFrom = (p, dy) => { const x2 = Math.max(p.x * p.y, p.kmin) / (p.y + dy * (1 - POOL_FEE)); return p.x - x2; };

  const bids = [];
  let live = pools.map((p) => ({ ...p }));
  for (let i = 0; i < POOL_STEPS && live.length; i++) {
    let top = null, out = 0;
    for (const p of live) { const q = sellInto(p, POOL_SLICE); if (q > out) { out = q; top = p; } }
    if (!top) break;
    top.y -= out; top.x += POOL_SLICE;
    bids.push({ price: out / POOL_SLICE, qty: POOL_SLICE });
  }
  const asks = [];
  live = pools.map((p) => ({ ...p }));
  for (let i = 0; i < POOL_STEPS && live.length; i++) {
    let top = null, price = Infinity, out = 0, cost = 0;
    for (const p of live) {
      const spot = p.y / p.x, dy = POOL_SLICE * spot, q = buyFrom(p, dy);
      if (q > 0 && dy / q < price) { price = dy / q; top = p; out = q; cost = dy; }
    }
    if (!top) break;
    top.y += cost; top.x -= out;
    asks.push({ price, qty: out });
  }
  return { asks, bids };
}

// XT.com, public depth (no key): a second exchange price, and a venue the desk can trade once its key is set.
// One failed read is often a blip: try once more, three seconds later, before calling it failed.
async function twice(read) {
  try { return await read(); } catch { await new Promise((r) => setTimeout(r, 3000)); return read(); }
}

async function readXt() {
  const j = await getJson('https://sapi.xt.com/v4/public/depth?symbol=minima_usdt&limit=100');
  if (j.rc !== 0) throw new Error(`XT: ${j.mc}`);
  const f = (rows) => (rows ?? []).map(([p, q]) => ({ price: Number(p), qty: Number(q) }));
  return { asks: f(j.result.asks), bids: f(j.result.bids) };
}
const OFF_CHAIN = new Set(['MEXC', 'XT']);

async function readMexc() {
  const j = await getJson('https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=100');
  const f = (rows) => rows.map(([p, q]) => ({ price: Number(p), qty: Number(q) }));
  return { asks: f(j.asks), bids: f(j.bids) };
}

/* Buy on `from`'s asks, sell on `to`'s bids, for as long as a bid pays more than an ask costs. */
function cross(from, to, feeFrom, feeTo) {
  const asks = [...from.asks].map((x) => ({ ...x })).sort((a, b) => a.price - b.price);
  const bids = [...to.bids].map((x) => ({ ...x })).sort((a, b) => b.price - a.price);
  let i = 0, j = 0, qty = 0, profit = 0, bestGap = null;
  while (i < asks.length && j < bids.length) {
    const cost = asks[i].price * (1 + feeFrom), gets = bids[j].price * (1 - feeTo), gap = gets / cost - 1;
    if (bestGap === null) bestGap = gap;
    if (gap <= 0) break;
    const q = Math.min(asks[i].qty, bids[j].qty);
    qty += q; profit += q * (gets - cost);
    asks[i].qty -= q; bids[j].qty -= q;
    if (asks[i].qty <= 1e-9) i++;
    if (bids[j].qty <= 1e-9) j++;
  }
  return { qty, profit, bestGapPct: bestGap === null ? null : bestGap * 100 };
}

function summary(v) {
  const bid = v.bids.length ? Math.max(...v.bids.map((x) => x.price)) : null;
  const ask = v.asks.length ? Math.min(...v.asks.map((x) => x.price)) : null;
  const near = (rows, test) => rows.filter(test).reduce((s, x) => s + x.qty, 0);
  return {
    bid, ask,
    bidDepth2pct: bid === null ? 0 : near(v.bids, (x) => x.price >= bid * 0.98),
    askDepth2pct: ask === null ? 0 : near(v.asks, (x) => x.price <= ask * 1.02),
  };
}

export async function snapshot({ books = false } = {}) {
  const head = await rpc('block');
  const tip = Number(head.block);
  const now = Math.floor(Date.now() / 1000);
  const tipAge = Math.round(now - Number(head.timemilli) / 1000);   // a stale tip means stale pool and book readings
  const [fast, book, pools, mexc, xt] = await Promise.all([
    readFast(now), readBook(tip), readPools(),
    twice(readMexc).catch((e) => ({ asks: [], bids: [], error: e.message })),
    twice(readXt).catch((e) => ({ asks: [], bids: [], error: e.message })),
  ]);
  const venues = { FAST: fast, BOOK: book, POOL: pools, MEXC: mexc, XT: xt };
  const speed = Number((await rpc('status').catch(() => null))?.chain?.speed);   // blocks per second, from the node's own chain
  const blockSeconds = speed > 0 ? 1 / speed : 50;
  const out = { at: new Date(now * 1000).toISOString(), tip, tipAge, blockSeconds, rpc: RPC, venues: {}, routes: [] };
  for (const [k, v] of Object.entries(venues)) out.venues[k] = summary(v);
  if (books) out.books = Object.fromEntries(Object.entries(venues).map(([k, v]) => [k, { asks: v.asks, bids: v.bids }]));
  out.detail = {
    fast: { relays: fast.relays, ...fast.stats, makers: fast.makers },
    book: { coins: book.seen, skipped: book.skipped },
    pools: { beacons: pools.beacons, otherTokens: pools.otherTokens, list: pools.pools },
    mexcError: mexc.error, xtError: xt.error,
  };
  const fee = (k) => (k === 'MEXC' ? MEXC_TAKER_FEE : k === 'XT' ? XT_TAKER_FEE : 0);   // the pool's 0.5% is already inside its ladder
  for (const a of Object.keys(venues)) for (const b of Object.keys(venues)) {
    if (a === b) continue;
    // Two separate transactions even when both legs are on chain: see docs/VENUES.md, "No atomic route".
    out.routes.push({ buy: a, sell: b, onChain: !OFF_CHAIN.has(a) && !OFF_CHAIN.has(b), ...cross(venues[a], venues[b], fee(a), fee(b)) });
  }
  return out;
}

function print(s) {
  const p = (x) => (x === null ? '-' : x.toFixed(8));
  const n = (x) => Math.round(x).toLocaleString('en-US');
  console.log(`\n${s.at}  block ${s.tip}, ${s.tipAge}s old  (estimates, 1 MxUSD taken as 1 USDT)\n`);
  console.log('venue      best bid     best ask     spread    MINIMA within 2%  bid / ask');
  for (const [k, v] of Object.entries(s.venues)) {
    const spread = v.bid && v.ask ? `${(((v.ask - v.bid) / v.bid) * 100).toFixed(2)}%` : '-';
    console.log(`${k.padEnd(10)} ${p(v.bid).padEnd(12)} ${p(v.ask).padEnd(12)} ${spread.padEnd(9)} ${n(v.bidDepth2pct)} / ${n(v.askDepth2pct)}`);
  }
  const f = s.detail.fast;
  console.log(`\nFAST: ${f.relays.filter((r) => r.ok).length}/${f.relays.length} relays, ${f.heard} orders heard, ${f.makers} makers, ${f.stale} stale, ${f.badSignature} bad, ${f.unbacked} unbacked`);
  console.log(`BOOK: ${s.detail.book.coins} coins, ${s.detail.book.skipped} skipped`);
  console.log(`POOL: ${s.detail.pools.list.length} funded MxUSD pools from ${s.detail.pools.beacons} beacons`);
  for (const q of s.detail.pools.list) console.log(`  ${q.address.slice(0, 14)}  ${n(q.x)} MINIMA  ${q.y.toFixed(2)} MxUSD  spot ${(q.y / q.x).toFixed(8)}`);
  if (s.detail.mexcError) console.log(`MEXC: ${s.detail.mexcError}`);
  console.log('\nbuy on -> sell on     settles    edge at top    MINIMA    profit MxUSD');
  for (const r of [...s.routes].sort((a, b) => b.profit - a.profit)) {
    const gap = r.bestGapPct === null ? '-' : `${r.bestGapPct.toFixed(2)}%`;
    console.log(`${`${r.buy} -> ${r.sell}`.padEnd(21)} ${(r.onChain ? 'on chain' : 'with MEXC').padEnd(10)} ${gap.padEnd(14)} ${n(r.qty).padEnd(9)} ${r.profit.toFixed(4)}`);
  }
  console.log('');
}

const logFile = opt('log');
const every = Number(opt('every', 0));
if (every && every < 30) { console.error('--every is at least 30 seconds: the nodes are shared.'); process.exit(2); }

async function once() {
  const s = await snapshot();
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(s) + '\n');
  }
  if (flag('json')) console.log(JSON.stringify(s, null, 2)); else if (!logFile) print(s);
}

// Run as a command only: tools/server.mjs imports `snapshot` from this file.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await once();
    while (every) {
      await new Promise((r) => setTimeout(r, every * 1000));
      await once().catch((e) => console.error(new Date().toISOString(), e.message));
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
