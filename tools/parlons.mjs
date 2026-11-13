/* Parlons: chat with the dashboard from your phone, over Maxima, through its own node.
 *
 * Parlons speaks MaxSolo's classic chat wire (application "maxsolo", a UTF-8 JSON {username, type, message, filedata}
 * sent as hex), which every stock Minima node understands. So the node sends to your Parlons contact with
 * `maxima action:send`, and the node hands each message it receives to this server through a webhook whose path holds
 * a 48-hex-digit secret.
 *
 * Only messages signed by the paired Parlons key are read; everything else is ignored. Commands: help, status, price,
 * stop (disarms the desk and stops the paper maker, at once), go (arms the desk inside its envelope, only after you
 * send back a one-time code), alert above/below, alerts, alert clear. Alerts go out when something needs a person.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ADDRESS = /^Mx[0-9A-Z]{20,700}@[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;
const PRICE = /^\d{1,3}(\.\d{1,8})?$/;
const BOT_NAME = 'MinimaVenues';
const HOUR = 3600e3, MAX_PER_HOUR = 30, CODE_SECONDS = 120;
export const ALERT_KINDS = {
  desk: 'The desk: trades it sends by itself, blocks, a disarm it did not get from you',
  scan: 'Scans failing for 5 minutes',
  node: 'The node more than 3 minutes behind',
  exchange: 'MEXC or XT not answering for 5 minutes',
  restart: 'The dashboard restarted',
};
const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const unhex = (h) => Buffer.from(String(h).replace(/^0x/i, ''), 'hex').toString('utf8');
const norm = (k) => String(k || '').toUpperCase().replace(/^0X/, '0x');

export function createParlons({ file, call, port, actions }) {
  let st = { token: crypto.randomBytes(24).toString('hex'), owner: null, alerts: Object.fromEntries(Object.keys(ALERT_KINDS).map((k) => [k, true])), price: [], log: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(file + '.tmp', file); };
  save();
  const hookUrl = () => `http://127.0.0.1:${port}/api/hook/${st.token}`;
  let hookOk = false, botAddress = null, lastError = null, sentTimes = [], pendingCode = null;
  const note = (dir, text) => { st.log.unshift({ at: Date.now(), dir, text: String(text).slice(0, 400) }); st.log = st.log.slice(0, 40); save(); };

  // The webhook is kept registered on the node while a Parlons contact is paired.
  async function ensureHook() {
    if (!st.owner) return;
    try {
      const info = await call('maxima action:info');
      botAddress = info.contact || botAddress;
      if (info.name !== BOT_NAME) await call(`maxima action:setname name:${BOT_NAME}`).catch(() => {});
      const list = (await call('webhooks')).webhooks || [];
      if (!list.includes(`MAXIMA#${hookUrl()}`)) await call(`webhooks action:add hook:${hookUrl()} filter:MAXIMA`);
      hookOk = true; lastError = null;
    } catch (e) { hookOk = false; lastError = `The node: ${e.message}`; }
  }

  async function send(text, { force = false } = {}) {
    if (!st.owner) return { error: 'Pair your Parlons first.' };
    const now = Date.now();
    sentTimes = sentTimes.filter((t) => now - t < HOUR);
    if (!force && sentTimes.length >= MAX_PER_HOUR) { lastError = `More than ${MAX_PER_HOUR} messages this hour: alerts held back.`; return { error: lastError }; }
    const body = hex(JSON.stringify({ username: BOT_NAME, type: 'text', message: String(text).slice(0, 1500), filedata: '' }));
    try {
      await call(`maxima action:send publickey:${st.owner.key} application:maxsolo data:${body} poll:true`, 30000);
      sentTimes.push(now); note('out', text); return { ok: true };
    } catch (e) { lastError = `Sending: ${e.message}`; return { error: lastError }; }
  }

  async function pair(body) {
    const address = String(body?.address ?? '').trim();
    if (!ADDRESS.test(address)) return { error: 'Paste your Parlons address: it starts with Mx and ends with @ and a host:port.', field: 'pAddress' };
    try {
      await call(`maxcontacts action:add contact:${address}`, 30000);
      const raw = await call('maxcontacts action:list');
      const list = Array.isArray(raw) ? raw : raw?.contacts || [];
      const key = address.split('@')[0];
      const c = list.find((x) => x.currentaddress === address || String(x.currentaddress || '').startsWith(key + '@') || x.mxpublickey === key)
        || list.reduce((a, x) => (!a || Number(x.id) > Number(a.id) ? x : a), null);
      if (!c?.publickey) return { error: 'The node did not list the new contact. Is Maxima running on it?' };
      st.owner = { address, key: norm(c.publickey), name: c.extradata?.name || c.name || 'Parlons', id: c.id, at: Date.now() };
      save();
      await ensureHook();
      await send('Minima Venues is paired with this chat. Send "help" for the commands.', { force: true });
      return { ok: true };
    } catch (e) { return { error: `The node refused: ${e.message}` }; }
  }

  async function unpair() {
    if (st.owner) await call(`webhooks action:remove hook:MAXIMA#${hookUrl()}`).catch(() => {});
    st.owner = null; hookOk = false; pendingCode = null; save();
    return { ok: true };
  }

  function setAlerts(body) {
    for (const k of Object.keys(ALERT_KINDS)) if (typeof body?.alerts?.[k] === 'boolean') st.alerts[k] = body.alerts[k];
    save(); return { ok: true };
  }
  // above / below: a level. up / down / move: a change over 24 hours, in % (move: either way).
  function addPrice(dir, price) {
    if (!['above', 'below', 'up', 'down', 'move'].includes(dir)) return { error: 'An alert is above or below a price, or a 24-hour move up, down or either way.', field: 'pDir' };
    const pct = ['up', 'down', 'move'].includes(dir);
    if (pct && !(/^\d{1,2}(\.\d{1,2})?$/.test(String(price)) && Number(price) > 0)) return { error: 'A move like 5 (in %).', field: 'pPct' };
    if (!pct && (!PRICE.test(String(price)) || !(Number(price) > 0))) return { error: 'A price like 0.0032.', field: 'pLevels' };
    if (st.price.length >= 20) return { error: 'At most 20 price alerts.' };
    const a = { id: crypto.randomBytes(4).toString('hex'), dir, price: String(price), at: Date.now() };
    st.price.push(a); save(); return { ok: true, alert: a };
  }
  function removePrice(id) { st.price = st.price.filter((a) => a.id !== id); save(); return { ok: true }; }

  // ---- incoming: only the paired key, only MaxSolo text
  async function onEvent(ev) {
    if (ev?.event !== 'MAXIMA' || !st.owner) return;
    const d = ev.data || {};
    if (d.application !== 'maxsolo' || norm(d.from) !== st.owner.key) return;
    let text = '';
    try { const j = JSON.parse(unhex(d.data)); if (j.type && j.type !== 'text') return; text = String(j.message || '').trim(); } catch { return; }
    if (!text) return;
    const unlock = /^unlock\s+(.+)$/is.exec(text);
    note('in', unlock ? 'unlock (passphrase not kept)' : text);
    if (unlock && actions.unlock) { await send(await actions.unlock(unlock[1].trim()), { force: true }); return; }
    await send(await command(text), { force: true });
  }

  async function command(raw) {
    const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (t === 'help' || t === '?') return 'Commands: status, price, unlock <passphrase> (a server key store), stop (automatic trading off, paper maker stopped), go (automatic trading on; asks for a code), alert above 0.0032, alert below 0.0028, alert move 5 (or up 5, down 5: % over 24 hours), alerts, alert clear.';
    if (t === 'status') return actions.status();
    if (t === 'price' || t === 'prices') return actions.price();
    if (t === 'stop') { pendingCode = null; return actions.stop(); }
    if (t === 'go') {
      const why = actions.cannotArm();
      if (why) return `Not armed: ${why}`;
      pendingCode = { code: String(crypto.randomInt(1000, 10000)), until: Date.now() + CODE_SECONDS * 1000 };
      return `To arm the desk inside its envelope, reply "go ${pendingCode.code}" within ${CODE_SECONDS / 60} minutes.`;
    }
    const g = t.match(/^go (\d{4})$/);
    if (g) {
      const ok = pendingCode && pendingCode.code === g[1] && Date.now() < pendingCode.until;
      pendingCode = null;
      if (!ok) return 'That code is wrong or expired. Send "go" for a new one.';
      return actions.arm();
    }
    const a = t.match(/^alert (above|below) (\S+)$/);
    if (a) { const r = addPrice(a[1], a[2]); return r.error ? r.error : `Alert set: MEXC mid ${a[1]} ${a[2]}. It goes off once.`; }
    const mv = t.match(/^alert (up|down|move) (\d{1,2}(?:\.\d{1,2})?)%?$/);
    if (mv) { const r = addPrice(mv[1], mv[2]); return r.error ? r.error : `Alert set: the MEXC mid ${mv[1] === 'move' ? 'moving' : 'going ' + mv[1]} ${mv[2]}% over 24 hours. It goes off once.`; }
    if (t === 'alerts') return st.price.length ? 'Price alerts: ' + st.price.map((x) => (['up', 'down', 'move'].includes(x.dir) ? `${x.dir} ${x.price}% in 24 h` : `${x.dir} ${x.price}`)).join(', ') + '.' : 'No price alert set.';
    if (t === 'alert clear') { st.price = []; save(); return 'All price alerts cleared.'; }
    return 'Not understood. Send "help" for the commands.';
  }

  // ---- outgoing alerts, checked after each scan and every 30 s
  const since = {};          // condition -> when it started
  const told = {};           // condition -> already told
  let journalSeen = null, lastArmed = null, lastBlocks = null, booted = false;
  async function condition(key, on, minutes, text, back) {
    if (on) {
      since[key] ??= Date.now();
      if (!told[key] && Date.now() - since[key] >= minutes * 60e3) { told[key] = true; await send(text); }
    } else {
      if (told[key] && back) await send(back);
      delete since[key]; delete told[key];
    }
  }
  async function watch({ scan, snapshot, desk, node, ownStop, mid24 = null }) {
    if (!st.owner) return;
    if (!booted) {
      booted = true;
      const locked = actions.locked?.();
      if (st.alerts.restart || locked) await send(`The dashboard has started (after a restart or a login). Automatic trading is off.${locked ? ' The key store is LOCKED: exchange keys cannot be read until you unlock it. Send "unlock <passphrase>" here (then delete that message), or unlock it in Connections.' : ''}`);
    }
    if (st.alerts.scan) await condition('scan', scan && !scan.ok && !!scan.error, 5, `! Scans are failing: ${scan?.error}`, 'Scans are back.');
    if (st.alerts.node) {
      const age = node?.live ? node.live.tipAge : null;
      await condition('node', node?.phase === 'running' ? age > 180 : node?.phase === 'not-answering', 0, `! The node is ${age !== null ? `${Math.round(age / 60)} min behind the chain` : 'not answering'}.`, 'The node is back at the chain tip.');
    }
    if (st.alerts.exchange && snapshot) {
      await condition('mexc', !!snapshot.detail?.mexcError, 5, `! MEXC is not answering: ${snapshot.detail?.mexcError}`, 'MEXC answers again.');
      await condition('xt', !!snapshot.staleBooks?.XT, 5, '! XT.com is not answering.', 'XT.com answers again.');
    }
    if (st.alerts.desk && desk) {
      if (lastArmed === true && desk.armed === false && !ownStop()) await send('! The desk disarmed itself. Open the dashboard: Settings, Live desk.');
      lastArmed = desk.armed;
      const n = (desk.blocks || []).length;
      if (lastBlocks !== null && n > lastBlocks) await send(`! The desk is blocked: ${desk.blocks.at(-1)?.reason || desk.blocks.at(-1)?.note || 'look at it in Settings'}.`);
      lastBlocks = n;
      const seen = new Map((desk.journal || []).filter((e) => e.kind !== 'arm' && e.kind !== 'disarm').map((e) => [e.id, e.status]));
      if (journalSeen) {
        for (const [id, status] of seen) {
          if (journalSeen.get(id) === status || ['sending', 'posting', 'posted'].includes(status)) continue;
          const e = desk.journal.find((x) => x.id === id);
          await send(`Desk trade${e.auto ? ' (sent by itself)' : ''}: ${desk.kinds?.[e.kind] || desk.actions?.[e.kind] || e.kind}, ${status}${e.note ? `: ${e.note}` : ''}.`);
        }
      }
      journalSeen = seen;
    }
    const mx = snapshot?.venues?.MEXC, mid = mx?.bid && mx?.ask ? (mx.bid + mx.ask) / 2 : null;
    if (mid) {
      const ch = mid24 > 0 ? (mid / mid24 - 1) * 100 : null;
      for (const a of [...st.price]) {
        const lvl = Number(a.price);
        const hit = a.dir === 'above' ? mid >= lvl : a.dir === 'below' ? mid <= lvl
          : ch === null ? false : a.dir === 'up' ? ch >= lvl : a.dir === 'down' ? ch <= -lvl : Math.abs(ch) >= lvl;
        if (!hit) continue;
        st.price = st.price.filter((x) => x.id !== a.id); save();
        await send(['up', 'down', 'move'].includes(a.dir)
          ? `Price alert: the MEXC mid moved ${ch >= 0 ? '+' : ''}${ch.toFixed(2)}% in 24 hours (${mid24.toFixed(6)} to ${mid.toFixed(6)}). This alert is now off.`
          : `Price alert: the MEXC mid is ${mid.toFixed(6)}, ${a.dir} ${a.price}. This alert is now off.`);
      }
    }
  }

  return {
    pair, unpair, setAlerts, addPrice, removePrice, onEvent, watch, ensureHook,
    test: () => send('Test from Minima Venues: this chat is connected.', { force: true }),
    token: () => st.token,
    view: () => ({ paired: !!st.owner, owner: st.owner && { address: st.owner.address, name: st.owner.name, at: st.owner.at }, hookOk, botAddress, error: lastError, alerts: st.alerts, kinds: ALERT_KINDS, price: st.price, log: st.log }),
  };
}
