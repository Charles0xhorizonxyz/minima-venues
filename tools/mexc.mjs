/* The MEXC account: reads balances and this account's trades, keeps every trade in a ledger, works out profit and loss,
 * and places limit orders for the live desk (tools/desk.mjs), which alone decides when.
 *
 * `signed` is the only way this file talks to the account, and only the calls in CALLS exist: reads, and placing,
 * reading and cancelling one MINIMAUSDT limit order. Nothing here can withdraw or move funds off the exchange.
 * The API secret is stored encrypted for this Windows user (DPAPI) under %LOCALAPPDATA%, outside Documents so the backups
 * never carry it. It is never sent to the page, written to a log, or passed on a command line.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SYMBOL = 'MINIMAUSDT', BASE_ASSET = 'MINIMA', QUOTE_ASSET = 'USDT';
const CALLS = new Set(['GET /api/v3/account', 'GET /api/v3/myTrades', 'POST /api/v3/order', 'GET /api/v3/order', 'DELETE /api/v3/order', 'GET /api/v3/openOrders']);
const QTY = /^\d{1,9}(\.\d{1,2})?$/, PRICE = /^\d{1,3}(\.\d{1,5})?$/, CLIENT_ID = /^[A-Za-z0-9_-]{8,32}$/;
const ENDED = ['FILLED', 'CANCELED', 'PARTIALLY_CANCELED'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000, FIRST_LOOKBACK = 30 * DAY, OVERLAP = 3600000, PAGE = 100;

// For tests: a stand-in exchange on this computer. Nothing else may replace the real address.
const envBase = process.env.MEXC_BASE;
const BASE = envBase && /^http:\/\/127\.0\.0\.1:\d+$/.test(envBase) ? envBase : 'https://api.mexc.com';

const SECRET_DIR = path.join(process.env.LOCALAPPDATA || '.', process.env.TRADING_SECRET_DIR || 'Trading');
const SECRET_FILE = path.join(SECRET_DIR, 'mexc.dpapi');

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) reject(new Error('Windows could not protect or read the key.')); else resolve(String(out).trim());
    });
    child.stdin.end(input, 'utf8');
  });
}
const protect = (text) => powershell(
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,"CurrentUser"); [Console]::Out.Write([Convert]::ToBase64String($b))', text);
const unprotect = (b64) => powershell(
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,"CurrentUser"); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))', b64);

/* A 4xx answer with an error code is a refusal (e.refused): MEXC did not act. Anything else that is not a clear answer
 * (no reply, a timeout, a 5xx) may have been acted on, and is marked so (e.unclear). */
async function signed(key, method, pathname, params = {}) {
  if (!CALLS.has(`${method} ${pathname}`)) throw new Error('refused here: not an allowed MEXC call');
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '10000' }).toString();
  const signature = crypto.createHmac('sha256', key.apiSecret).update(query).digest('hex');
  let r;
  try {
    r = await fetch(`${BASE}${pathname}?${query}&signature=${signature}`, { method, headers: { 'X-MEXC-APIKEY': key.apiKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw Object.assign(new Error(`MEXC: no answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`), { unclear: true }); }
  const j = await r.json().catch(() => null);
  if (r.ok && !(j && !Array.isArray(j) && j.code && j.code !== 200)) return j;
  const refused = r.status >= 400 && r.status < 500 && j && j.code !== undefined;
  throw Object.assign(new Error(`MEXC: ${j?.msg || `HTTP ${r.status}`}`), refused ? { refused: true, code: j.code } : { unclear: true });
}
const signedGet = (key, pathname, params) => signed(key, 'GET', pathname, params);

export async function publicDepth(limit = 50) {
  const r = await fetch(`${BASE}/api/v3/depth?symbol=${SYMBOL}&limit=${limit}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`MEXC depth: HTTP ${r.status}`);
  const j = await r.json();
  const rows = (x) => (x ?? []).map(([p, q]) => ({ price: String(p), qty: String(q) }));
  return { at: Date.now(), bids: rows(j.bids), asks: rows(j.asks) };
}

const tradeId = (t) => `${t.id ?? ''}|${t.orderId ?? ''}|${t.time}|${t.price}|${t.qty}`;

/* Exact whatever the order of the trades: total = cash in and out + position at the mid - fees. Average cost only splits
 * it into realised and unrealised. A sale with no purchase on record opens a negative position, closed by later buys. */
export function computePnl(trades, mid) {
  let pos = 0, avg = 0, realised = 0, fees = 0;
  const unpriced = {}, rows = [], curve = [];
  for (const t of [...trades].sort((a, b) => a.time - b.time)) {
    const qty = Number(t.qty), price = Number(t.price), sign = t.isBuyer ? 1 : -1, commission = Number(t.commission || 0);
    let fee = 0;
    if (t.commissionAsset === QUOTE_ASSET) fee = commission;
    else if (t.commissionAsset === BASE_ASSET) fee = commission * price;
    else if (commission > 0 && t.commissionAsset) unpriced[t.commissionAsset] = (unpriced[t.commissionAsset] ?? 0) + commission;
    let booked = 0;
    if (pos === 0 || Math.sign(pos) === sign) {
      avg = (Math.abs(pos) * avg + qty * price) / (Math.abs(pos) + qty);
      pos += sign * qty;
    } else {
      const closing = Math.min(Math.abs(pos), qty);
      booked = closing * (price - avg) * Math.sign(pos);
      pos += sign * closing;
      const rest = qty - closing;
      if (rest > 1e-12) { pos = sign * rest; avg = price; } else if (Math.abs(pos) < 1e-12) { pos = 0; avg = 0; }
    }
    realised += booked; fees += fee;
    rows.push({ time: t.time, side: t.isBuyer ? 'buy' : 'sell', price, qty, value: qty * price, fee, feeAsset: t.commissionAsset || '', commission, maker: !!t.isMaker, orderId: t.orderId ?? '', booked: booked - fee, position: pos });
    curve.push([t.time, realised - fees + pos * (price - avg)]);
  }
  const unrealised = mid > 0 ? pos * (mid - avg) : 0;
  return { position: pos, avgPrice: avg, realised, unrealised, fees, total: realised + unrealised - fees, unpriced, rows, curve };
}

export function createMexc(ledgerFile) {
  let key = null, keyLoaded = false;
  const info = { connected: false, keyEnd: null, error: null, lastSyncAt: null, balances: null, canTrade: null, canWithdraw: null, syncing: false, openOrders: [], openOrdersAt: null };
  const trades = new Map();
  let syncedTo = 0;
  try {
    for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const t = JSON.parse(line); trades.set(tradeId(t), t); syncedTo = Math.max(syncedTo, t.time); } catch { /* a torn last line */ }
    }
  } catch { /* first run */ }

  async function loadKey() {
    if (keyLoaded) return;
    keyLoaded = true;
    try {
      const blob = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (!blob) return;
      key = JSON.parse(await unprotect(blob));
      info.connected = true; info.keyEnd = key.apiKey.slice(-4);
    } catch (e) { if (e.code !== 'ENOENT') info.error = 'The stored key could not be read. Connect it again.'; }
  }

  async function readAccount(k) {
    const a = await signedGet(k, '/api/v3/account');
    const find = (asset) => { const b = (a.balances ?? []).find((x) => x.asset === asset); return { free: Number(b?.free ?? 0), locked: Number(b?.locked ?? 0) }; };
    return { balances: { [BASE_ASSET]: find(BASE_ASSET), [QUOTE_ASSET]: find(QUOTE_ASSET) }, canTrade: a.canTrade ?? null, canWithdraw: a.canWithdraw ?? null };
  }

  // A full page may hide trades, so a full window is split in two until each half fits.
  async function collect(start, end, found, depth = 0) {
    const page = await signedGet(key, '/api/v3/myTrades', { symbol: SYMBOL, startTime: String(start), endTime: String(end), limit: String(PAGE) });
    if (!Array.isArray(page)) throw new Error('MEXC: unexpected reply to the trades request');
    if (page.length >= PAGE && depth < 12 && end - start > 2) {
      const middle = Math.floor((start + end) / 2);
      await collect(start, middle, found, depth + 1);
      await collect(middle + 1, end, found, depth + 1);
    } else found.push(...page);
  }

  async function sync() {
    await loadKey();
    if (!key || info.syncing) return;
    info.syncing = true;
    try {
      Object.assign(info, await readAccount(key));
      // What rests on MEXC now, from this desk (client ids tb...) or anything else using the account.
      const open = await signedGet(key, '/api/v3/openOrders', { symbol: SYMBOL });
      info.openOrders = (Array.isArray(open) ? open : []).map((o) => ({ side: o.side === 'BUY' ? 'buy' : 'sell', price: Number(o.price), qty: Number(o.origQty) - Number(o.executedQty || 0), filled: Number(o.executedQty || 0), time: Number(o.time), ours: String(o.clientOrderId ?? '').startsWith('tb') }));
      info.openOrdersAt = Date.now();
      // The account's own trade history is no longer read: the desk counts only its own trades, from its journal.
      info.error = null; info.lastSyncAt = Date.now();
    } catch (e) { info.error = e.message; }
    info.syncing = false;
  }

  async function connect(body) {
    const apiKey = String(body?.apiKey ?? '').trim(), apiSecret = String(body?.apiSecret ?? '').trim();
    if (!/^[\x21-\x7e]{10,200}$/.test(apiKey)) return { error: 'That API key does not look right.', field: 'apiKey' };
    if (!/^[\x21-\x7e]{10,200}$/.test(apiSecret)) return { error: 'That secret does not look right.', field: 'apiSecret' };
    const candidate = { apiKey, apiSecret };
    let account;
    try { account = await readAccount(candidate); } catch (e) { return { error: `Not saved. ${e.message}` }; }
    let blob;
    try { blob = await protect(JSON.stringify(candidate)); } catch (e) { return { error: e.message }; }
    fs.mkdirSync(SECRET_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, blob);
    key = candidate; keyLoaded = true;
    Object.assign(info, account, { connected: true, keyEnd: apiKey.slice(-4), error: null });
    sync();
    return { ok: true };
  }

  // The key is overwritten with nothing. The trade ledger stays.
  function disconnect() {
    try { fs.writeFileSync(SECRET_FILE, ''); } catch { /* it was never saved */ }
    key = null; keyLoaded = true;
    Object.assign(info, { connected: false, keyEnd: null, error: null, balances: null, canTrade: null, canWithdraw: null });
    return { ok: true };
  }

  function view(mid) {
    const pnl = computePnl([...trades.values()], mid);
    const value = (b) => b.free + b.locked;
    return {
      ...info, tradeCount: trades.size, mid: mid ?? null,
      accountValue: info.balances && mid > 0 ? value(info.balances[BASE_ASSET]) * mid + value(info.balances[QUOTE_ASSET]) : null,
      pnl: { position: pnl.position, avgPrice: pnl.avgPrice, realised: pnl.realised, unrealised: pnl.unrealised, fees: pnl.fees, total: pnl.total, unpriced: pnl.unpriced },
      trades: pnl.rows.slice(-200).reverse(), curve: pnl.curve,
    };
  }

  /* One limit order, left to fill for `waitMs`, then whatever rests is cancelled. It is named by `clientId`: when placing
   * it gets no clear answer, the order is looked up by that name and never sent twice. Answers
   * { done: true, status, executedQty, quoteQty, orderId }, { refused: true, why } (nothing was placed), or
   * { unknown: true, why } (it may rest or have filled: a person must look). */
  async function limitOrder({ side, quantity, price, clientId, waitMs = 4000 }) {
    await loadKey();
    if (!key) return { refused: true, why: 'no MEXC key is connected' };
    if (info.canTrade === false) return { refused: true, why: 'this MEXC key cannot trade' };
    if (!/^(BUY|SELL)$/.test(side) || !QTY.test(quantity) || !PRICE.test(price) || !CLIENT_ID.test(clientId) || !(Number(quantity) > 0) || !(Number(price) > 0)) return { refused: true, why: 'the order is not well formed' };
    const ask = () => signed(key, 'GET', '/api/v3/order', { symbol: SYMBOL, origClientOrderId: clientId });
    let orderId = null;
    try {
      orderId = (await signed(key, 'POST', '/api/v3/order', { symbol: SYMBOL, side, type: 'LIMIT', quantity, price, newClientOrderId: clientId }))?.orderId ?? null;
    } catch (e) {
      if (e.refused) return { refused: true, why: e.message };
      for (let i = 0; i < 4 && !orderId; i++) {
        await sleep(2500);
        try { orderId = (await ask())?.orderId ?? null; } catch { /* not there yet, or no answer */ }
      }
      if (!orderId) return { unknown: true, why: `${e.message}, and no order named ${clientId} could be found` };
    }
    const until = Date.now() + waitMs;
    let o = null;
    while (Date.now() < until) {
      await sleep(1000);
      try { o = await ask(); } catch { o = null; }
      if (ENDED.includes(o?.status)) break;
    }
    if (!ENDED.includes(o?.status)) {
      try { await signed(key, 'DELETE', '/api/v3/order', { symbol: SYMBOL, origClientOrderId: clientId }); } catch { /* filled meanwhile, or no answer: the read below decides */ }
      o = null;
      for (let i = 0; i < 5 && !o; i++) {
        await sleep(1000);
        try { const x = await ask(); if (ENDED.includes(x?.status)) o = x; } catch { /* again */ }
      }
      if (!o) return { unknown: true, why: `order ${clientId} was placed and how it ended could not be read`, orderId };
    }
    sync();
    return { done: true, status: o.status, executedQty: String(o.executedQty ?? '0'), quoteQty: String(o.cummulativeQuoteQty ?? '0'), orderId: o.orderId ?? orderId, clientId };
  }

  async function balances() {
    await loadKey();
    if (!key) return null;
    const a = await readAccount(key);
    Object.assign(info, a);
    return a.balances;
  }

  return { sync, connect, disconnect, view, loadKey, limitOrder, balances, connected: () => !!key };
}
