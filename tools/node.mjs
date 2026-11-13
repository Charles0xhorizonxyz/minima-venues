/* The bot's own Minima node: start it, stop it cleanly, watch it, add a peer.
 *
 * It can never reach a shared node: the ports of nodes kept for other uses (SHARED_RPC_PORTS) are refused, and Stop works only on a
 * node this tool started. It stops with `quit` and never kills a process, because a killed node can damage its database.
 * Only the commands in NODE_COMMANDS exist here: nothing that spends, signs, or reads a seed.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const NODES = path.join(os.homedir(), 'Minima');   // defaults only: each field is set in Connections
export const NODE_DEFAULTS = {
  javaPath: 'java',
  jarPath: path.join(NODES, 'minima.jar'),
  dataDir: path.join(NODES, 'TradingBot', 'data'),
  basePort: 9501, memoryMb: 1024, peers: '', watchRpc: '', useForScan: false, autoStart: false,
};
const NODE_COMMANDS = new Set(['block', 'status', 'balance', 'keys', 'connect', 'quit', 'megammrsync', 'maxima', 'maxcontacts', 'webhooks']);
// Maxima, for Parlons: only these exact shapes. Nothing here spends, signs or reads a seed; the webhook can only point
// at this dashboard on this computer, and messages only go to a contact's public key as MaxSolo chat.
const MAXIMA_CMDS = [
  /^maxima action:info$/,
  /^maxima action:setname name:[A-Za-z0-9_-]{1,32}$/,
  /^maxima action:send publickey:0x[0-9A-F]{40,1200} application:maxsolo data:0x[0-9A-F]{2,8000} poll:true$/,
  /^maxcontacts action:list$/,
  /^maxcontacts action:add contact:Mx[0-9A-Z]{20,700}@[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/,
  /^webhooks$/,
  /^webhooks action:add hook:http:\/\/127\.0\.0\.1:[0-9]{2,5}\/api\/hook\/[0-9a-f]{48} filter:MAXIMA$/,
  /^webhooks action:remove hook:MAXIMA#http:\/\/127\.0\.0\.1:[0-9]{2,5}\/api\/hook\/[0-9a-f]{48}$/,
];
// A chain resync from a MegaMMR node: the wallet and its keys stay as they are. Only this exact shape is ever sent, so a
// seed phrase, a backup file or a password can never travel through here.
const RESYNC_CMD = /^megammrsync action:resync host:[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;
export const MEGAMMR_HOSTS = [
  { host: 'megammr.minima.global:9001', name: 'Minima (official)' },
  { host: 'spartacusrex.com:9001', name: 'Spartacus' },
  { host: 'eurobuddha.com:9001', name: 'Eurobuddha' },
];
const SHARED_RPC_PORTS = new Set([9005, 9105, 9205, 9305, 9405, 10005]);
const MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
const PEER = /^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;
const START_GRACE = 240000, HEALTHY_TIP_AGE = 600;

const isShared = (rpc) => {
  try {
    const u = new URL(rpc);
    return SHARED_RPC_PORTS.has(Number(u.port));   // on any host: the LAN IP reaches the same nodes
  } catch { return true; }
};

function call(rpc, cmd, timeout = 12000) {
  const verb = cmd.split(' ')[0];
  if (!NODE_COMMANDS.has(verb) || cmd.includes(';')) return Promise.reject(new Error(`refused: ${verb}`));
  if (verb === 'megammrsync' && !RESYNC_CMD.test(cmd)) return Promise.reject(new Error('refused: only a chain resync from a host'));
  if (['maxima', 'maxcontacts', 'webhooks'].includes(verb) && !MAXIMA_CMDS.some((re) => re.test(cmd))) return Promise.reject(new Error(`refused: that ${verb} command`));
  if (isShared(rpc)) return Promise.reject(new Error('refused: that node is shared with other projects'));
  return new Promise((resolve, reject) => {
    const body = Buffer.from(cmd, 'utf8');
    const req = http.request(rpc, { method: 'POST', agent: false, insecureHTTPParser: true, timeout, headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        try { const j = JSON.parse(text); j.status ? resolve(j.response) : reject(new Error(j.error || `${verb} failed`)); } catch { reject(new Error(`${verb}: reply was not JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${verb}: timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

function validate(input, old) {
  const c = { ...old };
  for (const k of ['javaPath', 'jarPath', 'dataDir']) {
    const v = String(input?.[k] ?? '').trim();
    if (!v || v.length > 400 || /["\r\n]/.test(v)) return { error: 'Enter a full folder or file path.', field: k };
    c[k] = v;
  }
  const port = Number(input?.basePort), mem = Number(input?.memoryMb);
  if (!Number.isInteger(port) || port < 1024 || port > 65000) return { error: 'Port must be a whole number from 1024 to 65000.', field: 'basePort' };
  if (SHARED_RPC_PORTS.has(port + 4)) return { error: 'That port belongs to a node shared with other projects. Pick another.', field: 'basePort' };
  if (!Number.isInteger(mem) || mem < 512 || mem > 8192) return { error: 'Memory must be from 512 to 8192 MB.', field: 'memoryMb' };
  const peers = String(input?.peers ?? '').trim();
  if (peers && !peers.split(',').every((p) => PEER.test(p.trim()))) return { error: 'Peers are host:port, separated by commas.', field: 'peers' };
  const watch = String(input?.watchRpc ?? '').trim();
  if (watch && (!/^https?:\/\/[^\s/]+\/?$/.test(watch) || isShared(watch))) return { error: 'Enter a node address like http://203.0.113.5:9505, and not one of the shared nodes.', field: 'watchRpc' };
  Object.assign(c, { basePort: port, memoryMb: mem, peers: peers.split(',').map((p) => p.trim()).filter(Boolean).join(','), watchRpc: watch.replace(/\/$/, ''), useForScan: !!input?.useForScan, autoStart: !!input?.autoStart });
  return { config: c };
}

export function createNode(file) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  let config = { ...NODE_DEFAULTS, ...saved.config };
  let run = saved.run ?? null;      // { pid, startedAt, rpc, log } of a node started here
  let live = null, lastError = null, stopping = false;

  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ config, run })); };
  const rpc = () => config.watchRpc || `http://127.0.0.1:${config.basePort + 4}`;
  const logFile = () => path.join(path.dirname(config.dataDir), 'node-out.log');
  // Alive and still a node: on Linux a finished process can linger as a zombie, or its number can be reused.
  const pidAlive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    if (process.platform === 'linux') {
      try {
        if (/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('java')) return false;
      } catch { return false; }
    }
    return true;
  };

  async function refresh() {
    const url = rpc();
    try {
      const [status, block] = await Promise.all([call(url, 'status'), call(url, 'block')]);
      const [balance, keys] = await Promise.all([call(url, 'balance').catch(() => null), call(url, 'keys').catch(() => null)]);
      const token = (id) => {
        const b = Array.isArray(balance) ? balance.find((x) => String(x.tokenid).toUpperCase() === id.toUpperCase()) : null;
        return b ? { confirmed: Number(b.confirmed), unconfirmed: Number(b.unconfirmed), sendable: Number(b.sendable) } : { confirmed: 0, unconfirmed: 0, sendable: 0 };
      };
      const rows = Array.isArray(keys) ? keys : keys?.keys;
      live = {
        version: status.version, uptime: status.uptime, locked: !!status.locked, tip: Number(block.block), tipAge: Math.round(Date.now() / 1000 - Number(block.timemilli) / 1000),
        peers: Number(status.network?.connected ?? 0), mempool: Number(status.txpow?.mempool ?? 0), memory: status.memory?.ram?.used ?? status.memory?.ram ?? null,
        minima: token('0x00'), mxusd: token(MXUSD), keyCount: Array.isArray(rows) ? rows.length : null, maxKeyUses: Array.isArray(rows) ? rows.reduce((a, r) => Math.max(a, Number(r.uses) || 0), 0) : null,
      };
      if (lastError && !stopping) lastError = null;
    } catch (e) {
      live = null;
      if (run && !pidAlive(run.pid)) { run = null; stopping = false; save(); }
    }
  }

  function setConfig(input) {
    const v = validate(input, config);
    if (v.error) return v;
    if (run && (v.config.basePort !== config.basePort || v.config.dataDir !== config.dataDir)) return { error: 'Stop the node before changing its port or folder.', field: 'basePort' };
    config = v.config; save(); refresh();
    return { ok: true };
  }

  async function start(input) {
    const s = setConfig(input);
    if (s.error) return s;
    if (config.watchRpc) return { error: 'This is set to watch a node elsewhere. Clear that address to run one here.', field: 'watchRpc' };
    if (run && pidAlive(run.pid)) return { error: 'The node is already running.' };
    try { await call(rpc(), 'status', 3000); return { error: 'Something already answers on that port. Pick another, or stop it.', field: 'basePort' }; } catch { /* free */ }
    if (/[\\/]/.test(config.javaPath) && !fs.existsSync(config.javaPath)) return { error: 'Java was not found at that path.', field: 'javaPath' };
    if (!fs.existsSync(config.jarPath)) return { error: 'minima.jar was not found at that path.', field: 'jarPath' };
    fs.mkdirSync(config.dataDir, { recursive: true });
    const log = logFile(), out = fs.openSync(log, 'a');
    const args = [`-Xmx${config.memoryMb}m`, '-jar', config.jarPath, '-data', config.dataDir, '-port', String(config.basePort), '-rpcenable', 'true'];
    if (config.peers) args.push('-connect', config.peers);
    if (process.env.TRADING_NODE_EXTRA) args.push(...process.env.TRADING_NODE_EXTRA.split(' '));   // for tests on a throwaway chain
    const child = spawn(config.javaPath, args, { cwd: path.dirname(config.dataDir), detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    const failed = await new Promise((resolve) => { child.once('error', (e) => resolve(e)); setTimeout(() => resolve(null), 800); });
    if (failed) return { error: `The node did not start: ${failed.message}` };
    child.unref();
    run = { pid: child.pid, startedAt: Date.now(), rpc: rpc(), log };
    lastError = null; stopping = false; save();
    return { ok: true };
  }

  async function stop() {
    if (!run) return { error: 'Only a node started from here can be stopped from here.' };
    if (!pidAlive(run.pid)) { run = null; save(); return { error: 'The node had already stopped.' }; }
    stopping = true;
    try { await call(run.rpc, 'quit', 15000); }
    catch (e) { if (!/socket hang up|ECONNRESET|timed out/.test(e.message)) { stopping = false; return { error: `The node did not accept the stop: ${e.message}` }; } }
    return { ok: true };
  }

  async function addPeer(body) {
    const peer = String(body?.peer ?? '').trim();
    if (!PEER.test(peer)) return { error: 'A peer is host:port, for example megammr.minima.global:9001.', field: 'peer' };
    try { await call(rpc(), `connect host:${peer}`); } catch (e) { return { error: `The node refused: ${e.message}` }; }
    return { ok: true };
  }

  /* Put the node back on the chain tip from a MegaMMR node. It can take several minutes and the node restarts its chain
   * database, so it runs in the background and the page follows it through view().resync. */
  let resyncing = null;     // { host, startedAt, state: 'running' | 'done' | 'failed', note }
  async function resync(body) {
    const host = String(body?.host ?? '').trim();
    if (!PEER.test(host)) return { error: 'A MegaMMR node is host:port, for example megammr.minima.global:9001.', field: 'mmrHost' };
    if (!live) return { error: 'The node is not answering. Start it first.' };
    if (resyncing?.state === 'running') return { error: 'A resync is already running.' };
    resyncing = { host, startedAt: Date.now(), state: 'running', note: null };
    call(rpc(), `megammrsync action:resync host:${host}`, 20 * 60000)
      .then((r) => { resyncing = { ...resyncing, state: 'done', note: typeof r === 'string' ? r : (r?.message ?? 'Resynced.') }; })
      .catch((e) => {
        // The node may drop the connection while it rebuilds: that is not a failure. The block tile tells.
        const dropped = /socket hang up|ECONNRESET|timed out/.test(e.message);
        resyncing = { ...resyncing, state: dropped ? 'done' : 'failed', note: dropped ? 'The node closed the call while it rebuilt. Watch the block tile.' : e.message };
      });
    return { ok: true };
  }

  function tailLog() {
    try {
      const f = run?.log || logFile(), size = fs.statSync(f).size, fd = fs.openSync(f, 'r'), n = Math.min(size, 6000), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, size - n); fs.closeSync(fd);
      return b.toString('utf8').split('\n').slice(-25).join('\n');
    } catch { return ''; }
  }

  function phase() {
    const alive = run && pidAlive(run.pid);
    if (stopping && alive) return 'stopping';
    if (live) return 'running';
    if (alive) return Date.now() - run.startedAt < START_GRACE ? 'starting' : 'not-answering';
    return config.watchRpc ? 'not-answering' : 'stopped';
  }

  return {
    refresh, setConfig, start, stop, addPeer, resync,
    // Maxima for Parlons, through the same allow-list; only on a node running on this computer (the webhook calls back here).
    maxima: (cmd, timeout) => (/^http:\/\/127\.0\.0\.1:/.test(rpc()) ? call(rpc(), cmd, timeout) : Promise.reject(new Error('Parlons needs the bot node on this computer'))),
    view: () => ({ config, rpc: rpc(), phase: phase(), watching: !!config.watchRpc, startedHere: !!run, live, error: lastError, log: tailLog(), resync: resyncing, megammr: MEGAMMR_HOSTS }),
    // The node the venue scan should read: this one once it is healthy, otherwise null (the default read node).
    scanTarget: () => (config.useForScan && live && live.tipAge < HEALTHY_TIP_AGE ? rpc() : null),
    rpc,
  };
}
