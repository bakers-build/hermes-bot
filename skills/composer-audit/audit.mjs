// The nightly composer-audit job's fixed steps (SKILL.md): the job's agent runs this script and
// decides from its JSON output, so no advisory data ever goes into a shell command.
//
//   node audit.mjs run                     gate on the pull marker, audit every lock file and
//                                          compare with the last audit; writes only
//                                          audit-pending.json, and only after a full audit
//   node audit.mjs commit [--ticket <id> | --no-ticket]
//                                          make that audit the state (audit-state.json), with
//                                          the open audit ticket's identifier
//
// Files (HERMES_HOME, default /opt/data): clone-pulled.json, the box's pull marker
// { at, head, ok, error }; audit-state.json { marker_at, audited_at, ticket, advisories }, the
// advisories by advisory ID; bot-language.json, the bot's language. The clone is
// PM_BOT_CLONE_DIR (default /opt/clone); AUDIT_COMPOSER names the composer binary for tests.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AUDIT_ARGS = ['audit', '--locked', '--format=json', '--no-plugins', '--no-scripts', '--abandoned=ignore'];
const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules']);

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

// Every composer.lock with a composer.json beside it, outside .git, vendor and node_modules,
// relative to the clone, sorted. Symlinks are not followed.
export function findLocks(clone, dir = clone) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const found = names.has('composer.lock') && names.has('composer.json') ? [relative(clone, join(dir, 'composer.lock'))] : [];
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) found.push(...findLocks(clone, join(dir, e.name)));
  }
  return found.sort();
}

function version(text) {
  const match = /^v?(\d+(?:\.\d+)*)/i.exec(String(text ?? '').trim());
  return match ? match[1].split('.').map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const TESTS = { '>=': (c) => c >= 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '<': (c) => c < 0, '==': (c) => c === 0, '=': (c) => c === 0, '!=': (c) => c !== 0, '': (c) => c === 0 };

// The first release outside the affected range the installed version falls into: the `<` bound
// of its branch of `a,b|c` (OR of ANDs). — when there is none or the versions do not compare.
export function fixedIn(installed, affected) {
  const have = version(installed);
  if (!have) return '—';
  for (const branch of String(affected ?? '').split('|')) {
    const parts = branch.split(',').map((p) => /^\s*(>=|<=|==|!=|>|<|=)?\s*(\S+)\s*$/.exec(p)).filter(Boolean);
    const bounds = parts.map(([, op = '', v]) => ({ op, v, parsed: version(v) }));
    if (!bounds.length || bounds.some((b) => !b.parsed)) continue;
    if (bounds.every((b) => TESTS[b.op](compare(have, b.parsed)))) {
      const upper = bounds.find((b) => b.op === '<');
      return upper ? upper.v.replace(/^v/i, '') : '—';
    }
  }
  return '—';
}

function audit(clone, lockPath, composer) {
  const lock = JSON.parse(readFileSync(join(clone, lockPath), 'utf8'));
  const installed = new Map([...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])].map((p) => [p.name, p.version]));
  const result = spawnSync(composer, AUDIT_ARGS, { cwd: join(clone, dirname(lockPath)), encoding: 'utf8', timeout: 300_000 });
  const why = () => {
    const last = String(result.stderr ?? '').trim().split('\n').filter(Boolean).at(-1);
    return `composer audit failed for ${lockPath}: ${result.error ? result.error.message : `exit ${result.status}`}${last ? `: ${last}` : ''}`;
  };
  if (result.error || ![0, 1].includes(result.status)) throw new Error(why());
  const stdout = String(result.stdout ?? '').trim();
  // A lock without packages: composer skips it and prints no JSON.
  if (!stdout && result.status === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(why());
  }
  if (!parsed || typeof parsed.advisories !== 'object') throw new Error(why());
  return Object.values(parsed.advisories).flat().map((a) => ({
    id: a.advisoryId,
    lock: lockPath,
    package: a.packageName,
    installed: installed.get(a.packageName) ?? '—',
    affected: a.affectedVersions,
    fixed_in: fixedIn(installed.get(a.packageName), a.affectedVersions),
    severity: a.severity || null,
    cve: a.cve || null,
    link: a.link || null,
  }));
}

const cell = (value) => String(value ?? '—').replaceAll('|', '\\|');
const reference = (a) => {
  const label = cell(a.cve || a.id);
  return a.link ? `[${label}](${a.link})` : label;
};

// One table per lock file and its update command, for the ticket or a comment.
function tables(advisories) {
  const byLock = new Map();
  for (const a of Object.values(advisories)) {
    if (!byLock.has(a.lock)) byLock.set(a.lock, []);
    byLock.get(a.lock).push(a);
  }
  return [...byLock.keys()].sort().map((lock) => {
    const rows = byLock.get(lock).sort((a, b) => a.package.localeCompare(b.package) || a.id.localeCompare(b.id));
    const packages = [...new Set(rows.map((a) => a.package))].sort().join(' ');
    const dir = dirname(lock);
    const command = `${dir === '.' ? '' : `cd ${dir} && `}composer update ${packages} --with-dependencies`;
    return [
      `### \`${lock}\``,
      '',
      '| Package | Installed | Fixed in | Severity | CVE / advisory |',
      '|---|---|---|---|---|',
      ...rows.map((a) => `| ${cell(a.package)} | ${cell(a.installed)} | ${cell(a.fixed_in)} | ${cell(a.severity)} | ${reference(a)} |`),
      '',
      '```sh',
      command,
      '```',
    ].join('\n');
  }).join('\n\n');
}

function packagesOf(advisories) {
  return [...new Set(Object.values(advisories).map((a) => a.package))].sort();
}

function run({ data, clone, composer, now }) {
  const markerPath = join(data, 'clone-pulled.json');
  const state = readJson(join(data, 'audit-state.json')) ?? { advisories: {} };
  const language = readJson(join(data, 'bot-language.json'))?.language ?? 'de';
  const skip = (reason) => ({ status: 'skip', reason, language });
  let marker;
  try {
    marker = readJson(markerPath);
  } catch (error) {
    return skip(`skipped: the pull marker clone-pulled.json is unreadable (${error.message})`);
  }
  if (!marker) return skip('skipped: no pull marker clone-pulled.json, so the clone may be stale');
  if (marker.ok !== true) return skip(`skipped: the last pull failed: ${marker.error ?? 'no error given'}`);
  const at = Date.parse(marker.at);
  if (Number.isNaN(at)) return skip(`skipped: the pull marker has no valid time (${marker.at})`);
  if (state.marker_at && at <= Date.parse(state.marker_at)) {
    return skip(`skipped: no pull since the last audit (last pull ${marker.at})`);
  }

  const locks = findLocks(clone);
  const advisories = {};
  try {
    for (const lock of locks) {
      for (const a of audit(clone, lock, composer)) {
        const key = advisories[a.id] ? `${a.id} (${a.lock})` : a.id;
        const { id, ...rest } = a;
        advisories[key] = { ...rest, first_seen: state.advisories?.[key]?.first_seen ?? now.toLocaleDateString('en-CA') };
      }
    }
  } catch (error) {
    return { status: 'error', reason: error.message, language };
  }

  const previous = state.advisories ?? {};
  const fresh = Object.keys(advisories).filter((k) => !previous[k]);
  const gone = Object.keys(previous).filter((k) => !advisories[k]);
  writeJson(join(data, 'audit-pending.json'), {
    marker_at: marker.at, audited_at: now.toISOString(), ticket: state.ticket ?? null, advisories,
  });

  const count = Object.keys(advisories).length;
  const packages = packagesOf(advisories);
  const comment = [];
  if (fresh.length) {
    comment.push('#### New advisories', '', tables(Object.fromEntries(fresh.map((k) => [k, { id: k.split(' ')[0], ...advisories[k] }]))));
  }
  if (gone.length) {
    comment.push(...(comment.length ? [''] : []), '#### Resolved in the clone', '',
      ...gone.map((k) => `- ${previous[k].package} ${previous[k].installed} · ${k} (\`${previous[k].lock}\`)`));
  }
  const withIds = Object.fromEntries(Object.entries(advisories).map(([k, a]) => [k, { id: k.split(' ')[0], ...a }]));
  return {
    status: 'audited',
    language,
    marker: { at: marker.at, head: marker.head ?? null },
    ticket: state.ticket ?? null,
    locks,
    count,
    packages,
    new: fresh,
    gone,
    title: count ? `Security updates: ${count} Composer advisories (${packages.join(', ')})` : null,
    description: count
      ? [`The nightly Composer audit of the clone at \`${marker.head ?? 'unknown'}\` found ${count} security ${count === 1 ? 'advisory' : 'advisories'} in ${packages.length} ${packages.length === 1 ? 'package' : 'packages'}.`, '', tables(withIds)].join('\n')
      : null,
    comment: comment.length ? comment.join('\n') : null,
  };
}

function commit({ data }, args) {
  const pendingPath = join(data, 'audit-pending.json');
  const pending = readJson(pendingPath);
  if (!pending) return { status: 'error', reason: 'nothing to commit: run the audit first' };
  const i = args.indexOf('--ticket');
  if (i >= 0) {
    if (!args[i + 1]) return { status: 'error', reason: '--ticket needs an identifier' };
    pending.ticket = args[i + 1];
  }
  if (args.includes('--no-ticket')) pending.ticket = null;
  writeJson(join(data, 'audit-state.json'), pending);
  rmSync(pendingPath);
  return { status: 'committed', ticket: pending.ticket, count: Object.keys(pending.advisories).length };
}

export function main(args, { env = process.env, now = new Date(), print = console.log } = {}) {
  const ctx = {
    data: env.HERMES_HOME || '/opt/data',
    clone: env.PM_BOT_CLONE_DIR || '/opt/clone',
    composer: env.AUDIT_COMPOSER || 'composer',
    now,
  };
  let result;
  if (args[0] === 'run') result = run(ctx);
  else if (args[0] === 'commit') result = commit(ctx, args.slice(1));
  else result = { status: 'error', reason: 'usage: node audit.mjs run | commit [--ticket <id> | --no-ticket]' };
  print(JSON.stringify(result, null, 2));
  return result.status === 'error' ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
