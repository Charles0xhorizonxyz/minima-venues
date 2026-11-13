/* The market maker, on paper. It quotes the ladder Dexicon's own maker would quote (lib/ladder.js: rungs around the MEXC
 * mid, the same price feed rules) and keeps a simulated record against live prices.
 *
 * This file cannot trade: it holds no key, reaches no node and no relay, and only ever reads the snapshot it is handed.
 * A real maker needs its own node, wallet and envelope (docs/HANDSHAKE.md, rules 1 to 3) and is a separate piece of work.
 *
 * How a paper rung fills: only when a real price elsewhere goes through it (a bid above your ask, an ask under your bid, on
 * one of the venues ticked: MEXC, XT.com, Dexicon, PandaPools, The Pool, The Rapids), and only for the depth that is
 * there. The pool can fill you once per state of its reserves.
 * It is a model. Real takers may be slower, and may never come.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LEVELS = 25, FRESH_MS = 5 * 60000, WIDEN_FULL_MS = 90 * 60000, MAX_WIDEN = 10, HARD_STALE_MS = 12 * 3600000;
const JUMP = 0.03, CONFIRM_BAND = 0.01, CONFIRM_MS = 60000;
const MAX_FILLS = 500, MAX_SERIES = 10080, MIN_FILL = 1;

/* The ladder's form, as common market makers have it: rung i sits spread + (i - 1) x step % from
 * the mid, so the step is the ladder's slope; the shape spreads the sizes over the rungs, the average staying the size set:
 * flat (the same on every rung), grow (more further out), curve (more near the mid). */
export const SHAPES = ['flat', 'grow', 'curve'];
export function shapeWeights(shape, n, tilt) {
  const norm = (w) => { const sum = w.reduce((a, b) => a + b, 0); return w.map((x) => (x * n) / sum); };
  const grow = norm(Array.from({ length: n }, (_, d) => d + 1)), curve = norm(Array.from({ length: n }, (_, d) => n - d));
  // A continuous shape: -1 is grow (Bid-Ask), 0 flat (Spot), +1 curve; in between, a blend (the average stays 1).
  const t = Number.isFinite(tilt) ? Math.max(-1, Math.min(1, tilt)) : shape === 'grow' ? -1 : shape === 'curve' ? 1 : 0;
  return Array.from({ length: n }, (_, d) => (t < 0 ? (1 + t) + -t * grow[d] : (1 - t) + t * curve[d]));
}
export const tiltName = (t) => (t <= -0.5 ? 'grow' : t >= 0.5 ? 'curve' : 'flat');
export const DEFAULTS = { skew: 0, spread: 0.5, step: 0.5, levels: 3, shape: 'flat', askSize: 5000, bidSize: 5000, reprice: 0.5, cooldownSeconds: 300, settleBlocks: 1, startMinima: 50000, startMxusd: 150 };
const LIMITS = {
  skew: [-20, 20, 'Skew'], spread: [0.1, 20, 'First rung'], step: [0, 20, 'Step'], levels: [1, MAX_LEVELS, 'Levels'], askSize: [0, 1e9, 'Ask size'], bidSize: [0, 1e9, 'Bid size'],
  reprice: [0.1, 20, 'Reprice'], cooldownSeconds: [0, 86400, 'Wait after a fill'], settleBlocks: [0, 20, 'Settles after'], startMinima: [0, 1e9, 'Starting MINIMA'], startMxusd: [0, 1e9, 'Starting MxUSD'],
};

const up8 = (x) => Math.ceil(x * 1e8 - 1e-6) / 1e8;
const down8 = (x) => Math.floor(x * 1e8 + 1e-6) / 1e8;

// Minima Bay's The Pool (BAYPOOL) and The Rapids (RAPIDS) are choices too: they fill only from a MINIMA/MxUSD book, so
// while they trade test assets only they fill nothing (tools/scan.mjs gives them an empty book, never a test pair's).
export const MM_VENUES = ['MEXC', 'XT', 'FAST', 'POOL', 'BAYPOOL', 'RAPIDS'];
export function validate(input) {
  const config = {};
  // Before the first rung had its own setting it sat one step out: keep that ladder when none is given.
  if (input && (input.spread === undefined || input.spread === null)) input = { ...input, spread: input.step };
  for (const [k, [lo, hi, label]] of Object.entries(LIMITS)) {
    const raw = input?.[k];
    const v = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
    if (String(raw ?? '').trim() === '' || !Number.isFinite(v)) return { error: `${label} must be a number.`, field: k };
    if (v < lo || v > hi) return { error: `${label} must be between ${lo} and ${hi}.`, field: k };
    if (k === 'levels' && !Number.isInteger(v)) return { error: 'Levels must be a whole number.', field: k };
    config[k] = v;
  }
  if (config.askSize <= 0 && config.bidSize <= 0) return { error: 'Set an ask size or a bid size above 0.', field: 'askSize' };
  const shape = String(input?.shape ?? 'flat');
  if (!SHAPES.includes(shape)) return { error: 'The shape is flat, grow or curve.', field: 'shape' };
  config.shape = shape;
  // The continuous shape, when given; without it, the named shape's end of the scale.
  const tiltRaw = input?.shapeTilt;
  if (tiltRaw !== undefined && tiltRaw !== null && String(tiltRaw).trim() !== '') {
    const t = Number(tiltRaw);
    if (!Number.isFinite(t) || t < -1 || t > 1) return { error: 'The shape is from -1 (Bid-Ask) to 1 (Curve).', field: 'shapeTilt' };
    config.shapeTilt = Math.round(t * 100) / 100; config.shape = tiltName(config.shapeTilt);
  } else config.shapeTilt = shape === 'grow' ? -1 : shape === 'curve' ? 1 : 0;
  for (const k of ['minAsk', 'maxBid']) {
    const raw = String(input?.[k] ?? '').trim().replace(/,/g, '');
    if (raw === '' || raw === 'null') { config[k] = null; continue; }
    const v = Number(raw);
    if (!(v > 0) || v > 100) return { error: `${k === 'minAsk' ? 'The lowest ask price' : 'The highest bid price'} is a price like 0.003, or empty.`, field: k };
    config[k] = v;
  }
  if (config.minAsk && config.maxBid && config.maxBid >= config.minAsk) return { error: 'The highest bid must be under the lowest ask.', field: 'maxBid' };
  // Which venues' prices can fill a paper rung (MEXC and PandaPools before this was a choice).
  const venues = Array.isArray(input?.venues) ? input.venues.filter((v) => MM_VENUES.includes(v)) : ['MEXC', 'POOL'];
  if (!venues.length) return { error: 'Pick at least one venue for the fills.', field: 'venues' };
  config.venues = [...new Set(venues)];
  return { config };
}

export function createMaker(file) {
  const blank = () => ({
    config: { ...DEFAULTS }, running: false, startedAt: null, inventory: null, start: null, rungs: {}, cooldowns: {},
    fills: [], series: [], settling: [], feed: { mid: null, at: 0, pending: null }, lastPoolFill: null, requotes: 0, lastTickAt: null,
  });
  let state = blank();
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); state = { ...blank(), ...j, config: { ...DEFAULTS, ...j.config } }; } catch { /* first run */ }
  let last = null;      // the latest snapshot
  let preview = [];

  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); };

  function updateFeed(s, now) {
    const v = s?.venues?.MEXC;
    if (!v || !(v.bid > 0) || !(v.ask > 0)) return;
    const mid = (v.bid + v.ask) / 2, f = state.feed;
    // A move over 3% counts only once a second read agrees with it, at least a minute later.
    if (f.mid && Math.abs(mid / f.mid - 1) > JUMP) {
      if (f.pending && Math.abs(mid / f.pending.mid - 1) <= CONFIRM_BAND) {
        if (now - f.pending.at < CONFIRM_MS) return;
      } else { f.pending = { mid, at: now }; return; }
    }
    f.mid = mid; f.at = now; f.pending = null;
  }

  function widen(now) {
    const age = now - state.feed.at;
    if (age <= FRESH_MS) return 1;
    return Math.min(MAX_WIDEN, 1 + ((MAX_WIDEN - 1) * (age - FRESH_MS)) / (WIDEN_FULL_MS - FRESH_MS));
  }

  function desired(now) {
    const c = state.config, f = state.feed;
    if (!(f.mid > 0) || now - f.at > HARD_STALE_MS) return [];
    const mid = f.mid * (1 + c.skew / 100), k = widen(now), n = Math.min(MAX_LEVELS, c.levels), out = [];
    const w = shapeWeights(c.shape, n, c.shapeTilt);
    for (let i = 1; i <= n; i++) {
      const off = ((c.spread + (i - 1) * c.step) * k) / 100;
      // Optional limits: no ask under the lowest ask price, no bid over the highest bid price (those rungs are left out).
      const ask = up8(mid * (1 + off)), bid = down8(mid * (1 - off));
      if (c.askSize > 0 && !(c.minAsk && ask < c.minAsk)) out.push({ key: `A${i}`, side: 'sell', price: ask, qty: down8(c.askSize * w[i - 1]) });
      if (c.bidSize > 0 && 1 - off > 0 && !(c.maxBid && bid > c.maxBid)) out.push({ key: `B${i}`, side: 'buy', price: bid, qty: down8(c.bidSize * w[i - 1]) });
    }
    return out;
  }

  function poolPrint(s) { return JSON.stringify((s.detail?.pools?.list ?? []).map((p) => [p.address, p.x, p.y])); }

  function applyFills(s, now) {
    const print = poolPrint(s);
    const poolOpen = print !== state.lastPoolFill;
    const flat = (side) => {
      const tag = (v) => (rows) => rows.map((r) => ({ price: r.price, qty: r.qty, v }));
      const use = state.config.venues || ['MEXC', 'POOL'];
      const rows = use.flatMap((v) => (v === 'POOL' ? (poolOpen ? tag('POOL')(s.books.POOL?.[side] ?? []) : []) : tag(v)(s.books[v]?.[side] ?? [])));
      return rows.sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price));
    };
    const bids = flat('bids'), asks = flat('asks');
    let usedPool = false;
    const live = Object.values(state.rungs).filter((r) => r.status === 'live').sort((a, b) => a.key.localeCompare(b.key));
    for (const r of live) {
      const sell = r.side === 'sell', rows = sell ? bids : asks;
      let left = sell ? Math.min(r.qty, state.inventory.minima) : Math.min(r.qty, state.inventory.mxusd / r.price);
      const size = left, by = {};
      for (const row of rows) {
        if (sell ? row.price <= r.price : row.price >= r.price) break;
        if (row.qty <= 0) continue;
        const q = Math.min(left, row.qty);
        row.qty -= q; left -= q; by[row.v] = (by[row.v] ?? 0) + q;
        if (left <= 1e-9) break;
      }
      const filled = size - left;
      if (filled < MIN_FILL) continue;
      if (by.POOL) usedPool = true;
      // What leaves is gone at once. What comes in is usable only after the block it settles in.
      if (sell) state.inventory.minima -= filled; else state.inventory.mxusd -= filled * r.price;
      state.settling.push({ at: now + state.config.settleBlocks * (s.blockSeconds ?? 50) * 1000, minima: sell ? 0 : filled, mxusd: sell ? filled * r.price : 0 });
      state.fills.unshift({ at: now, key: r.key, side: r.side, price: r.price, qty: filled, against: Object.keys(by).join(' + '), mid: state.feed.mid });
      state.fills.length = Math.min(state.fills.length, MAX_FILLS);
      state.cooldowns[r.key] = now + state.config.cooldownSeconds * 1000;
      r.status = 'filled';
    }
    if (usedPool) state.lastPoolFill = print;
  }

  function reconcile(now) {
    const c = state.config, next = {};
    let minima = state.inventory.minima, usd = state.inventory.mxusd;
    for (const w of desired(now)) {
      const old = state.rungs[w.key], until = state.cooldowns[w.key] ?? 0;
      if (until > now) { next[w.key] = { ...w, status: 'waiting', until }; continue; }
      const stays = old?.status === 'live' && Math.abs(old.price - w.price) / w.price * 100 < c.reprice;
      const price = stays ? old.price : w.price;
      const need = w.side === 'sell' ? w.qty : w.qty * price;
      if ((w.side === 'sell' ? minima : usd) < need) { next[w.key] = { ...w, price, status: 'short' }; continue; }
      if (w.side === 'sell') minima -= need; else usd -= need;
      if (!stays) state.requotes++;
      next[w.key] = { ...w, price, status: 'live', placedAt: stays ? old.placedAt : now };
    }
    state.rungs = next;
  }

  function settle(now) {
    state.settling = state.settling.filter((p) => {
      if (p.at > now || !state.inventory) return true;
      state.inventory.minima += p.minima; state.inventory.mxusd += p.mxusd;
      return false;
    });
  }
  const pending = () => state.settling.reduce((a, p) => ({ minima: a.minima + p.minima, mxusd: a.mxusd + p.mxusd }), { minima: 0, mxusd: 0 });

  function mark(now) {
    const mid = state.feed.mid;
    if (!(mid > 0) || !state.start) return;
    const p = pending();
    const value = (state.inventory.minima + p.minima) * mid + state.inventory.mxusd + p.mxusd;
    const hold = state.start.minima * mid + state.start.mxusd;
    state.series.push({ t: now, edge: value - hold });
    state.series.splice(0, Math.max(0, state.series.length - MAX_SERIES));
  }

  // A new snapshot, or null when the scan failed. Fills are judged only against prices not seen before.
  function tick(s) {
    const now = Date.now();
    if (s) { last = s; updateFeed(s, now); }
    preview = desired(now);
    settle(now);
    if (!state.running) return save();
    if (s && state.lastTickAt !== s.at) { applyFills(s, now); state.lastTickAt = s.at; mark(now); }
    reconcile(now);
    save();
  }

  function setConfig(input) {
    const v = validate(input);
    if (v.error) return v;
    state.config = v.config;
    preview = desired(Date.now());
    if (state.running) reconcile(Date.now());
    save();
    return { ok: true };
  }

  function start(input) {
    if (state.running) return { error: 'It is already running.' };
    const v = setConfig(input);
    if (v.error) return v;
    if (!state.inventory) {
      state.inventory = { minima: state.config.startMinima, mxusd: state.config.startMxusd };
      state.start = { ...state.inventory };
    }
    state.running = true; state.startedAt = Date.now();
    reconcile(Date.now());
    save();
    return { ok: true };
  }

  function stop() {
    if (!state.running) return { error: 'It is already stopped.' };
    state.running = false; state.startedAt = null; state.rungs = {}; state.cooldowns = {};
    save();
    return { ok: true };
  }

  // The old record is kept beside the new one, never erased.
  function reset() {
    if (state.running) return { error: 'Stop it first.' };
    if (state.inventory || state.fills.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, file.replace(/\.json$/, `.${stamp}.json`));
    }
    const { config, feed } = state;
    state = { ...blank(), config, feed };
    preview = desired(Date.now());
    save();
    return { ok: true };
  }

  function view() {
    const now = Date.now(), f = state.feed, inv = state.inventory, s = state.start;
    const worth = (x) => (x && f.mid > 0 ? x.minima * f.mid + x.mxusd : null);
    const p = pending();
    const value = inv ? worth({ minima: inv.minima + p.minima, mxusd: inv.mxusd + p.mxusd }) : null, hold = worth(s);
    return {
      config: state.config, running: state.running, startedAt: state.startedAt,
      feed: { mid: f.mid, ageSeconds: f.at ? Math.round((now - f.at) / 1000) : null, widen: f.mid ? widen(now) : 1, jumpWaiting: !!f.pending, withdrawn: !(f.mid > 0) || now - f.at > HARD_STALE_MS },
      rungs: state.running ? Object.values(state.rungs) : preview.map((r) => ({ ...r, status: 'preview' })),
      inventory: inv, settling: p, start: s, value, hold, edge: value === null ? null : value - hold,
      fills: state.fills.slice(0, 50), fillCount: state.fills.length, requotes: state.requotes, series: state.series,
    };
  }

  return { tick, setConfig, start, stop, reset, view };
}
