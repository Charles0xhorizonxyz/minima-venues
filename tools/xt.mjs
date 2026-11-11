/* The XT.com account, the way tools/mexc.mjs handles MEXC: its key encrypted for this Windows user (DPAPI) under
 * %LOCALAPPDATA%\Trading, never sent to the page, a log or a command line; and one limit order at a time for the live
 * desk (tools/desk.mjs), which alone decides when.
 *
 * `signed` is the only way this file talks to the account, and only the calls in CALLS exist: balances, open orders, and
 * placing, reading and cancelling one MINIMA/USDT order. Nothing here can withdraw or transfer.
 *
 * XT v4 signing (doc.xt.com, "Signature generation"): X = the validate-* headers sorted and joined with &, Y =
 * #METHOD#path[#sorted query][#raw body], signature = hex HMAC-SHA256(secret, X + Y).
 *
 * Note (2026-11-10): XT's public symbol data for minima_usdt says openapiEnabled: false. Orders by API may be refused for
 * this pair; the first order placed will tell. Fees: 0.2% maker and taker.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const XT_SYMBOL = 'minima_usdt';
const CALLS = new Set(['GET /v4/balances', 'GET /v4/open-order', 'POST /v4/order', 'GET /v4/order', 'DELETE /v4/order/:id']);
const QTY = /^\d{1,9}(\.\d{1,2})?$/, PRICE = /^\d{1,3}(\.\d{1,5})?$/, CLIENT_ID = /^[A-Za-z0-9_]{4,22}$/;
const ENDED = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envBase = process.env.XT_BASE;   // tests only: a stand-in on this computer
const BASE = envBase && /^http:\/\/127\.0\.0\.1:\d+$/.test(envBase) ? envBase : 'https://sapi.xt.com';
const SECRET_FILE = path.join(process.env.LOCALAPPDATA || '.', process.env.TRADING_SECRET_DIR || 'Trading', 'xt.dpapi');

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) reject(new Error('Windows could not protect or read the key.')); else resolve(String(out).trim());
    });
    child.stdin.end(input, 'utf8');
  });
}
const protect = (text) => powershell('Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,"CurrentUser"); [Console]::Out.Write([Convert]::ToBase64String($b))', text);
const unprotect = (b64) => powershell('Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,"CurrentUser"); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))', b64);

export function xtSignature(secret, { method, path: p, query = '', body = '', appKey, timestamp, recvWindow = '10000' }) {
  const X = `validate-algorithms=HmacSHA256&validate-appkey=${appKey}&validate-recvwindow=${recvWindow}&validate-timestamp=${timestamp}`;
  const Y = `#${method}#${p}${query ? `#${query}` : ''}${body ? `#${body}` : ''}`;
  return crypto.createHmac('sha256', secret).update(X + Y).digest('hex');
}

/* rc 0 is success. Any answer with another rc is a refusal (e.refused): XT did not act. No answer, a broken one or a 5xx may
 * have been acted on (e.unclear). */
async function signed(key, method, p, { params = {}, body = null, id = null } = {}) {
  if (!CALLS.has(`${method} ${id ? p.replace(/\/[^/]+$/, '/:id') : p}`)) throw new Error('refused here: not an allowed XT call');
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const raw = body ? JSON.stringify(body) : '';
  const timestamp = String(Date.now()), recvWindow = '10000';
  const headers = {
    'Content-Type': 'application/json', accept: 'application/json', 'validate-algorithms': 'HmacSHA256', 'validate-appkey': key.apiKey,
    'validate-recvwindow': recvWindow, 'validate-timestamp': timestamp,
    'validate-signature': xtSignature(key.apiSecret, { method, path: p, query, body: raw, appKey: key.apiKey, timestamp, recvWindow }),
  };
  let r;
  try { r = await fetch(`${BASE}${p}${query ? `?${query}` : ''}`, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw Object.assign(new Error(`XT: no answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`), { unclear: true }); }
  const j = await r.json().catch(() => null);
  if (j && j.rc === 0) return j.result;
  if (j && j.rc !== undefined && r.status < 500) throw Object.assign(new Error(`XT: ${j.mc || 'refused'}${j.ma?.length ? ` (${j.ma.join(', ')})` : ''}`), { refused: true, code: j.mc });
  throw Object.assign(new Error(`XT: HTTP ${r.status}`), { unclear: true });
}

export async function xtDepth(limit = 100) {
  const r = await fetch(`${BASE}/v4/public/depth?symbol=${XT_SYMBOL}&limit=${limit}`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (!r.ok || j.rc !== 0) throw new Error(`XT depth: ${j?.mc || `HTTP ${r.status}`}`);
  const rows = (x) => (x ?? []).map(([p, q]) => ({ price: String(p), qty: String(q) }));
  return { at: Date.now(), bids: rows(j.result.bids), asks: rows(j.result.asks) };
}

export function createXt() {
  let key = null, keyLoaded = false;
  const info = { connected: false, keyEnd: null, error: null, balances: null, openOrders: [], readAt: null };

  async function loadKey() {
    if (keyLoaded) return;
    keyLoaded = true;
    try {
      const blob = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (!blob) return;
      key = JSON.parse(await unprotect(blob));
      info.connected = true; info.keyEnd = key.apiKey.slice(-4);
    } catch (e) { if (e.code !== 'ENOENT') info.error = 'The stored XT key could not be read. Connect it again.'; }
  }

  async function readBalances(k) {
    const r = await signed(k, 'GET', '/v4/balances', { params: { currencies: 'minima,usdt' } });
    const find = (c) => { const a = (r?.assets ?? []).find((x) => String(x.currency).toLowerCase() === c); return { free: Number(a?.availableAmount ?? 0), locked: Number(a?.frozenAmount ?? 0) }; };
    return { MINIMA: find('minima'), USDT: find('usdt') };
  }

  async function sync() {
    await loadKey();
    if (!key) return;
    try {
      info.balances = await readBalances(key);
      const open = await signed(key, 'GET', '/v4/open-order', { params: { bizType: 'SPOT', symbol: XT_SYMBOL } });
      info.openOrders = (Array.isArray(open) ? open : []).map((o) => ({ side: o.side === 'BUY' ? 'buy' : 'sell', price: Number(o.price), qty: Number(o.leavingQty ?? (Number(o.origQty) - Number(o.executedQty || 0))), filled: Number(o.executedQty || 0), time: Number(o.time), ours: String(o.clientOrderId ?? '').startsWith('tb') }));
      info.readAt = Date.now(); info.error = null;
    } catch (e) { info.error = e.message; }
  }

  async function connect(body) {
    const apiKey = String(body?.apiKey ?? '').trim(), apiSecret = String(body?.apiSecret ?? '').trim();
    if (!/^[\x21-\x7e]{10,200}$/.test(apiKey)) return { error: 'That API key does not look right.', field: 'apiKey' };
    if (!/^[\x21-\x7e]{10,200}$/.test(apiSecret)) return { error: 'That secret does not look right.', field: 'apiSecret' };
    const candidate = { apiKey, apiSecret };
    let balances;
    try { balances = await readBalances(candidate); } catch (e) { return { error: `Not saved. ${e.message}` }; }
    let blob;
    try { blob = await protect(JSON.stringify(candidate)); } catch (e) { return { error: e.message }; }
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, blob);
    key = candidate; keyLoaded = true;
    Object.assign(info, { connected: true, keyEnd: apiKey.slice(-4), error: null, balances });
    sync();
    return { ok: true };
  }

  function disconnect() {
    try { fs.writeFileSync(SECRET_FILE, ''); } catch { /* never saved */ }
    key = null; keyLoaded = true;
    Object.assign(info, { connected: false, keyEnd: null, error: null, balances: null, openOrders: [] });
    return { ok: true };
  }

  /* One limit order, immediate-or-cancel (XT has it): what does not fill at once is dropped by XT. Named by clientId: an
   * order placed with no clear answer is looked up by that name and never sent twice. Answers as mexc.limitOrder. */
  async function limitOrder({ side, quantity, price, clientId }) {
    await loadKey();
    if (!key) return { refused: true, why: 'no XT key is connected' };
    if (!/^(BUY|SELL)$/.test(side) || !QTY.test(quantity) || !PRICE.test(price) || !CLIENT_ID.test(clientId) || !(Number(quantity) > 0) || !(Number(price) > 0)) return { refused: true, why: 'the order is not well formed' };
    const ask = () => signed(key, 'GET', '/v4/order', { params: { clientOrderId: clientId } });
    let orderId = null;
    try {
      orderId = (await signed(key, 'POST', '/v4/order', { body: { symbol: XT_SYMBOL, clientOrderId: clientId, side, type: 'LIMIT', timeInForce: 'IOC', bizType: 'SPOT', price, quantity } }))?.orderId ?? null;
    } catch (e) {
      if (e.refused) return { refused: true, why: e.message };
      for (let i = 0; i < 4 && !orderId; i++) { await sleep(2500); try { orderId = (await ask())?.orderId ?? null; } catch { /* not there yet */ } }
      if (!orderId) return { unknown: true, why: `${e.message}, and no order named ${clientId} could be found` };
    }
    let o = null;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      try { const x = await ask(); if (ENDED.includes(x?.state)) { o = x; break; } } catch { /* again */ }
    }
    if (!o) {
      try { await signed(key, 'DELETE', `/v4/order/${orderId}`, { id: true }); } catch { /* ended meanwhile, or no answer */ }
      for (let i = 0; i < 5 && !o; i++) { await sleep(1000); try { const x = await ask(); if (ENDED.includes(x?.state)) o = x; } catch { /* again */ } }
      if (!o) return { unknown: true, why: `XT order ${clientId} was placed and how it ended could not be read`, orderId };
    }
    sync();
    return { done: true, status: o.state, executedQty: String(o.executedQty ?? '0'), quoteQty: String(o.tradeQuote ?? '0'), fee: String(o.fee ?? '0'), feeCurrency: o.feeCurrency ?? null, orderId: o.orderId ?? orderId, clientId };
  }

  async function balances() { await loadKey(); if (!key) return null; info.balances = await readBalances(key); return info.balances; }

  return { sync, connect, disconnect, loadKey, limitOrder, balances, connected: () => !!key, view: () => ({ ...info }) };
}
