/* Candles for the Trade page's chart. Reads only.
 *
 * MEXC and XT.com publish their own candles (public GET, no key). Dexicon and PandaPools have no candle feed,
 * so theirs are built from this app's own scans: the mid price once a minute, grouped into candles (no volume).
 * Each answer is { candles: [{ t, o, h, l, c, v }], source }, oldest first; v is MINIMA traded, or null.
 */
export const INTERVALS = {
  '1m': { ms: 60e3, mexc: '1m', xt: '1m' },
  '5m': { ms: 300e3, mexc: '5m', xt: '5m' },
  '15m': { ms: 900e3, mexc: '15m', xt: '15m' },
  '1h': { ms: 3600e3, mexc: '60m', xt: '1h' },
  '4h': { ms: 14400e3, mexc: '4h', xt: '4h' },
  '1d': { ms: 86400e3, mexc: '1d', xt: '1d' },
  '1w': { ms: 604800e3, mexc: '1W', xt: '1w' },
};
const LIMIT = 300;
const cache = new Map();   // venue|interval -> { at, value }

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'minima-venues' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function mexc(iv) {
  const rows = await getJson(`https://api.mexc.com/api/v3/klines?symbol=MINIMAUSDT&interval=${iv.mexc}&limit=${LIMIT}`);
  if (!Array.isArray(rows)) throw new Error('MEXC sent no candles');
  return rows.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }));
}

async function xt(iv) {
  const j = await getJson(`https://sapi.xt.com/v4/public/kline?symbol=minima_usdt&interval=${iv.xt}&limit=${LIMIT}`);
  if (j?.rc !== 0 || !Array.isArray(j.result)) throw new Error(`XT sent no candles${j?.mc ? `: ${j.mc}` : ''}`);
  return j.result.map((k) => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.q) })).sort((a, b) => a.t - b.t);
}

// From the scan log: each scan's mid for that venue, grouped by the candle's start time.
function fromScans(history, key, iv) {
  const out = [], since = Date.now() - iv.ms * LIMIT;
  let cur = null;
  for (const r of history) {
    if (r.t < since) continue;
    const q = r.v?.[key];
    if (!q || !q[0] || !q[1]) continue;
    const mid = (q[0] + q[1]) / 2, t = Math.floor(r.t / iv.ms) * iv.ms;
    if (!cur || cur.t !== t) { cur = { t, o: mid, h: mid, l: mid, c: mid, v: null }; out.push(cur); }
    else { cur.h = Math.max(cur.h, mid); cur.l = Math.min(cur.l, mid); cur.c = mid; }
  }
  return out;
}

export async function candles(venue, interval, history) {
  const iv = INTERVALS[interval];
  if (!iv) return { error: `Interval is one of ${Object.keys(INTERVALS).join(', ')}.` };
  if (!['MEXC', 'XT', 'FAST', 'POOL'].includes(venue)) return { error: 'Unknown venue.' };
  if (venue !== 'MEXC' && venue !== 'XT') return { candles: fromScans(history, venue, iv), source: 'this app\'s scans, once a minute (mid price)' };
  const k = `${venue}|${interval}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  try {
    const value = { candles: venue === 'MEXC' ? await mexc(iv) : await xt(iv), source: `${venue === 'MEXC' ? 'MEXC' : 'XT.com'} candles (last price)` };
    cache.set(k, { at: Date.now(), value });
    return value;
  } catch (e) {
    // The exchange did not answer: an older copy if there is one, else the scans.
    if (hit) return { ...hit.value, stale: Math.round((Date.now() - hit.at) / 1000) };
    return { candles: fromScans(history, venue, iv), source: `this app's scans (${venue === 'MEXC' ? 'MEXC' : 'XT.com'} did not answer: ${e.message})` };
  }
}

// From a venue's own trades (The Rapids): { at, price, base } each, grouped by the candle's start time; v is base traded.
export function tradeCandles(trades, interval) {
  const iv = INTERVALS[interval];
  if (!iv) return { error: `Interval is one of ${Object.keys(INTERVALS).join(', ')}.` };
  const out = [];
  let cur = null;
  for (const t of [...trades].sort((a, b) => a.at - b.at)) {
    const k = Math.floor(t.at / iv.ms) * iv.ms;
    if (!cur || cur.t !== k) { cur = { t: k, o: t.price, h: t.price, l: t.price, c: t.price, v: t.base }; out.push(cur); }
    else { cur.h = Math.max(cur.h, t.price); cur.l = Math.min(cur.l, t.price); cur.c = t.price; cur.v += t.base; }
  }
  return { candles: out.slice(-LIMIT), source: "The Rapids' trades (last 500)" };
}
