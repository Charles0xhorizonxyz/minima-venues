/* The live desk: real trades, each pressed by a person, inside a written envelope.
 *
 * Handshake rules, as code:
 *   2  Nothing is sent without a run whose evidence/<run>/ENVELOPE.md was written first (by writeEnvelope). Its caps
 *      cannot be changed once written; new caps mean a new run. Results are added to RESULTS.md beside it.
 *   3  Pool trades go only through its own node (pool-trade.mjs refuses the shared ones).
 *   7  A post with no clear answer is `unknown`: the desk disarms, blocks everything, and a person must look.
 *   8  The journal records a trade before it is posted, and a trade left open by a restart becomes `unknown`.
 *   9  A route whose second leg did not fully fill is `one-legged`: reported, and that route is blocked until released.
 * The desk comes up disarmed after every restart. CEILING caps every envelope, whatever it says.
 * Nothing trades on its own unless the armed envelope turns on "take when crossed" (onScan): then, after each scan, an
 * allowed route may be sent by the desk, through the same send and every cap.
 *
 * Exchanges (EX): MEXC and XT.com, each with its own client (limitOrder, balances, connected), public depth and fee. Its
 * orders are named tb<trade id><leg>, which is how the desk's own orders are told apart from anything else on the account.
 * The desk's profit and loss (view().pnl) counts only the trades in this journal: nothing placed by hand or by another bot.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCall, readPools, quote, swap, watch, loadEngine, isShared, MXUSD } from './pool-trade.mjs';

export const CEILING = { mxusdPerTrade: 100, minimaPerTrade: 30000, tradesPerDay: 50, lossCap: 50 };
const EX = {
  mexc: { name: 'MEXC', fee: '0.0008', minQuote: '1' },
  xt: { name: 'XT', fee: '0.002', minQuote: '1' },
};
const ACTIONS = {
  'pool-sell': 'Sell MINIMA on the pools', 'pool-buy': 'Buy MINIMA on the pools',
  'mexc-sell': 'Sell MINIMA on MEXC', 'mexc-buy': 'Buy MINIMA on MEXC',
  'xt-sell': 'Sell MINIMA on XT', 'xt-buy': 'Buy MINIMA on XT',
  'route-pool-mexc': 'Route: buy on the pools, sell on MEXC', 'route-mexc-pool': 'Route: sell on the pools, buy on MEXC',
  'route-pool-xt': 'Route: buy on the pools, sell on XT', 'route-xt-pool': 'Route: sell on the pools, buy on XT',
};
// Not trades, but kept in the journal beside them.
const OTHER_KINDS = { cancel: 'Cancel an order', modify: 'Modify an order (cancel, then rest a new one)', rest: 'A resting order' };
const RESTING_KINDS = ['rest', 'modify'];
const PREVIEW_SECONDS = 45, MAX_TIP_AGE = 180;
const WATCH_EVERY = 10000, WATCH_LIMIT = 30 * 60000;
const DECS = /^\d+(\.\d+)?$/;
const exOf = (a) => (/(^|-)(mexc|xt)(-|$)/.exec(a) || [])[2] || null;
const isRoute = (a) => a.startsWith('route');
const usesPool = (a) => a.startsWith('pool') || isRoute(a);
const sellsOnPool = (a) => a === 'pool-sell' || /^route-(mexc|xt)-pool$/.test(a);   // the pool leg pays MINIMA in

/* clients: { mexc, xt } (each: limitOrder, balances, connected, view); depths: { mexc, xt } public book readers. */
// isPaper: true while the app is in paper mode (Settings): the desk then arms, sends and takes nothing.
export function createDesk({ root, node, clients, depths, timing, token = MXUSD, isPaper = () => false }) {   // token: a test chain's stand-in for MxUSD
  const E = loadEngine(), D = E.D;
  const dir = path.join(root, 'data', 'live');
  const stateFile = path.join(dir, 'desk.json'), journalFile = path.join(dir, 'journal.jsonl');
  let st = { run: null, envelope: null, armed: false, blocks: [], seq: 0 };
  let stateLost = false;
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), armed: false }; }
  catch (e) { if (e.code !== 'ENOENT') stateLost = true; }   // there but unreadable: never start as if nothing happened
  const entries = new Map();
  try {
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); entries.set(e.id, { ...entries.get(e.id), ...e }); } catch { /* a torn last line */ }
    }
  } catch { /* first run */ }
  const previews = new Map();
  let busy = null, lastError = null;

  // Written whole or not at all: a temporary file, flushed, then renamed over the old one.
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile + '.tmp', fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(st, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, stateFile);
  };
  function record(e) {
    const merged = { ...entries.get(e.id), ...e, updatedAt: Date.now() };
    entries.set(e.id, merged);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(journalFile, 'a');
    try { fs.writeSync(fd, JSON.stringify(merged) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return merged;
  }
  function result(line, run = st.run) {
    if (!run) return;
    try { fs.appendFileSync(path.join(root, 'evidence', run, 'RESULTS.md'), line + '\n'); } catch { /* the journal still has it */ }
  }
  function block(action, why, entryId) {
    st.blocks.push({ id: crypto.randomBytes(4).toString('hex'), action, why, entryId: entryId ?? null, at: Date.now() });
    if (action === 'all') st.armed = false;
    save();
  }

  // A trade the server was in the middle of when it stopped: nobody can say how it ended.
  if (stateLost) block('all', 'The desk state file could not be read. Check the journal and the evidence folder, then release.');
  for (const e of entries.values()) {
    if (e.status === 'sending') record({ id: e.id, status: 'refused', note: 'the server stopped before anything was posted' });
    if (['posting', 'posted', 'hedging'].includes(e.status)) {
      const leg1 = isRoute(String(e.kind)) && e.minedSeen;
      const where = EX[exOf(String(e.kind))]?.name ?? 'the exchange';
      const note = leg1 ? `the server stopped after the pool leg was on chain; the ${where} hedge may not have been placed. Check ${where} and settle by hand`
        : 'the server stopped while this trade was open; check it on chain and on the exchange';
      record({ id: e.id, status: leg1 ? 'one-legged' : 'unknown', note, endedAt: Date.now() });
      result(`- ${new Date().toISOString()} ${e.id} ${e.label}: ${leg1 ? 'ONE-LEGGED' : 'UNKNOWN'} after a restart: ${note}`, e.run);
    }
  }
  // Every unclear or one-legged trade not yet released by a person holds a block, whatever desk.json says.
  for (const e of entries.values()) {
    if (!['unknown', 'one-legged'].includes(e.status) || e.released || st.blocks.some((b) => b.entryId === e.id)) continue;
    block(e.status === 'unknown' ? 'all' : e.kind, `Trade ${e.id} (${e.label}) is ${e.status}: ${e.note ?? ''}. Check it, then release.`, e.id);
  }

  const call = () => makeCall(node.rpc());
  const today = () => new Date().toISOString().slice(0, 10);
  // A trade counts once something was posted for it (a pool post or an exchange order), refused or not.
  const sentToday = (anyRun = false) => [...entries.values()].filter((e) => (anyRun || e.run === st.run) && e.sentAt && (e.txid || e.exClientId) && new Date(e.sentAt).toISOString().slice(0, 10) === today()).length;
  const runPnl = () => [...entries.values()].filter((e) => e.run === st.run && typeof e.pnl === 'number').reduce((a, e) => a + e.pnl, 0);

  function nodeHealth() {
    const v = node.view();
    if (isShared(node.rpc())) return 'The node set in Connections is shared with other projects. The desk trades only through the node.';
    if (v.phase !== 'running' || !v.live) return 'The node is not running.';
    if (v.live.tipAge > MAX_TIP_AGE) return `The node is behind: its last block is ${v.live.tipAge} s old.`;
    if (v.live.locked) return 'The node wallet is locked.';
    return null;
  }
  // Arming is for what the desk does by itself (take when crossed, the taker). A person's own trade needs live mode and
  // an envelope, not arming (founder, 2026-11-11).
  function notReady(action, { forPreview = false, auto = false } = {}) {
    if (!ACTIONS[action]) return 'Unknown action.';
    if (!st.envelope) return 'Write an envelope first.';
    if (!st.envelope.actions.includes(action)) return 'The envelope does not allow this action.';
    if (!forPreview && isPaper()) return 'The app is in paper mode: nothing real is sent. Switch to live in Settings.';
    if (!forPreview && auto && !st.armed) return 'The desk is not armed: automatic trading is off.';
    const b = st.blocks.find((x) => x.action === 'all' || x.action === action);
    if (b && !forPreview) return `Blocked: ${b.why}`;
    if (!forPreview && busy) return `Another trade is running (${busy}).`;
    if (usesPool(action)) { const h = nodeHealth(); if (h) return h; }
    const x = exOf(action);
    if (x && !clients[x]?.connected()) return `No ${EX[x].name} key is connected. Set it in Connections.`;
    return null;
  }

  // ---------------------------------------------------------------- envelope and arming
  async function writeEnvelope(body) {
    const run = String(body?.run ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(run)) return { error: 'A run name is 3 to 40 lower-case letters, digits or dashes.', field: 'run' };
    const num = (k, lo, hi, label) => {
      const v = Number(body?.[k]);
      return Number.isFinite(v) && v >= lo && v <= hi ? { v } : { error: `${label} must be from ${lo} to ${hi}.`, field: k };
    };
    const caps = {};
    for (const [k, lo, hi, label] of [
      ['maxMinima', 100, CEILING.minimaPerTrade, 'MINIMA per trade'], ['maxMxusd', 1, CEILING.mxusdPerTrade, 'MxUSD per trade'],
      ['tradesPerDay', 1, CEILING.tradesPerDay, 'Trades a day'], ['lossCap', 0.1, CEILING.lossCap, 'The loss cap'],
      ['slippagePct', 0.1, 3, 'Exchange slippage'], ['minEdge', 0, 100, 'The minimum edge'], ['confirmations', 1, 5, 'Confirmations before the hedge'],
    ]) { const r = num(k, lo, hi, label); if (r.error) return r; caps[k] = r.v; }
    caps.tradesPerDay = Math.floor(caps.tradesPerDay); caps.confirmations = Math.floor(caps.confirmations);
    const actions = (Array.isArray(body?.actions) ? body.actions : []).filter((a) => ACTIONS[a]);
    if (!actions.length) return { error: 'Allow at least one action.', field: 'actions' };
    // Take when crossed (like a take-if-crossed option in other market makers): the desk sends an allowed route by itself.
    caps.autoTake = body?.autoTake === true;
    if (caps.autoTake) {
      for (const [k, lo, hi, label] of [['crossPercent', 0.1, 20, 'The crossing to take'], ['autoCooldown', 180, 86400, 'The wait between takes']]) {
        const r = num(k, lo, hi, label); if (r.error) return r; caps[k] = r.v;
      }
      if (!actions.some(isRoute)) return { error: 'Take when crossed needs at least one route allowed.', field: 'actions' };
    }
    // The form of resting orders, kept with the run for when quoting is live (this version places none).
    const shape = String(body?.shape ?? 'flat');
    if (!['flat', 'grow', 'curve'].includes(shape)) return { error: 'The shape is flat, grow or curve.', field: 'shape' };
    for (const [k, lo, hi, label] of [['spread', 0.1, 20, 'The first rung'], ['slope', 0, 20, 'The slope'], ['levels', 1, 6, 'Levels']]) {
      const r = num(k, lo, hi, label); if (r.error) return r; caps[k] = r.v;
    }
    caps.levels = Math.floor(caps.levels); caps.shape = shape;
    // A taker rule: the desk takes, by itself, the levels of one exchange book that pass all three tests below.
    caps.taker = null;
    if (body?.taker?.on === true) {
      const t = body.taker, venue = String(t.venue), side = String(t.side);
      if (!EX[venue]) return { error: 'The taker venue is MEXC or XT.', field: 'takerVenue' };
      if (side !== 'buy' && side !== 'sell') return { error: 'The taker side is buy (take asks) or sell (hit bids).', field: 'takerSide' };
      const tk = {};
      for (const [k, lo, hi, label, field] of [['limit', 0.00001, 100, 'The taker price limit', 'takerLimit'], ['minSize', 1, CEILING.minimaPerTrade, 'The smallest level to take', 'takerMinSize'], ['maxGap', 0, 1, 'The largest distance from the other side', 'takerMaxGap'], ['cooldown', 60, 86400, 'The wait between takes', 'takerCooldown']]) {
        const v = Number(t[k]);
        if (!Number.isFinite(v) || v < lo || v > hi) return { error: `${label} must be from ${lo} to ${hi}.`, field };
        tk[k] = v;
      }
      if (!/^\d{1,3}(\.\d{1,5})?$/.test(String(t.limit).trim())) return { error: 'The taker price limit has at most 5 decimals.', field: 'takerLimit' };
      if (!actions.includes(`${venue}-${side}`)) return { error: `The taker needs "${ACTIONS[`${venue}-${side}`]}" allowed.`, field: 'actions' };
      caps.taker = { venue, side, ...tk, limit: String(t.limit).trim() };
    }
    if (actions.some(usesPool)) { const h = nodeHealth(); if (h) return { error: h }; }
    const venues = [...new Set(actions.map(exOf).filter(Boolean))];
    for (const x of venues) if (!clients[x]?.connected()) return { error: `Connect a ${EX[x].name} key that can trade first, in Connections, or untick its actions.` };
    const folder = `${today()}-${run}`, evDir = path.join(root, 'evidence', folder);
    if (fs.existsSync(evDir)) return { error: 'That run already exists. Pick a new name: an envelope is never rewritten.', field: 'run' };

    let wallet = null;
    const exchanges = {};
    if (actions.some(usesPool)) {
      const c = call();
      const [addr, bal] = await Promise.all([c('getaddress'), c('balance')]);
      const tok = (id) => (Array.isArray(bal) ? bal.find((b) => String(b.tokenid).toLowerCase() === id.toLowerCase()) : null)?.sendable ?? '0';
      wallet = { address: addr?.address, minima: tok('0x00'), mxusd: tok(token) };
    }
    for (const x of venues) {
      try { exchanges[x] = { keyEnd: clients[x].view().keyEnd, ...(await clients[x].balances()) }; }
      catch (e) { return { error: `${EX[x].name} balances could not be read: ${e.message}` }; }
    }
    const env = { run: folder, writtenAt: new Date().toISOString(), node: node.rpc(), wallet, exchanges, actions, ...caps, ceiling: CEILING };
    const md = [
      `# Envelope: ${folder}`, '',
      `Written ${env.writtenAt} from the dashboard, before any live write of this run (handshake rule 2). Its caps are fixed:`,
      caps.autoTake ? 'new caps need a new run. Trades are pressed by a person, and the desk also takes crossed routes by itself (below).'
        : 'new caps need a new run. Every trade is pressed by a person; nothing trades on its own.', '',
      `- **Node:** ${env.node}, the bot's own.`,
      wallet ? `- **Wallet:** the node's wallet, payout address \`${wallet.address}\`. Sendable when written: ${wallet.minima} MINIMA, ${wallet.mxusd} MxUSD.` : '- **Wallet:** not used by this run.',
      ...(venues.length ? venues.map((x) => `- **${EX[x].name}:** key ending ${exchanges[x].keyEnd}. Balance when written: ${exchanges[x].MINIMA.free} MINIMA, ${exchanges[x].USDT.free} USDT free. Taker fee taken as ${Number(EX[x].fee) * 100}%.`) : ['- **Exchanges:** not used by this run.']),
      `- **Actions allowed:** ${actions.map((a) => ACTIONS[a]).join('; ')}.`,
      `- **Size cap:** at most ${caps.maxMinima} MINIMA and ${caps.maxMxusd} MxUSD in one trade, ${caps.tradesPerDay} trades a day.`,
      `- **Loss cap:** ${caps.lossCap} MxUSD lost on this run's routes, then the desk disarms itself.`,
      `- **Routes:** the pool leg first; the exchange leg after ${caps.confirmations} confirmation(s), a limit at most ${caps.slippagePct}% through the best price (MEXC: the rest cancelled after 4 s; XT: immediate or cancel). A route is sent only when its edge after fees is at least ${caps.minEdge} MxUSD (the pool's 0.5% is in its quote).`,
      caps.autoTake
        ? `- **Take when crossed: on.** While armed, after each scan, the desk sends an allowed route by itself when its edge after fees is at least ${caps.crossPercent}% of the trade and ${caps.minEdge} MxUSD, sized up to the caps above, at most one take every ${caps.autoCooldown} s. Every cap and stop condition applies.`
        : '- **Take when crossed: off.**',
      caps.taker
        ? `- **Taker: on.** While armed, after each scan, the desk ${caps.taker.side === 'buy' ? 'buys' : 'sells'} on ${EX[caps.taker.venue].name} by itself when ${caps.taker.side === 'buy' ? 'asks' : 'bids'} rest at ${caps.taker.side === 'buy' ? 'or under' : 'or over'} ${caps.taker.limit}, in levels of at least ${caps.taker.minSize} MINIMA, at most ${caps.taker.maxGap} from the best ${caps.taker.side === 'buy' ? 'bid' : 'ask'}: one immediate-or-cancel order up to the furthest such level, within the size caps, at most one every ${caps.taker.cooldown} s. A limit also takes the smaller levels in between.`
        : '- **Taker: off.**',
      `- **Resting orders (recorded, not placed by this version):** ${caps.levels} rung(s) a side, the first ${caps.spread}% from the mid, ${caps.slope}% more for each rung further out, shape ${caps.shape}.`,
      '- **Stop conditions:** a post or order with no clear answer (disarm, block all); a route left one-legged (block that route);',
      '  the loss cap reached (disarm); the server restarting mid-trade (block all). A person releases each block.',
      `- **Code ceilings, whatever this says:** ${CEILING.minimaPerTrade} MINIMA, ${CEILING.mxusdPerTrade} MxUSD a trade, ${CEILING.tradesPerDay} a day, loss cap ${CEILING.lossCap}.`,
      '',
    ].join('\n');
    fs.mkdirSync(evDir, { recursive: true });
    fs.writeFileSync(path.join(evDir, 'ENVELOPE.md'), md);
    fs.writeFileSync(path.join(evDir, 'envelope.json'), JSON.stringify(env, null, 1));
    fs.writeFileSync(path.join(evDir, 'RESULTS.md'), `# Results: ${folder}\n\nOne line per trade, written as it ends. Done means seen on chain (pool) or reported filled by the exchange.\n\n`);
    st = { ...st, run: folder, envelope: env, armed: false };
    save();
    return { ok: true };
  }

  function arm() {
    if (isPaper()) return { error: 'The app is in paper mode. Switch to live in Settings first.' };
    if (!st.envelope) return { error: 'Write an envelope first.' };
    if (st.blocks.some((b) => b.action === 'all')) return { error: 'Something is blocked. Look at it and release it first.' };
    if (runPnl() <= -st.envelope.lossCap) return { error: 'This run reached its loss cap. Write a new envelope to go on.' };
    st.armed = true; save();
    record({ id: `arm-${Date.now()}`, run: st.run, kind: 'arm', status: 'done', at: Date.now() });
    return { ok: true };
  }
  function disarm(note = 'disarmed by a person') {
    st.armed = false; save();
    record({ id: `arm-${Date.now()}`, run: st.run, kind: 'disarm', status: 'done', note, at: Date.now() });
    return { ok: true };
  }
  function release(body) {
    const i = st.blocks.findIndex((b) => b.id === String(body?.id ?? ''));
    if (i < 0) return { error: 'No such block.' };
    const [b] = st.blocks.splice(i, 1);
    save();
    if (b.entryId && entries.has(b.entryId)) record({ id: b.entryId, released: true, releasedAt: Date.now() });
    record({ id: `release-${Date.now()}`, run: st.run, kind: 'release', status: 'done', note: `released by a person: ${b.why}`, at: Date.now() });
    return { ok: true };
  }

  // ---------------------------------------------------------------- pricing
  const walk = (rows, qty) => {   // what `qty` MINIMA costs or earns through these book rows
    let left = new D(qty), sum = new D(0), worst = null;
    for (const r of rows) {
      if (left.lte(0)) break;
      const q = D.min(left, r.qty);
      sum = sum.plus(q.times(r.price)); left = left.minus(q); worst = r.price;
    }
    return { filled: new D(qty).minus(left), quote: sum, worst, short: left.gt(0) };
  };
  /* fixed: a limit price the person typed. It may sit away from the book (then little or nothing fills, and the rest is
   * cancelled at once), but never further through the book than the envelope's slippage allows. */
  function exSide(x, side, qty, depth, slipPct, fixed = null) {
    const rows = side === 'BUY' ? depth.asks : depth.bids;
    if (!rows.length) return { error: `${EX[x].name} shows no ${side === 'BUY' ? 'asks' : 'bids'}` };
    const best = new D(rows[0].price), slip = new D(slipPct).div(100);
    const cap = side === 'BUY' ? best.times(D(1).plus(slip)).toDP(5, D.ROUND_DOWN) : best.times(D(1).minus(slip)).toDP(5, D.ROUND_UP);
    if (fixed !== null && (side === 'BUY' ? new D(fixed).gt(cap) : new D(fixed).lt(cap))) return { error: `That price is more than ${slipPct}% through ${EX[x].name}'s best ${side === 'BUY' ? 'ask' : 'bid'} (${best.toString()}), past the envelope's slippage. The most is ${cap.toString()}.`, field: 'limit' };
    const limit = fixed !== null ? new D(fixed) : cap;
    const inLimit = rows.filter((r) => (side === 'BUY' ? new D(r.price).lte(limit) : new D(r.price).gte(limit)));
    const w = walk(inLimit, qty);
    const fee = w.quote.times(EX[x].fee);
    return { venue: x, name: EX[x].name, type: fixed !== null ? 'limit' : 'market', side, qty: new D(qty).toString(), limit: limit.toString(), best: best.toString(), filledAtLimit: w.filled.toString(), short: w.short, quote: w.quote.toString(), fee: fee.toString(), net: (side === 'BUY' ? w.quote.plus(fee) : w.quote.minus(fee)).toString() };
  }
  const qty2 = (x, up) => new D(x).toDP(2, up ? D.ROUND_UP : D.ROUND_DOWN);

  async function preview(body) {
    const action = String(body?.action ?? ''), amount = String(body?.amount ?? '').trim();
    const nr = notReady(action, { forPreview: true });
    if (nr) return { error: nr };
    if (!DECS.test(amount) || !(Number(amount) > 0)) return { error: 'Enter an amount.', field: 'amount' };
    const env = st.envelope, x = exOf(action);
    const p = { id: crypto.randomBytes(6).toString('hex'), run: st.run, action, label: ACTIONS[action], amount, at: Date.now(), warnings: [] };
    let pools = null;
    if (usesPool(action)) pools = await readPools(call(), token);
    const depth = x ? await depths[x](100) : null;
    const tooBig = (minima, mxusd) => {
      if (new D(minima).gt(env.maxMinima)) return `That is ${new D(minima).toDP(2).toString()} MINIMA, over the envelope's ${env.maxMinima}.`;
      if (new D(mxusd).gt(env.maxMxusd)) return `That is ${new D(mxusd).toDP(4).toString()} MxUSD, over the envelope's ${env.maxMxusd}.`;
      return null;
    };
    if (usesPool(action)) {
      const sellMinima = sellsOnPool(action);
      const plan = quote(pools, sellMinima, amount);
      if (!plan) return { error: 'The pools cannot take this amount.' };
      p.plan = plan;
      p.pool = { sellMinima, minima: plan.minima, mxusd: plan.mxusd, price: plan.price, pools: plan.allocs.length, totalIn: plan.totalIn, totalOut: plan.totalOut };
      const big = tooBig(plan.minima, plan.mxusd); if (big) return { error: big };
    }
    if (x && !isRoute(action)) {
      const lim = String(body?.limit ?? '').trim();
      if (lim && (!/^\d{1,3}(\.\d{1,5})?$/.test(lim) || !(Number(lim) > 0))) return { error: 'A price has at most 5 decimals, like 0.00301.', field: 'limit' };
      const m = exSide(x, action.endsWith('-buy') ? 'BUY' : 'SELL', qty2(amount).toString(), depth, env.slippagePct, lim || null);
      if (m.error) return { error: m.error, field: m.field };
      if (lim) p.label = `${p.label}, limit ${lim}`;
      p.ex = m;
      const big = tooBig(m.qty, new D(m.qty).times(m.limit)); if (big) return { error: big };   // the most the order can cost or bring
      if (new D(m.qty).times(m.limit).lt(EX[x].minQuote)) return { error: `${EX[x].name} takes orders of at least ${EX[x].minQuote} USDT.` };
      if (m.short) p.warnings.push(new D(m.filledAtLimit).isZero() ? `Nothing fills at ${m.limit} on ${EX[x].name} now: the order would be cancelled with nothing done.` : `Only about ${new D(m.filledAtLimit).toDP(2).toString()} MINIMA fills at ${m.limit} or better now; the rest is cancelled.`);
    }
    if (isRoute(action)) {
      const side = action.startsWith('route-pool-') ? 'SELL' : 'BUY';
      const q = qty2(p.plan.minima, side === 'BUY').toString();   // exchanges take 2 decimals: buy back a hair more, sell a hair less
      const m = exSide(x, side, q, depth, env.slippagePct);
      if (m.error) return { error: m.error };
      if (new D(q).times(m.limit).lt(EX[x].minQuote)) return { error: `The ${EX[x].name} leg would be under ${EX[x].minQuote} USDT.` };
      // The edge is only real if the whole hedge fits in the book within the limit; otherwise it ends one-legged.
      if (m.short) return { error: `${EX[x].name} cannot take the whole hedge within ${env.slippagePct}% of its best price right now. Try a smaller amount.` };
      p.ex = m;
      p.edge = (side === 'SELL' ? new D(m.net).minus(p.plan.mxusd) : new D(p.plan.mxusd).minus(m.net)).toString();
      const t = timing?.();
      const seconds = env.confirmations * (t?.blockSeconds ?? 50) + 6;
      p.seconds = Math.round(seconds);
      p.risk = t?.volatility ? Number(p.plan.mxusd) * t.volatility.perMinute * Math.sqrt(seconds / 60) : null;
      if (new D(p.edge).lt(env.minEdge)) p.warnings.push(`The edge after fees is under the envelope's minimum of ${env.minEdge} MxUSD: it will not send.`);
    }
    previews.set(p.id, p);
    for (const [k, v] of previews) if (Date.now() - v.at > PREVIEW_SECONDS * 1000 * 4) previews.delete(k);
    const { plan, ...shown } = p;
    return { ok: true, preview: shown };
  }

  // ---------------------------------------------------------------- sending
  /* Everything up to taking the preview and the busy lock is synchronous, so two presses (two tabs, a double click, a
   * repeated request) can never both get past it: the second finds the preview gone or the desk busy. */
  async function send(body) {
    const p = previews.get(String(body?.previewId ?? ''));
    if (!p) return { error: 'Preview first, or this preview was already sent.' };
    if (Date.now() - p.at > PREVIEW_SECONDS * 1000) return { error: `That preview is over ${PREVIEW_SECONDS} s old. Preview again.` };
    if (p.run !== st.run) return { error: 'That preview was made under another envelope. Preview again.' };
    const nr = notReady(p.action, { auto: body?.auto === true }); if (nr) return { error: nr };
    const env = st.envelope;
    if (sentToday() >= env.tradesPerDay) return { error: `Today's ${env.tradesPerDay} trades are used.` };
    if (sentToday(true) >= CEILING.tradesPerDay) return { error: `Today's ${CEILING.tradesPerDay} trades across all runs are used.` };
    if (runPnl() <= -env.lossCap) { disarm('the loss cap was reached'); return { error: 'The loss cap is reached. The desk disarmed.' }; }
    if (isRoute(p.action) && new D(p.edge).lt(env.minEdge)) return { error: 'The edge is under the minimum.' };
    previews.delete(p.id);
    busy = `checking, ${p.label}`;
    const free = (r) => { busy = null; return r; };
    if (p.ex) {
      const name = EX[p.ex.venue].name;
      let b; try { b = await clients[p.ex.venue].balances(); } catch (e) { return free({ error: `${name} balances could not be read: ${e.message}. Preview again.` }); }
      const need = p.ex.side === 'BUY' ? new D(p.ex.qty).times(p.ex.limit).times(D(1).plus(EX[p.ex.venue].fee)) : new D(p.ex.qty);
      const have = p.ex.side === 'BUY' ? b.USDT.free : b.MINIMA.free;
      if (new D(have).lt(need)) return free({ error: `${name} has ${have} ${p.ex.side === 'BUY' ? 'USDT' : 'MINIMA'} free, the trade needs ${need.toDP(4).toString()}.` });
      if (body?.auto === true && !st.armed) return free({ error: 'The desk was disarmed meanwhile.' });
    }
    st.seq += 1; save();
    const id = `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;   // never repeats, whatever desk.json holds
    const e = record({ id, run: st.run, kind: p.action, label: p.label + (body?.auto === true ? ' (taken by itself)' : ''), auto: body?.auto === true, status: 'sending', at: Date.now(), sentAt: Date.now(), preview: { ...p, plan: undefined } });
    busy = `${e.id}, ${p.label}`;
    run(e, p).catch((err) => { lastError = err.message; record({ id: e.id, status: 'unknown', note: `the desk stopped on an error: ${err.message}` }); block('all', `Trade ${e.id} stopped on an error. Check it, then release.`, e.id); })
      .finally(() => { busy = null; });
    return { ok: true, started: e.id };
  }

  async function poolLeg(e, plan) {
    const c = call();
    const r = await swap(c, plan, { beforePost: async (x) => { record({ id: e.id, status: 'posting', txid: x.txid, inputs: x.inputs, payout: x.taddr }); } });
    if (r.refused) return { end: 'refused', why: r.why };
    if (r.unknown) return { end: 'unknown', why: r.why };
    record({ id: e.id, status: 'posted', txpowid: r.txpowid, proceedsCoin: r.proceedsCoin });
    const until = Date.now() + WATCH_LIMIT;
    let lostAt = null;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, WATCH_EVERY));
      let w; try { w = await watch(c, r, plan); } catch { continue; }
      if (w.state === 'mined') {
        record({ id: e.id, confirmations: w.confirmations, minedSeen: Date.now(), poolDone: true });
        if (w.confirmations >= st.envelope.confirmations) return { end: 'mined', txpowid: r.txpowid, confirmations: w.confirmations };
        lostAt = null; continue;
      }
      if (w.state === 'lost') { if (!lostAt) lostAt = { at: Date.now(), tip: w.tip }; else if (w.tip > lostAt.tip && Date.now() - lostAt.at > 60000) return { end: 'lost', why: 'someone moved the pool first; this swap can never be mined' }; continue; }
      if (w.state === 'unclear') return { end: 'unknown', why: 'the post gave no proceeds coin to watch' };
      lostAt = null;
    }
    return { end: 'unknown', why: 'the swap was not seen in a block within 30 minutes' };
  }

  async function exLeg(e, m, tag) {
    const clientId = `tb${e.id}${tag}`.slice(0, 22);   // XT allows 22 letters, digits or _; MEXC more
    record({ id: e.id, status: tag === 'h' ? 'hedging' : 'posting', exClientId: clientId, exOrder: { venue: m.venue, side: m.side, qty: m.qty, limit: m.limit } });
    return clients[m.venue].limitOrder({ side: m.side, quantity: m.qty, price: m.limit, clientId });
  }

  function finish(e, status, fields, line) {
    const done = record({ id: e.id, status, endedAt: Date.now(), ...fields });
    result(`- ${new Date().toISOString()} ${e.id} ${e.label}: ${line}`);
    if (st.envelope && runPnl() <= -st.envelope.lossCap) { block('all', 'The loss cap is reached.'); }
    return done;
  }

  async function run(e, p) {
    const a = p.action, x = exOf(a), name = x && EX[x].name;
    if (a === 'pool-sell' || a === 'pool-buy') {
      const r = await poolLeg(e, p.plan);
      if (r.end === 'mined') return finish(e, 'done', { pool: p.pool }, `swap ${p.pool.minima} MINIMA for ${p.pool.mxusd} MxUSD mined (${r.confirmations} conf), txpow ${r.txpowid}`);
      if (r.end === 'unknown') { block('all', `Pool swap ${e.id}: ${r.why}. Check the chain, then release.`, e.id); return finish(e, 'unknown', { note: r.why }, `UNKNOWN: ${r.why}`); }
      return finish(e, r.end, { note: r.why }, `${r.end}, nothing traded: ${r.why}`);
    }
    if (!isRoute(a)) {
      const r = await exLeg(e, p.ex, 'm');
      if (r.done && new D(r.executedQty).isZero()) return finish(e, 'unfilled', { exFill: r }, `${name} ${p.ex.side} at ${p.ex.limit}: nothing filled, cancelled`);
      if (r.done) return finish(e, 'done', { exFill: r }, `${name} ${p.ex.side} ${r.executedQty} of ${p.ex.qty} MINIMA for ${r.quoteQty} USDT (${r.status})`);
      if (r.unknown) { block('all', `${name} order ${e.id}: ${r.why}. Check ${name}, then release.`, e.id); return finish(e, 'unknown', { note: r.why }, `UNKNOWN: ${r.why}`); }
      return finish(e, 'refused', { note: r.why }, `refused, nothing traded: ${r.why}`);
    }
    // A route: the pool leg, which can fail whole, first; the exchange leg once the pool leg is on chain.
    const r = await poolLeg(e, p.plan);
    if (r.end === 'unknown') { block('all', `Route ${e.id}, pool leg: ${r.why}. Check the chain, then release.`, e.id); return finish(e, 'unknown', { note: r.why }, `UNKNOWN pool leg, no hedge sent: ${r.why}`); }
    if (r.end !== 'mined') return finish(e, r.end, { note: r.why }, `${r.end}, nothing traded: ${r.why}`);
    let depth; try { depth = await depths[x](100); } catch { depth = null; }
    const m = depth ? exSide(x, p.ex.side, p.ex.qty, depth, st.envelope.slippagePct) : null;
    if (!m || m.error) {
      block(a, `Route ${e.id} is one-legged: the pool leg is done and ${name} could not be priced for the hedge.`, e.id);
      return finish(e, 'one-legged', { note: `no ${name} price for the hedge` }, `ONE-LEGGED: pool done (${r.txpowid}), hedge not sent`);
    }
    const h = await exLeg(e, m, 'h');
    if (h.unknown) { block('all', `Route ${e.id}, ${name} leg: ${h.why}. Check ${name}, then release.`, e.id); return finish(e, 'unknown', { note: h.why }, `UNKNOWN hedge: ${h.why}`); }
    const filled = new D(h.done ? h.executedQty : 0);
    const usdt = new D(h.done ? h.quoteQty : 0), fee = usdt.times(EX[x].fee);
    const pnl = a.startsWith('route-pool-') ? usdt.minus(fee).minus(p.plan.mxusd) : new D(p.plan.mxusd).minus(usdt).minus(fee);
    if (filled.lt(new D(m.qty).minus('0.01'))) {
      block(a, `Route ${e.id} is one-legged: ${name} filled ${filled.toString()} of ${m.qty} MINIMA. Settle the rest by hand, then release.`, e.id);
      return finish(e, 'one-legged', { exFill: h, hedgeLimit: m.limit, note: h.refused ? h.why : `filled ${filled} of ${m.qty}` }, `ONE-LEGGED: pool done (${r.txpowid}), ${name} filled ${filled} of ${m.qty}`);
    }
    return finish(e, 'done', { exFill: h, hedgeLimit: m.limit, pnl: Number(pnl.toString()) }, `pool ${p.pool.minima} MINIMA / ${p.pool.mxusd} MxUSD (${r.txpowid}), ${name} ${h.executedQty} for ${h.quoteQty} USDT; result ${pnl.toDP(6).toString()} MxUSD after an estimated ${fee.toDP(6).toString()} fee`);
  }

  // ---------------------------------------------------------------- take when crossed
  /* After each scan, while armed with an envelope that allows it: when the scan shows an allowed route paying, preview it
   * at the envelope's size, then half, a quarter, a tenth, and send the largest whose edge after fees is at least
   * crossPercent of the trade and minEdge. The send goes through `send`, so every cap, block and stop condition holds. */
  /* The taker rule, after each scan, while armed. One order at most per cooldown, through preview and send: every cap,
   * block and stop rule holds, and the limit may not go further through the book than the envelope's slippage. */
  const taker = { lastAt: 0, note: null, running: false };
  async function takerScan() {
    const env = st.envelope, t = env?.taker;
    if (!t || !st.armed || busy || taker.running || isPaper()) return;
    if (Date.now() - taker.lastAt < t.cooldown * 1000) { taker.note = `Waiting ${Math.ceil((taker.lastAt + t.cooldown * 1000 - Date.now()) / 1000)} s after the last take.`; return; }
    const action = `${t.venue}-${t.side}`, nr = notReady(action);
    if (nr) { taker.note = nr; return; }
    taker.running = true;
    try {
      const depth = await depths[t.venue](100), buy = t.side === 'buy';
      const rows = buy ? depth.asks : depth.bids, other = (buy ? depth.bids : depth.asks)[0];
      if (!rows.length || !other) { taker.note = `${EX[t.venue].name} shows no ${buy ? 'asks or bids' : 'bids or asks'}.`; return; }
      const ref = new D(other.price), lim = new D(t.limit);
      const passes = (r) => new D(r.qty).gte(t.minSize) && (buy ? new D(r.price).lte(lim) && new D(r.price).lte(ref.plus(t.maxGap)) : new D(r.price).gte(lim) && new D(r.price).gte(ref.minus(t.maxGap)));
      const good = rows.filter(passes);
      if (!good.length) { taker.note = `Nothing passes the rule at the last check (best ${buy ? 'ask' : 'bid'} ${rows[0].price}).`; return; }
      const far = good.reduce((a, r) => (buy ? (new D(r.price).gt(a) ? new D(r.price) : a) : (new D(r.price).lt(a) ? new D(r.price) : a)), new D(good[0].price));
      let qty = rows.filter((r) => (buy ? new D(r.price).lte(far) : new D(r.price).gte(far))).reduce((a, r) => a.plus(r.qty), new D(0));
      qty = D.min(qty, env.maxMinima, new D(env.maxMxusd).div(far)).toDP(2, D.ROUND_DOWN);
      if (qty.times(far).lt(EX[t.venue].minQuote)) { taker.note = 'What passes is under the exchange minimum.'; return; }
      const p = await preview({ action, amount: qty.toString(), limit: far.toString() });
      if (!p.ok) { taker.note = `Not sent: ${p.error}`; taker.lastAt = Date.now(); return; }
      const r = await send({ previewId: p.preview.id, auto: true });
      taker.lastAt = Date.now();
      taker.note = r.ok ? `Sent: ${buy ? 'buy' : 'sell'} ${qty.toString()} MINIMA up to ${far.toString()} on ${EX[t.venue].name}.` : `Refused: ${r.error}`;
    } catch (e) { taker.note = `The taker check failed: ${e.message}`; }
    finally { taker.running = false; }
  }

  const auto = { lastAt: 0, checkedAt: null, note: null, running: false };
  async function onScan(s) {
    await trackResting().catch(() => {});
    await takerScan().catch(() => {});
    const env = st.envelope;
    if (isPaper()) return;
    if (!env?.autoTake || !st.armed || busy || auto.running) return;
    if (Date.now() - auto.lastAt < env.autoCooldown * 1000) { auto.note = `Waiting ${Math.ceil((auto.lastAt + env.autoCooldown * 1000 - Date.now()) / 1000)} s after the last take.`; return; }
    const pays = (b, c) => (s?.routes ?? []).some((q) => q.buy === b && q.sell === c && q.profit > 0);
    const candidates = [];
    for (const x of Object.keys(EX)) {
      if (env.actions.includes(`route-pool-${x}`) && pays('POOL', EX[x].name)) candidates.push(`route-pool-${x}`);
      if (env.actions.includes(`route-${x}-pool`) && pays(EX[x].name, 'POOL')) candidates.push(`route-${x}-pool`);
    }
    auto.checkedAt = Date.now();
    if (!candidates.length) { auto.note = 'Not crossed at the last scan.'; return; }
    auto.running = true;
    try {
      for (const action of candidates) {
        if (notReady(action)) continue;
        const buyOnPool = action.startsWith('route-pool-');
        const top = new D(buyOnPool ? env.maxMxusd : env.maxMinima);
        for (const f of ['1', '0.5', '0.25', '0.1']) {
          const amount = top.times(f).toDP(buyOnPool ? 4 : 2, D.ROUND_DOWN).toString();
          const p = await preview({ action, amount });
          if (!p.ok) continue;
          const edge = new D(p.preview.edge), notional = new D(p.preview.pool.mxusd);
          if (edge.lt(env.minEdge) || edge.div(notional).times(100).lt(env.crossPercent)) continue;
          const r = await send({ previewId: p.preview.id, auto: true });
          auto.lastAt = Date.now();
          auto.note = r.ok ? `Took "${ACTIONS[action]}" with ${amount}, edge ${edge.toDP(4).toString()} MxUSD.` : `A take was refused: ${r.error}`;
          return;
        }
      }
      auto.note = 'Crossed at the scan, but not by enough after fees at any size within the caps.';
    } catch (e) { auto.note = `The take check failed: ${e.message}`; }
    finally { auto.running = false; }
  }

  /* The desk's own profit and loss, from its journal only: every pool swap seen on chain and every exchange fill this
   * desk placed. Cash in MxUSD (1 MxUSD = 1 USDT), the MINIMA position marked at `mid`. Exchange fees estimated at the
   * taker rate. Nothing placed by hand or by another program on the same accounts counts. */
  function pnl(mid) {
    let cash = 0, minima = 0, fees = 0, trades = 0, since = null;
    for (const e of entries.values()) {
      if (RESTING_KINDS.includes(e.kind)) {
        const f = e.exFill;
        if (f?.done && Number(f.executedQty) > 0) {
          const q = Number(f.executedQty), u = Number(f.quoteQty), fee = u * Number(EX[e.venue]?.fee ?? 0);   // the taker fee: a cautious estimate
          if (e.exOrder?.side === 'BUY') { minima += q; cash -= u; } else { minima -= q; cash += u; }
          cash -= fee; fees += fee; trades++; since = since === null ? e.at : Math.min(since, e.at);
        }
        continue;
      }
      if (!ACTIONS[e.kind] || !['done', 'one-legged', 'unfilled'].includes(e.status)) continue;
      const pv = e.preview || {};
      if (pv.pool && (e.status === 'done' || e.poolDone)) {
        const m = Number(pv.pool.minima), u = Number(pv.pool.mxusd);
        if (pv.pool.sellMinima) { minima -= m; cash += u; } else { minima += m; cash -= u; }
        trades++;
      }
      const f = e.exFill;
      if (f?.done && Number(f.executedQty) > 0) {
        const q = Number(f.executedQty), u = Number(f.quoteQty), side = e.exOrder?.side, fee = u * Number(EX[e.exOrder?.venue]?.fee ?? 0);
        if (side === 'BUY') { minima += q; cash -= u; } else { minima -= q; cash += u; }
        cash -= fee; fees += fee; trades++;
      }
      since = since === null ? e.at : Math.min(since, e.at);
    }
    return { cash, minima, fees, trades, since, mid: mid ?? null, total: mid > 0 ? cash + minima * mid : null };
  }

  function view(mid) {
    const list = [...entries.values()].filter((e) => e.kind !== undefined).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 100);
    return {
      run: st.run, envelope: st.envelope, armed: st.armed, blocks: st.blocks, busy, lastError, actions: ACTIONS, kinds: { ...ACTIONS, ...OTHER_KINDS }, ceiling: CEILING,
      today: st.run ? sentToday() : 0, runPnl: st.run ? runPnl() : 0, nodeProblem: nodeHealth(),
      exchanges: Object.fromEntries(Object.entries(EX).map(([k, v]) => [k, { name: v.name, fee: v.fee, connected: !!clients[k]?.connected() }])),
      auto: { ...auto }, taker: { lastAt: taker.lastAt, note: taker.note }, pnl: pnl(mid), journal: list,
    };
  }

  // ---------------------------------------------------------------- cancel and modify open exchange orders
  /* Cancel: any open order on MEXC or XT, this desk's or one placed by hand, in live mode, armed or not (it only
   * removes an order). Modify: cancel, check it ended, then a post-only order at the new price that rests on the book;
   * that one is placed only while armed, within the envelope, and counts as one of the day's trades. */
  const PX = /^\d{1,3}(\.\d{1,5})?$/, QX = /^\d{1,9}(\.\d{1,2})?$/;
  async function cancelOrder(body) {
    const venue = String(body?.venue ?? ''), orderId = String(body?.orderId ?? '');
    if (!EX[venue]) return { error: 'The venue is MEXC or XT.' };
    if (isPaper()) return { error: 'The app is in paper mode: nothing real is sent. Switch to live in Settings.' };
    if (!clients[venue]?.connected()) return { error: `No ${EX[venue].name} key is connected.` };
    if (busy) return { error: `Another trade is running (${busy}).` };
    busy = `cancelling on ${EX[venue].name}`;
    const id = `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    try {
      record({ id, run: st.run, kind: 'cancel', label: `Cancel ${EX[venue].name} order ${orderId}`, status: 'sending', at: Date.now(), venue, orderId });
      const r = await clients[venue].cancelOrder({ orderId });
      if (r.refused) { record({ id, status: 'refused', note: r.why }); return { error: `${EX[venue].name}: ${r.why}` }; }
      if (r.unknown) { record({ id, status: 'unknown', note: r.why }); return { error: `${r.why}. Look at it on ${EX[venue].name}.` }; }
      const filled = Number(r.executedQty) > 0 ? `, ${r.executedQty} of ${r.origQty} had filled` : '';
      record({ id, status: 'done', note: `${r.status === 'FILLED' ? 'it had filled before the cancel' : 'cancelled'}${filled}` });
      return { ok: true, status: r.status, executedQty: r.executedQty, origQty: r.origQty };
    } finally { busy = null; }
  }

  /* A resting order: checked first (armed, envelope, caps, it must not trade at once, near the market), then placed
   * post-only. Used by a right-click on the chart (rest) and by modify, after its cancel. */
  async function checkResting(body) {
    const venue = String(body?.venue ?? ''), side = String(body?.side ?? '');
    const price = String(body?.price ?? '').trim(), quantity = String(body?.quantity ?? '').trim();
    if (!EX[venue]) return { error: 'The venue is MEXC or XT.' };
    if (side !== 'buy' && side !== 'sell') return { error: 'The side is buy or sell.' };
    const action = `${venue}-${side}`, nr = notReady(action); if (nr) return { error: nr };
    if (!PX.test(price) || !(Number(price) > 0)) return { error: 'A price has at most 5 decimals, like 0.00301.', field: 'price' };
    if (!QX.test(quantity) || !(Number(quantity) > 0)) return { error: 'An amount of MINIMA, at most 2 decimals.', field: 'quantity' };
    const env = st.envelope, q = new D(quantity), p = new D(price), value = q.times(p);
    if (q.gt(env.maxMinima) || q.gt(CEILING.minimaPerTrade)) return { error: `The envelope allows at most ${env.maxMinima} MINIMA per order.`, field: 'quantity' };
    if (value.gt(env.maxMxusd) || value.gt(CEILING.mxusdPerTrade)) return { error: `The envelope allows at most ${env.maxMxusd} USDT per order (this one is ${value.toDP(2).toString()}).`, field: 'quantity' };
    if (value.lt(EX[venue].minQuote)) return { error: `${EX[venue].name} needs at least ${EX[venue].minQuote} USDT per order.`, field: 'quantity' };
    if (sentToday() >= env.tradesPerDay) return { error: `Today's ${env.tradesPerDay} trades are used.` };
    if (sentToday(true) >= CEILING.tradesPerDay) return { error: `Today's ${CEILING.tradesPerDay} trades across all runs are used.` };
    let best; try { best = await depths[venue](5); } catch (e) { return { error: `${EX[venue].name}'s book could not be read: ${e.message}` }; }
    const ask = best.asks[0]?.price, bid = best.bids[0]?.price;
    if (side === 'buy' && ask && p.gte(ask)) return { error: `At ${price} a buy would trade at once (best ask ${ask}). Use the ticket for that.`, field: 'price' };
    if (side === 'sell' && bid && p.lte(bid)) return { error: `At ${price} a sell would trade at once (best bid ${bid}). Use the ticket for that.`, field: 'price' };
    const mid = ask && bid ? (Number(ask) + Number(bid)) / 2 : null;
    if (mid && Math.abs(Number(price) / mid - 1) > 0.3) return { error: 'That price is more than 30% from the market. Check the price.', field: 'price' };
    return { ok: true, venue, side, price, quantity, action, value, q };
  }

  async function placeResting(c, { label, kind, before = '' }) {
    const { venue, side, price, quantity, action, value, q } = c;
    busy = `placing on ${EX[venue].name}`;
    const id = `${kind[0]}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, clientId = `tb${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    try {
      let b; try { b = await clients[venue].balances(); } catch (e) { return { error: `${before}Not placed: ${EX[venue].name} balances could not be read (${e.message}).` }; }
      const need = side === 'buy' ? value : q, have = side === 'buy' ? b.USDT.free : b.MINIMA.free;
      if (new D(have).lt(need)) return { error: `${before}Not placed: ${EX[venue].name} has ${have} ${side === 'buy' ? 'USDT' : 'MINIMA'} free, it needs ${need.toDP(4).toString()}.` };
      st.seq += 1; save();
      record({ id, run: st.run, kind, label, status: 'sending', at: Date.now(), sentAt: Date.now(), exClientId: clientId, venue, exOrder: { venue, side: side.toUpperCase(), qty: quantity, limit: price } });
      const r = await clients[venue].restingOrder({ side: side.toUpperCase(), quantity, price, clientId });
      if (r.refused) { record({ id, status: 'refused', note: r.why }); return { error: `${before}Refused: ${r.why}` }; }
      if (r.unknown) {
        record({ id, status: 'unknown', note: r.why });
        block(action, `A resting order (${clientId}) on ${EX[venue].name} may or may not be on the book: ${r.why}. Look on ${EX[venue].name}, then release.`, id);
        return { error: `${before}Unclear: ${r.why}. ${ACTIONS[action]} is blocked until you check.` };
      }
      record({ id, status: 'resting', note: `${r.status}, order ${r.orderId}`, exOrderId: r.orderId });
      return { ok: true, orderId: r.orderId, status: r.status, entry: id };
    } finally { busy = null; }
  }

  async function restOrder(body) {
    const c = await checkResting(body); if (c.error) return c;
    return placeResting(c, { kind: 'rest', label: `${c.side === 'buy' ? 'Buy' : 'Sell'} ${c.quantity} MINIMA resting at ${c.price} on ${EX[c.venue].name}` });
  }

  async function modifyOrder(body) {
    const orderId = String(body?.orderId ?? '');
    const c = await checkResting(body); if (c.error) return c;
    const x = await cancelOrder({ venue: c.venue, orderId });
    if (x.error) return { error: `Not modified: the cancel failed. ${x.error}` };
    if (x.status === 'FILLED') return { error: 'Not modified: the order filled before the cancel. Nothing new was placed.' };
    return placeResting(c, { kind: 'modify', before: 'Cancelled. ', label: `${c.side === 'buy' ? 'Buy' : 'Sell'} ${c.quantity} MINIMA resting at ${c.price} on ${EX[c.venue].name} (replaces ${orderId})` });
  }

  /* The desk's resting orders, followed after each scan: fills go into the journal (and so the P&L) as they happen. */
  let tracking = false;
  async function trackResting() {
    if (tracking) return; tracking = true;
    try {
      const open = [...entries.values()].filter((e) => RESTING_KINDS.includes(e.kind) && e.status === 'resting' && e.exClientId).slice(0, 30);
      for (const e of open) {
        let o; try { o = await clients[e.venue]?.orderStatus?.(e.exClientId); } catch { continue; }
        if (!o) continue;
        const qty = String(o.executedQty ?? '0'), quote = String(o.quoteQty ?? '0');
        const fill = Number(qty) > 0 ? { done: true, executedQty: qty, quoteQty: quote } : e.exFill;
        const ended = ['FILLED', 'CANCELED', 'PARTIALLY_CANCELED', 'REJECTED', 'EXPIRED'].includes(o.status);
        const status = !ended ? 'resting' : o.status === 'FILLED' ? 'filled' : Number(qty) > 0 ? 'partly filled' : 'cancelled';
        if (status !== e.status || qty !== (e.exFill?.executedQty ?? '0')) record({ id: e.id, status, exFill: fill, note: `${o.status}${Number(qty) > 0 ? `, ${qty} filled for ${quote} USDT` : ''}` });
      }
    } finally { tracking = false; }
  }

  return { writeEnvelope, arm, disarm, release, preview, send, view, onScan, cancelOrder, modifyOrder, restOrder, trackResting, armed: () => st.armed };
}
