/* Pilot a server from this computer: an SSH tunnel to the app running there, and a pass-through for the page.
 *
 * The server's app listens on its own 127.0.0.1:8765 only. This computer opens `ssh -N -L` to it (key only, never a
 * password, the server's host key remembered on first use), and while a server is "active" every /api request of the
 * page goes through the tunnel, with the Host and Origin the server's app expects. The page itself, the pilot's own
 * calls (/api/pilot/...) and the computer's own app keep running here.
 *
 * The SSH key is made once for this computer (ed25519), kept beside the exchange keys, outside the app's folder.
 */
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { secretDir } from './secrets.mjs';

const SSH = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const SCP = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\scp.exe' : 'scp';
const KEYGEN = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe' : 'ssh-keygen';
const HOST = /^[A-Za-z0-9.-]{1,253}$/, USER = /^[a-z_][a-z0-9_.-]{0,31}$/i, NAME = /^[\w .-]{1,40}$/;
const REMOTE_PORT = 8765;

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });

export function createPilot(file) {
  let st = { servers: [], active: null };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(st, null, 1)); };
  const dir = () => path.join(secretDir(), 'ssh'), keyFile = () => path.join(dir(), 'id_ed25519');
  // the tunnel: one at a time
  let tun = null;   // { id, child, port, state: 'connecting'|'connected'|'lost', error, since, log }

  async function publicKey() {
    if (!fs.existsSync(keyFile())) {
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      await new Promise((resolve, reject) => execFile(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'minima-venues-pilot', '-f', keyFile()], { windowsHide: true }, (e) => (e ? reject(new Error(`The SSH key could not be made: ${e.message}`)) : resolve())));
    }
    return fs.readFileSync(keyFile() + '.pub', 'utf8').trim();
  }

  function add(body) {
    const name = String(body?.name ?? '').trim(), host = String(body?.host ?? '').trim(), user = String(body?.user ?? '').trim(), port = Number(body?.port || 22);
    if (!NAME.test(name)) return { error: 'A short name, like "my server".', field: 'sName' };
    if (!HOST.test(host)) return { error: 'The server\'s address: an IP or a host name.', field: 'sHost' };
    if (!USER.test(user)) return { error: 'The user to log in as on the server.', field: 'sUser' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The SSH port, usually 22.', field: 'sPort' };
    if (st.servers.length >= 10) return { error: 'At most 10 servers.' };
    st.servers.push({ id: crypto.randomBytes(4).toString('hex'), name, host, user, port, at: Date.now() });
    save(); return { ok: true };
  }
  // Only what needs no new connection: the name.
  function rename(id, name) {
    const s = st.servers.find((x) => x.id === id); if (!s) return { error: 'No such server.' };
    name = String(name ?? '').trim(); if (!NAME.test(name)) return { error: 'A short name, like "my server".' };
    s.name = name; save(); return { ok: true };
  }
  function remove(id) {
    if (st.active === id) disconnect();
    st.servers = st.servers.filter((s) => s.id !== id); save(); return { ok: true };
  }

  // A plain GET through the tunnel, as the server's own page would make it.
  function through(port, p, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout, headers: { host: `127.0.0.1:${REMOTE_PORT}`, origin: `http://127.0.0.1:${REMOTE_PORT}` } }, (res) => {
        let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, body: t }));
      });
      req.on('timeout', () => req.destroy(new Error('timed out'))); req.on('error', reject); req.end();
    });
  }

  async function open(server) {
    await publicKey();
    const port = await freePort();
    const args = ['-N', '-T', '-p', String(server.port), '-i', keyFile(), '-L', `127.0.0.1:${port}:127.0.0.1:${REMOTE_PORT}`,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dir(), 'known_hosts')}`, '-o', 'ConnectTimeout=30',
      `${server.user}@${server.host}`];
    const child = spawn(SSH, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const t = { id: server.id, child, port, state: 'connecting', error: null, since: Date.now(), log: '' };
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { t.log = (t.log + d).slice(-2000); });
    child.on('exit', () => {
      if (tun !== t) return;
      t.state = 'lost'; t.error = explain(t.log) || 'The SSH connection closed.';
      if (st.active === t.id) setTimeout(() => { if (st.active === t.id && tun === t) reconnect(); }, 15000);
    });
    tun = t;
    // Ready when the server's app answers through the tunnel.
    for (let i = 0; i < 30 && tun === t && t.state === 'connecting'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (child.exitCode !== null) break;
      try { const r = await through(port, '/api/state', 5000); if (r.status === 200) { t.state = 'connected'; t.error = null; return { ok: true }; } t.error = `The server's app answered ${r.status}.`; } catch (e) { t.error = /ECONNREFUSED|ECONNRESET|socket hang up/.test(e.message) ? 'The tunnel is open but the app does not answer on the server (is it running?).' : e.message; }
    }
    if (t.state !== 'connected') {
      const why = explain(t.log) || t.error || 'No answer.';
      try { child.kill(); } catch { /* gone */ }
      t.state = 'lost'; t.error = why;
      return { error: why };
    }
    return { ok: true };
  }
  function explain(log) {
    if (/Permission denied/i.test(log)) return 'The server refused the key: add this computer\'s public key to the server user\'s ~/.ssh/authorized_keys.';
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(log)) return 'The server\'s identity changed since the first connection. If you rebuilt it, remove it here and add it again; otherwise do not connect.';
    if (/Connection refused/i.test(log)) return 'Nothing answers on the SSH port of that address.';
    if (/timed out|No route|Could not resolve/i.test(log)) return 'The server did not answer within 30 s. A server just created can take a few minutes to start: wait, then press Set up again. Otherwise check the address, and that its firewall lets SSH (port 22) in.';
    if (/forwarding failed|cannot listen/i.test(log)) return 'The tunnel could not be opened on this computer.';
    return log.trim().split('\n').filter(Boolean).pop() || null;
  }
  async function reconnect() { const s = st.servers.find((x) => x.id === st.active); if (s) await open(s).catch(() => {}); }

  async function connect(id) {
    const s = st.servers.find((x) => x.id === id);
    if (!s) return { error: 'Unknown server.' };
    disconnect();
    st.active = id; save();
    const r = await open(s);
    if (r.error) { st.active = null; save(); }
    return r;
  }
  function disconnect() {
    const t = tun; tun = null; st.active = null; save();
    if (t) try { t.child.kill(); } catch { /* gone */ }
    return { ok: true };
  }

  // The page's /api requests while piloting: through the tunnel, with the server's own Host and Origin.
  function forward(req, res, body) {
    const t = tun;
    if (!t || t.state !== 'connected') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'The server is not reachable right now: the tunnel is reconnecting.' })); }
    const headers = { 'content-type': req.headers['content-type'] || 'application/json', host: `127.0.0.1:${REMOTE_PORT}`, origin: `http://127.0.0.1:${REMOTE_PORT}` };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const up = http.request({ host: '127.0.0.1', port: t.port, path: req.url, method: req.method, headers, timeout: 60000 }, (r) => {
      res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' }); r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: `The server did not answer: ${e.message}` })); } });
    up.end(body || undefined);
  }
  // /api/state through the tunnel, with the pilot's own view added (so the page can switch back).
  async function remoteState() {
    const t = tun; if (!t || t.state !== 'connected') return null;
    const r = await through(t.port, '/api/state', 15000);
    if (r.status !== 200) throw new Error(`The server answered ${r.status}`);
    return JSON.parse(r.body);
  }

  // ---------------------------------------------------------------- step 3: check, install and update over SSH
  const sshBase = (server) => ['-T', '-p', String(server.port), '-i', keyFile(), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dir(), 'known_hosts')}`, '-o', 'ConnectTimeout=30', `${server.user}@${server.host}`];
  // One command on the server; `input` is written to its standard input (a string or a readable stream).
  function run(server, command, { input = null, timeout = 120000, onLine = null } = {}) {
    return new Promise((resolve) => {
      const child = spawn(SSH, [...sshBase(server), command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', buf = '';
      const timer = setTimeout(() => { err += '\n(timed out)'; try { child.kill(); } catch { /* gone */ } }, timeout);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; if (onLine) { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(onLine); } });
      child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); if (onLine && buf) onLine(buf); resolve({ code, out, err }); });
      child.stdin.on('error', () => { /* the far end closed early: the exit code says why */ });
      if (input && typeof input.pipe === 'function') input.pipe(child.stdin); else child.stdin.end(input || undefined);
    });
  }

  // A file to the server with scp (Windows' ssh stalls on large data through its input; scp does not).
  function copyFile(server, local, remote, timeout = 900000) {
    return new Promise((resolve) => {
      const args = ['-q', '-P', String(server.port), '-i', keyFile(), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${path.join(dir(), 'known_hosts')}`, '-o', 'ConnectTimeout=30', local, `${server.user}@${server.host}:${remote}`];
      const child = spawn(SCP, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      const timer = setTimeout(() => { err += '\n(timed out)'; try { child.kill(); } catch { /* gone */ } }, timeout);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
  }

  // What the server is and what it runs: system, root or sudo, the app's version and whether it runs.
  async function check(id) {
    const s = st.servers.find((x) => x.id === id); if (!s) return { error: 'Unknown server.' };
    await publicKey();
    const r = await run(s, `. /etc/os-release 2>/dev/null; echo "OS=$PRETTY_NAME"; echo "ARCH=$(uname -m)"; echo "UID=$(id -u)"; if [ "$(id -u)" = 0 ]; then echo SUDO=root; elif sudo -n true 2>/dev/null; then echo SUDO=nopass; elif command -v sudo >/dev/null; then echo SUDO=password; else echo SUDO=none; fi; echo "VERSION=$(cat /opt/minima-venues/VERSION 2>/dev/null)"; echo "ACTIVE=$(systemctl is-active minima-venues 2>/dev/null)"`, { timeout: 30000 });
    if (r.code !== 0) return { error: explain(r.err) || `The server did not answer (${r.code}).` };
    const v = Object.fromEntries(r.out.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...x]) => [k.trim(), x.join('=').trim()]));
    s.check = { at: Date.now(), os: v.OS || '?', arch: v.ARCH || '?', sudo: v.SUDO || '?', version: v.VERSION || null, active: v.ACTIVE === 'active' };
    save();
    return { ok: true, check: s.check };
  }

  // Install or update. The app is streamed over SSH as a tar archive (and this computer's minima.jar on a first install),
  // then install.sh runs as root. The sudo password, when one is needed, goes to sudo once and is kept nowhere.
  let job = null;   // { id, kind, steps: [], state: 'running'|'done'|'failed', error, version, at }

  // Put this computer's key on the server with the user's password, once: ssh asks a helper for it (the password lives in
  // this process's memory and the helper's environment for that one login, never in a file).
  function askpassFile() {
    const f = path.join(dir(), process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
    const body = process.platform === 'win32'
      ? `@"${process.execPath}" -e "process.stdout.write(process.env.MV_PASS + String.fromCharCode(10))"\r\n`
      : '#!/bin/sh\nprintf \'%s\\n\' "$MV_PASS"\n';
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== body) fs.writeFileSync(f, body, { mode: 0o700 });
    return f;
  }
  async function authorize(server, password) {
    const pub = await publicKey();
    const cmd = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; echo KEY_OK`;
    return new Promise((resolve) => {
      const args = ['-T', '-p', String(server.port), '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dir(), 'known_hosts')}`, '-o', 'ConnectTimeout=30', `${server.user}@${server.host}`, cmd];
      const child = spawn(SSH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS: askpassFile(), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'none', MV_PASS: password } });
      let out = '', err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 40000);
      child.on('error', (e) => { clearTimeout(t); resolve({ error: e.message }); });
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0 && /KEY_OK/.test(out)) return resolve({ ok: true });
        resolve({ error: /Permission denied/i.test(err) ? 'The server refused that password (or does not take passwords: then add the key by hand).' : explain(err) || `The server did not answer (${code}).` });
      });
    });
  }

  /* Install or update; with `setup`, first put this computer's key on the server with the password; with `startNode`, start
   * the app's node after, set to start with the app. The password goes to ssh (key) and sudo once, kept nowhere. */
  function install(id, { password = '', app, jar, setup = false, startNode = false }) {
    const s = st.servers.find((x) => x.id === id); if (!s) return { error: 'Unknown server.' };
    if (job && job.state === 'running') return { error: 'An installation is already running.' };
    if (setup && !password) return { error: 'Type the server password: it is used once to put this computer\'s key there.', field: 'sPass' };
    if (!setup && !s.check) return { error: 'Check the server first.' };
    if (!setup && s.check.sudo === 'password' && !password) return { error: 'This user needs its sudo password to install.', field: 'sPass' };
    job = { id, kind: setup ? 'setup' : s.check?.version ? 'update' : 'install', steps: [], state: 'running', error: null, version: null, at: Date.now() };
    const step = (t) => { job.steps.push({ at: Date.now(), text: t }); };
    (async () => {
      try {
        if (setup) {
          step('Putting this computer\'s key on the server (with the password, once)');
          const a = await authorize(s, password);
          if (a.error) throw new Error(a.error);
        }
        step('Looking at the server');
        const c = await check(id);
        if (c.error) throw new Error(c.error);
        if (s.check.sudo === 'none') throw new Error('This user is not root and has no sudo: log in as root or as a user with sudo.');
        if (s.check.sudo === 'password' && !password) throw new Error('This user needs its sudo password to install.');
        step(`${s.check.os}, ${s.check.arch}${s.check.version ? `, app ${s.check.version} there` : ', no app yet'}`);
        const update = !!s.check.version;
        if (job.kind !== 'setup') job.kind = update ? 'update' : 'install';
        step('Sending the app to the server');
        const pack = await app();
        let r = await copyFile(s, pack, '/tmp/mv-app.tgz', 300000);
        fs.rmSync(pack, { force: true });
        if (r.code !== 0) throw new Error(`Sending the app failed: ${explain(r.err) || r.err.trim().split('\n').pop()}`);
        r = await run(s, 'rm -rf /tmp/mv-up && mkdir -p /tmp/mv-up && tar -xzf /tmp/mv-app.tgz -C /tmp/mv-up && rm -f /tmp/mv-app.tgz', { timeout: 120000 });
        if (r.code !== 0) throw new Error(`Unpacking the app failed: ${r.err.trim().split('\n').pop()}`);
        if (!update && jar && fs.existsSync(jar)) {
          step(`Sending minima.jar (${Math.round(fs.statSync(jar).size / 1e6)} MB, from this computer's node settings: this can take a few minutes)`);
          r = await copyFile(s, jar, '/tmp/mv-up/minima.jar');
          if (r.code !== 0) throw new Error(`Sending minima.jar failed: ${r.err.trim().split('\n').pop()}`);
        }
        const asRoot = s.check.sudo === 'root' ? 'bash' : s.check.sudo === 'nopass' ? 'sudo -n bash' : 'sudo -S -p "" bash';
        r = await run(s, `${asRoot} /tmp/mv-up/tools/linux/install.sh /tmp/mv-up`, {
          input: s.check.sudo === 'password' ? password + '\n' : '', timeout: 900000,
          onLine: (l) => { if (l.startsWith('STEP ')) step(l.slice(5)); else if (l.startsWith('DONE ')) job.version = l.slice(5).trim(); else if (l.startsWith('FAIL ')) job.error = l.slice(5).trim(); },
        });
        if (r.code !== 0 || !job.version) throw new Error(job.error || (/incorrect password|Sorry, try again/i.test(r.err) ? 'The sudo password was refused.' : r.err.trim().split('\n').pop() || `The installer stopped (${r.code}).`));
        step(`${update ? 'Updated' : 'Installed'}: version ${job.version}`);
        if (startNode) {
          step('Starting its Minima node (it reads the venues from it and starts again with the app)');
          r = await run(s, 'node /opt/minima-venues/tools/linux/start-node.mjs', { timeout: 60000 });
          if (!/NODE_OK/.test(r.out)) throw new Error(`The app is installed, but its node did not start: ${(r.out.match(/NODE_FAIL (.*)/) || [])[1] || r.err.trim().split('\n').pop()}`);
          step('Node started: it now syncs with the chain, which can take a while');
        }
        job.state = 'done';
        await check(id).catch(() => {});
      } catch (e) { job.state = 'failed'; job.error = e.message; }
    })();
    return { ok: true };
  }

  const active = () => !!(st.active && tun && tun.id === st.active);
  const view = () => {
    const s = st.servers.find((x) => x.id === st.active);
    return {
      servers: st.servers.map(({ id, name, host, user, port, check }) => ({ id, name, host, user, port, check: check || null })),
      job,
      active: s ? { id: s.id, name: s.name, host: s.host, state: tun?.state || 'lost', error: tun?.error || null, since: tun?.since || null } : null,
      hasKey: fs.existsSync(keyFile() + '.pub'),
    };
  };
  // A server that was active when this computer's app stopped is connected again when it starts.
  async function resume() {
    if (!st.active) return;
    const id = st.active;
    // Right after a start the computer is busy: try three times, 20 s apart, before giving up.
    for (let i = 0; i < 3; i++) {
      const r = await connect(id).catch((e) => ({ error: String(e?.message || e) }));
      if (!r.error) return;
      if (i < 2) { st.active = id; save(); await new Promise((ok) => setTimeout(ok, 20000)); }
    }
  }

  return { publicKey, add, rename, remove, check, install, connect, disconnect, forward, remoteState, active, view, resume, tunnelPort: () => tun?.port ?? null };
}
