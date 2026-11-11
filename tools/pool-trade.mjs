/* PandaPools swaps from the bot's own node.
 *
 * Pricing, rounding and routing are PandaPools' own files (vendor/pandapools, MIT, unedited, hash-pinned) run in a
 * node:vm context: the covenant rejects an amount one grain off, so the bot uses the exact arithmetic the venue's page
 * uses. The transaction is the command list of PandaPools' PoolMgr.buildRouted (poolmgr.js, 0.6.42): every routed pool's
 * two reserve coins in, the same pools recreated at the quoted reserves, the proceeds and change to this wallet.
 *
 * Added here, beyond PandaPools:
 *   - Only the commands in WRITE_COMMANDS reach the node, never `send`, never a shared node (9105, 9205, 9305 ...).
 *   - Before signing, every output is checked to go to a routed pool at its quoted amount or to this wallet, and each
 *     asset's inputs to cover its outputs exactly (a dust remainder at most).
 *   - `beforePost` must durably record the trade before txnpost (handshake rule 8). A post with no clear answer is
 *     reported as `unknown`, never as refused (rule 7).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pandapools');
const FILES = ['decimal.js', 'covenant.js', 'curve.js', 'router.js'];
export const MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
const SENTINEL = '0x50414E4441504F4F4C53';
const SHARED_RPC_PORTS = new Set([9005, 9105, 9205, 9305, 9405, 10005]);
export const WRITE_COMMANDS = new Set(['block', 'status', 'balance', 'coins', 'scripts', 'newscript', 'runscript', 'getaddress',
  'txncreate', 'txninput', 'txnoutput', 'txnsign', 'txnbasics', 'txncheck', 'txnpost', 'txndelete']);
const HASH = /^0x[0-9a-fA-F]{64}$/, DECS = /^\d+(\.\d+)?$/;
const MAX_POOL_COINS = 512, MAX_FUND_COINS = 20, DUST = '0.000000001';
const lc = (v) => String(v ?? '').toLowerCase();

let engine = null;
export function loadEngine() {
  if (engine) return engine;
  const sums = {};
  for (const line of fs.readFileSync(path.join(VENDOR, 'SHA256SUMS'), 'utf8').split('\n')) {
    const [h, f] = line.trim().split(/\s+/);
    if (h && f) sums[f.replace(/^\*/, '')] = h;
  }
  const ctx = vm.createContext({});
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(VENDOR, f));
    if (crypto.createHash('sha256').update(src).digest('hex') !== sums[f]) throw new Error(`vendor/pandapools/${f} differs from SHA256SUMS: refusing to price with it`);
    vm.runInContext(src.toString('utf8'), ctx, { filename: f });
  }
  if (!ctx.Decimal || !ctx.Covenant || !ctx.Curve || !ctx.Router || !ctx.PP) throw new Error('the PandaPools engine did not load');
  engine = { D: ctx.Decimal, Covenant: ctx.Covenant, Curve: ctx.Curve, Router: ctx.Router, PP: ctx.PP };
  return engine;
}

export function isShared(rpc) {
  try {
    const u = new URL(rpc);
    return SHARED_RPC_PORTS.has(Number(u.port));   // on any host name or address: 127.0.0.2 or this machine's LAN IP reach the same nodes
  } catch { return true; }
}

/* One node, the bot's own. A reply with status:false is a refusal (e.refused). No reply, or a broken one, means the node
 * may have run the command (e.mayHaveRun), except a connection that was never opened. */
export function makeCall(rpc) {
  if (isShared(rpc)) throw new Error('refused: that node is shared with other projects; the bot writes only through its own');
  return function call(cmd, timeout = 60000) {
    const verb = cmd.split(' ')[0];
    if (!WRITE_COMMANDS.has(verb) || cmd.includes(';')) return Promise.reject(Object.assign(new Error(`refused here: ${verb}`), { refused: true, local: true }));
    return new Promise((resolve, reject) => {
      const body = Buffer.from(cmd, 'utf8');
      let opened = false;
      const req = http.request(rpc, { method: 'POST', agent: false, insecureHTTPParser: true, timeout, headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('error', (e) => reject(Object.assign(new Error(`${verb}: the reply broke off (${e.message})`), { mayHaveRun: true })));
        res.on('aborted', () => reject(Object.assign(new Error(`${verb}: the reply broke off`), { mayHaveRun: true })));
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          let j;
          try { j = JSON.parse(text); } catch { return reject(Object.assign(new Error(`${verb}: the reply was not readable`), { mayHaveRun: true })); }
          if (j.pending) return reject(Object.assign(new Error(`${verb}: the node queued it for approval`), { mayHaveRun: true, pending: true }));
          if (!j.status) return reject(Object.assign(new Error(`${verb}: ${j.error || 'refused'}`), { refused: true }));
          resolve(j.response);
        });
      });
      req.on('socket', (s) => s.on('connect', () => { opened = true; }));
      req.on('timeout', () => req.destroy(Object.assign(new Error(`${verb}: no answer in ${timeout / 1000} s`), { timedOut: true })));
      req.on('error', (e) => reject(Object.assign(new Error(e.message), { mayHaveRun: opened || !!e.timedOut })));
      req.end(body);
    });
  };
}

function stateOf(coin, port) {
  const st = coin?.state;
  if (Array.isArray(st)) { const e = st.find((x) => String(x?.port) === String(port)); return e && e.data !== '' ? String(e.data) : null; }
  if (st && typeof st === 'object') { const v = st[String(port)]; return v === undefined || v === null || v === '' ? null : String(v); }
  return null;
}
const integer = (v, max) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max;

// PandaPools ReserveRecovery.coinFor / fill / complete (reserve-recovery.js, MIT): the largest plain coin per leg.
function coinFor(E, p, c) {
  if (!c || c.spent !== false || !HASH.test(c.coinid) || lc(c.address) !== lc(p.address) || !(lc(c.tokenid) === '0x00' || lc(c.tokenid) === lc(p.tok))) return false;
  if (!c.state || typeof c.state !== 'object' || Object.keys(c.state).length) return false;
  const amount = lc(c.tokenid) === '0x00' ? c.amount : c.tokenamount;
  if (typeof amount !== 'string' || !DECS.test(amount) || amount.length > 160) return false;
  try { return new E.D(amount).gt(0); } catch { return false; }
}
function fill(E, p, coins) {
  if (!Array.isArray(coins) || coins.length > MAX_POOL_COINS) return false;
  for (const c of coins) {
    if (!coinFor(E, p, c)) continue;
    const m = lc(c.tokenid) === '0x00', amount = new E.D(m ? c.amount : c.tokenamount), leg = m ? 'M' : 'T';
    if (p[`reserve${leg}`] === null || amount.gt(p[`reserve${leg}`])) {
      p[`reserve${leg}`] = amount; p[`coinid${leg}`] = c.coinid;
      if (!m && c.token && integer(c.token.decimals, 44)) p.tokDecimals = Number(c.token.decimals);
    }
  }
  return true;
}
function complete(E, p) {
  try { return E.Curve.funded(p) && new E.D(p.kmin).gt(0) && p.reserveM.times(p.reserveT).gte(p.kmin); } catch { return false; }
}

/* Every funded pool of `tok`, discovered from the registry beacons, each address re-derived from its parameters
 * (PandaPools Book.scan, the registry source). */
export async function readPools(call, tok = MXUSD) {
  const E = loadEngine();
  const beacons = await call(`coins simplestate:true order:desc depth:1500 address:${SENTINEL}`);
  const params = new Map();
  for (const c of Array.isArray(beacons) ? beacons : []) {
    const [t, oadr, opk, kmin] = [2, 3, 4, 5].map((port) => stateOf(c, port));
    if (!t || lc(t) !== lc(tok) || !HASH.test(oadr) || !HASH.test(opk) || !kmin || !DECS.test(kmin)) continue;
    try { if (!new E.D(kmin).gt(0) || !new E.D(kmin).lt(E.Covenant.MININUMBER_MAX)) continue; } catch { continue; }
    const key = `${opk}|${t}|${kmin}`;
    if (!params.has(key)) params.set(key, { opk, oadr, tok: t, kmin });
  }
  const pools = [];
  for (const p of params.values()) {
    const script = E.Covenant.script(p.opk, p.oadr, p.tok, p.kmin);
    const r = await call(`runscript script:${E.Covenant.scriptArg(script)}`).catch(() => null);
    if (!r || !E.PP.truthy(r.parseok) || !r.script?.address) continue;
    const pool = { ...p, address: r.script.address, covenantScript: script, tokDecimals: 8, reserveM: null, reserveT: null, coinidM: '', coinidT: '' };
    const coins = await call(`coins address:${pool.address}`).catch(() => null);
    if (fill(E, pool, coins) && complete(E, pool)) pools.push(pool);
  }
  return pools;
}

/* PandaPools' own router over these pools. sellMinima: pay `amountIn` MINIMA for MxUSD; otherwise pay `amountIn` MxUSD
 * for MINIMA. Amounts are decimal strings; the plan's are exact. */
export function quote(pools, sellMinima, amountIn) {
  const E = loadEngine();
  if (!DECS.test(String(amountIn))) return null;
  const r = E.Router.route(pools, !!sellMinima, String(amountIn));
  if (!r.ok) return null;
  const minima = sellMinima ? r.totalIn : r.totalOut, mxusd = sellMinima ? r.totalOut : r.totalIn;
  return {
    sellMinima: !!sellMinima, totalIn: r.totalIn.toString(), totalOut: r.totalOut.toString(),
    minima: minima.toString(), mxusd: mxusd.toString(), price: mxusd.div(minima).toString(),
    pairAddresses: r.pairAddresses.slice(), capped: r.capped,
    allocs: r.allocs.map((a) => ({ pool: a.pool, newX: a.quote.newX.toString(), newY: a.quote.newY.toString(), inAmount: a.quote.inAmount.toString(), outAmount: a.quote.outAmount.toString() })),
  };
}

/* Build, check, sign and post one swap. hooks.beforePost(record) must have saved the record durably before it resolves;
 * hooks.held: coin ids this wallet must not spend (another trade of ours may still hold them).
 * Answers { ok, txpowid, proceedsCoin, inputs } | { ok:false, refused:true, why } (nothing was posted)
 *         | { ok:false, unknown:true, why } (it may have been posted). */
export async function swap(call, plan, hooks = {}) {
  const E = loadEngine(), D = E.D, PP = E.PP;
  if (!plan?.allocs?.length) return { ok: false, refused: true, why: 'no route' };
  const tok = plan.allocs[0].pool.tok, fundTok = plan.sellMinima ? '0x00' : tok, outTok = plan.sellMinima ? tok : '0x00';

  // The pools must be exactly as previewed: the covenant pins the new reserves, so a moved pool fails anyway.
  for (const a of plan.allocs) for (const id of [a.pool.coinidM, a.pool.coinidT]) {
    const rows = await call(`coins coinid:${id}`).catch(() => null);
    const c = Array.isArray(rows) ? rows[0] : null;
    if (!c || c.spent !== false) return { ok: false, refused: true, why: 'the pool moved since the preview; preview again' };
  }
  // The covenant known to the node, without making the pool's coins this wallet's (PandaPools ensureTrackedForSwap).
  for (const a of plan.allocs) {
    const j = await call(`scripts address:${a.pool.address}`).then((r) => ({ r }), (e) => ({ e }));
    if (j.r) continue;
    if (j.e?.refused && /not found/i.test(j.e.message)) await call(`newscript trackall:false script:${E.Covenant.scriptArg(a.pool.covenantScript)}`).catch(() => null);
  }

  const exclude = new Set([...plan.pairAddresses, ...plan.allocs.flatMap((a) => [a.pool.address, a.pool.oadr])].map(lc));
  const held = hooks.held ?? new Set();
  const amountOf = (c) => new D(fundTok === '0x00' ? c.amount : c.tokenamount);
  // Nothing is built yet: a node that does not answer here means nothing was sent.
  let wallet;
  try { wallet = await call(`coins relevant:true sendable:true tokenid:${fundTok}`); } catch (e) { return { ok: false, refused: true, why: `the wallet could not be read: ${e.message}` }; }
  const avail = (Array.isArray(wallet) ? wallet : []).filter((c) => c && HASH.test(c.coinid) && c.spent === false && lc(c.tokenid) === lc(fundTok) &&
    !exclude.has(lc(c.address)) && !held.has(lc(c.coinid)) && DECS.test(String(fundTok === '0x00' ? c.amount : c.tokenamount)));
  avail.sort((a, b) => amountOf(b).cmp(amountOf(a)));
  const need = new D(plan.totalIn), funds = [];
  let sum = new D(0);
  for (const c of avail) { if (sum.gte(need) || funds.length >= MAX_FUND_COINS) break; funds.push(c); sum = sum.plus(amountOf(c)); }
  if (sum.lt(need)) return { ok: false, refused: true, why: `the bot wallet has not enough sendable ${plan.sellMinima ? 'MINIMA' : 'MxUSD'} for this swap` };

  let me;
  try { me = await call('getaddress'); } catch (e) { return { ok: false, refused: true, why: `the node gave no payout address: ${e.message}` }; }
  const taddr = me?.address;
  if (!HASH.test(String(taddr))) return { ok: false, refused: true, why: 'the node gave no payout address' };

  // PandaPools buildRouted, command for command.
  const txid = `tb_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, tokArg = ` tokenid:${tok}`;
  const cmds = [`txncreate id:${txid}`];
  for (const a of plan.allocs) { cmds.push(`txninput id:${txid} coinid:${a.pool.coinidM}`); cmds.push(`txninput id:${txid} coinid:${a.pool.coinidT}`); }
  for (const f of funds) cmds.push(`txninput id:${txid} coinid:${f.coinid}`);
  for (const a of plan.allocs) {
    cmds.push(`txnoutput id:${txid} amount:${PP.amt(a.newX)} address:${a.pool.address} storestate:false`);
    cmds.push(`txnoutput id:${txid} amount:${PP.amt(a.newY)} address:${a.pool.address}${tokArg} storestate:false`);
  }
  const change = sum.minus(plan.totalIn);
  if (plan.sellMinima) {
    cmds.push(`txnoutput id:${txid} amount:${PP.amt(plan.totalOut)} address:${taddr}${tokArg} storestate:false`);
    if (change.gt(DUST)) cmds.push(`txnoutput id:${txid} amount:${PP.amt(change)} address:${taddr} storestate:false`);
  } else {
    cmds.push(`txnoutput id:${txid} amount:${PP.amt(plan.totalOut)} address:${taddr} storestate:false`);
    if (change.gt(0)) cmds.push(`txnoutput id:${txid} amount:${PP.amt(change)} address:${taddr}${tokArg} storestate:false`);
  }

  // Our own check of what we are about to sign: where each output goes, and that each asset balances.
  const why = checkBalance(E, plan, funds, fundTok, cmds, taddr);
  if (why) return { ok: false, refused: true, why: `not signed: ${why}` };

  const del = () => call(`txndelete id:${txid}`).catch(() => null);
  const inputs = [...plan.allocs.flatMap((a) => [a.pool.coinidM, a.pool.coinidT]), ...funds.map((f) => f.coinid)];
  try {
    for (const c of cmds) await call(c);
    await call(`txnsign id:${txid} publickey:auto`, 120000);   // a one-time-key signature: slow on a busy machine
    await call(`txnbasics id:${txid}`, 120000);
    const chk = await call(`txncheck id:${txid}`);
    const scriptsOk = PP.truthy(chk?.valid?.scripts), amountsOk = PP.truthy(chk?.validamounts), mmrOk = PP.truthy(chk?.valid?.mmrproofs);
    if (!scriptsOk || !amountsOk || !mmrOk) {
      await del();
      return { ok: false, refused: true, why: !mmrOk ? 'a pool coin was already spent (the pool moved); nothing was posted' : !scriptsOk ? 'the pool covenant rejects this transaction; nothing was posted' : 'the amounts do not balance; nothing was posted' };
    }
  } catch (e) {
    await del();
    // Nothing before txnpost broadcasts, so any failure here, answered or not, leaves nothing on chain.
    return { ok: false, refused: true, why: `building the transaction failed: ${e.message}` };
  }

  try { await hooks.beforePost?.({ txid, inputs, taddr }); } catch (e) { await del(); return { ok: false, refused: true, why: `not posted: the trade could not be recorded first (${e.message})` }; }

  let post;   // mine:true: it answers with the mined txpowid, the one that goes on chain (without it the id is the unmined one)
  try { post = await call(`txnpost id:${txid} mine:true`, 180000); } catch (e) {
    await del();
    if (e.local) return { ok: false, refused: true, why: `not posted: ${e.message}`, inputs };
    // Even a status:false answer from txnpost is not taken as proof that nothing was broadcast (rule 7).
    return { ok: false, unknown: true, why: `the post had no clear success (${e.message}); it may be on chain`, inputs };
  }
  await del();
  const tx = post?.txpow ?? post;
  const txpowid = post?.txpowid ?? tx?.txpowid ?? null;
  const outs = tx?.body?.txn?.outputs ?? [];
  const proceeds = outs.find((o) => lc(o.address) === lc(taddr) && lc(o.tokenid) === lc(outTok));
  return { ok: true, txpowid, proceedsCoin: proceeds?.coinid ?? null, inputs, taddr };
}

function checkBalance(E, plan, funds, fundTok, cmds, taddr) {
  const D = E.D, poolAt = new Map(plan.allocs.map((a) => [lc(a.pool.address), a]));
  const tok = plan.allocs[0].pool.tok;
  const tin = { '0x00': new D(0), [lc(tok)]: new D(0) }, tout = { '0x00': new D(0), [lc(tok)]: new D(0) };
  for (const a of plan.allocs) { tin['0x00'] = tin['0x00'].plus(a.pool.reserveM); tin[lc(tok)] = tin[lc(tok)].plus(a.pool.reserveT); }
  for (const f of funds) tin[lc(fundTok)] = tin[lc(fundTok)].plus(fundTok === '0x00' ? f.amount : f.tokenamount);
  const seen = new Map();
  for (const c of cmds) {
    if (!c.startsWith('txnoutput ')) continue;
    const amount = /amount:(\S+)/.exec(c)[1], address = /address:(\S+)/.exec(c)[1], t = lc(/tokenid:(\S+)/.exec(c)?.[1] ?? '0x00');
    if (!DECS.test(amount)) return `an output amount is not plain: ${amount}`;
    if (!(t in tout)) return 'an output names another token';
    const a = poolAt.get(lc(address));
    if (a) {
      const want = t === '0x00' ? a.newX : a.newY;
      if (!new D(amount).eq(want)) return 'a pool output differs from the quote';
      const k = `${lc(address)}|${t}`;
      if (seen.has(k)) return 'a pool output appears twice';
      seen.set(k, true);
    } else if (lc(address) !== lc(taddr)) return `an output goes to an address that is neither a routed pool nor this wallet: ${address}`;
    tout[t] = tout[t].plus(amount);
  }
  if (seen.size !== plan.allocs.length * 2) return 'a routed pool is not recreated';
  for (const t of Object.keys(tin)) {
    const left = tin[t].minus(tout[t]);
    if (left.lt(0)) return 'the outputs exceed the inputs';
    if (left.gt(DUST)) return `${left.toString()} of ${t === '0x00' ? 'MINIMA' : 'the token'} would be left as a fee`;
  }
  return null;
}

/* Where a posted swap stands, from the chain: the proceeds coin exists (with its confirmations), or a routed reserve
 * coin is gone without it (someone else moved the pool first: this swap can never be mined), or still waiting. */
export async function watch(call, posted, plan) {
  const tip = Number((await call('block')).block);
  // A read that fails says nothing: it throws, and the caller simply watches again.
  const mine = async () => {
    if (!posted.proceedsCoin) return null;
    const rows = await call(`coins coinid:${posted.proceedsCoin}`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  };
  let c = await mine();
  if (c) return { state: 'mined', confirmations: tip - Number(c.created) + 1, tip };
  /* "Lost" needs positive evidence: the pool is seen with new reserve coins and our proceeds are not there. An empty read
   * proves nothing (a coin past the node's search depth, or a resync, also reads as empty). */
  for (const a of plan.allocs) for (const id of [a.pool.coinidM, a.pool.coinidT]) {
    const rows = await call(`coins coinid:${id}`);
    if (Array.isArray(rows) && rows[0] && rows[0].spent === false) continue;
    c = await mine();   // a block may have landed between the reads
    if (c) return { state: 'mined', confirmations: tip - Number(c.created) + 1, tip };
    if (!posted.proceedsCoin) return { state: 'unclear', tip };
    const now = await call(`coins address:${a.pool.address}`);
    const old = new Set([a.pool.coinidM, a.pool.coinidT].map(lc));
    const fresh = (Array.isArray(now) ? now : []).filter((x) => x && x.spent === false && !old.has(lc(x.coinid)) && Object.keys(x.state ?? {}).length === 0);
    const hasM = fresh.some((x) => lc(x.tokenid) === '0x00'), hasT = fresh.some((x) => lc(x.tokenid) === lc(a.pool.tok));
    if (hasM && hasT && !(await mine())) return { state: 'lost', tip };
    return { state: 'waiting', tip };
  }
  return { state: 'waiting', tip };
}
