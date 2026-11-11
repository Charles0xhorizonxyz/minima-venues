/* Copy the last commit into the public repository's clone, as one release commit.
 *
 *   node tools/publish-public.mjs [--to <clone folder>] [--push]
 *
 * The working repository keeps private notes (marked export-ignore in .gitattributes); `git archive` leaves them out.
 * The release is refused if any line of data/private-patterns.txt (never committed) matches a published file, or if the
 * working tree has uncommitted changes. Without --push it commits locally and stops, so the result can be looked at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const TO = path.resolve(arg('to') || path.join(ROOT, '..', 'minima-venues-public'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const fail = (m) => { console.error(`Refused: ${m}`); process.exit(1); };

if (git(ROOT, 'status', '--porcelain')) fail('commit or stash the changes first.');
if (!fs.existsSync(path.join(TO, '.git'))) fail(`no clone of the public repository at ${TO}.`);
const sha = git(ROOT, 'rev-parse', '--short', 'HEAD');

// Empty the clone (its .git stays), then unpack the commit into it.
for (const f of git(TO, 'ls-files', '-z').split('\0').filter(Boolean)) fs.rmSync(path.join(TO, f), { force: true });
const tar = path.join(TO, '.release.tar');
execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: ROOT });
execFileSync('tar', ['-xf', '.release.tar'], { cwd: TO });
fs.rmSync(tar);

let patterns = [];
try { patterns = fs.readFileSync(path.join(ROOT, 'data', 'private-patterns.txt'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => new RegExp(l.trim(), 'i')); } catch { fail('data/private-patterns.txt is missing.'); }
const hits = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === '.git') continue;
  const p = path.join(d, e.name), rel = path.relative(TO, p);
  if (e.isDirectory()) { walk(p); continue; }
  const text = fs.readFileSync(p, 'utf8');
  for (const re of patterns) if (re.test(text) || re.test(rel)) hits.push(`${rel}: ${re.source}`);
} };
walk(TO);
if (hits.length) { try { git(TO, 'checkout', '--', '.'); } catch { /* a first release: nothing to restore */ } fail(`private text found, nothing committed:\n  ${hits.join('\n  ')}`); }

git(TO, 'add', '-A');
if (!git(TO, 'status', '--porcelain')) { console.log('Nothing changed since the last release.'); process.exit(0); }
git(TO, 'commit', '-q', '-m', `Release from ${sha}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
console.log(`Committed in ${TO}: ${git(TO, 'log', '--oneline', '-1')}`);
if (process.argv.includes('--push')) { git(TO, 'push', '-q', 'origin', 'HEAD'); console.log('Pushed.'); }
else console.log('Not pushed. Look at it, then run again with --push or push from that folder.');
