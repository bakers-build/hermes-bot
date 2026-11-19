// The nightly composer-audit job's script (audit.mjs), at its command-line seam: `run` and
// `commit`, against a clone and data directory in a temp dir and a fake composer that answers
// from a file per lock directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from './audit.mjs';

const NIGHT = new Date('2026-11-20T03:30:00+01:00');

// The fake composer logs its cwd and arguments and prints <cwd>/.answer.json (exit code from
// <cwd>/.code, else 0 without advisories and 1 with them, as composer does).
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'composer-audit-')));
  const data = join(root, 'data');
  const clone = join(root, 'clone');
  mkdirSync(data);
  mkdirSync(clone);
  const composer = join(root, 'composer');
  writeFileSync(composer, `#!/bin/sh
printf '%s %s\\n' "$PWD" "$*" >> ${JSON.stringify(join(root, 'calls.log'))}
code=0
if [ -f .answer.json ]; then cat .answer.json; grep -q '"advisoryId"' .answer.json && code=1; fi
if [ -f .code ]; then code=$(cat .code); fi
echo "warning on stderr" >&2
exit $code
`);
  chmodSync(composer, 0o755);
  const env = { HERMES_HOME: data, PM_BOT_CLONE_DIR: clone, AUDIT_COMPOSER: composer };
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []);
  const cli = (args, now = NIGHT) => {
    const out = [];
    const code = main(args, { env, now, print: (line) => out.push(line) });
    return { code, out: JSON.parse(out.join('\n')) };
  };
  return { root, data, clone, put, read, calls, cli, exists: (path) => existsSync(join(root, path)) };
}

const marker = (at, extra = {}) => ({ at, head: 'abc123', ok: true, ...extra });
const lock = (packages, dev = []) => ({ packages: packages.map(([name, version]) => ({ name, version })), 'packages-dev': dev.map(([name, version]) => ({ name, version })) });
const advisory = (id, pkg, affected, extra = {}) => ({
  advisoryId: id, packageName: pkg, affectedVersions: affected, title: `${pkg} issue`, cve: `CVE-2026-${id.slice(-4)}`,
  link: `https://github.com/advisories/GHSA-${id.slice(-4)}`, severity: 'high', ...extra,
});
const answer = (...advisories) => {
  const byPackage = {};
  for (const a of advisories) (byPackage[a.packageName] ??= []).push(a);
  return { advisories: byPackage, abandoned: [] };
};

function project(t, { answers = {}, locks = { '.': lock([['guzzlehttp/guzzle', '6.5.0']]) } } = {}) {
  for (const [dir, body] of Object.entries(locks)) {
    t.put(`clone/${dir}/composer.json`, '{}');
    t.put(`clone/${dir}/composer.lock`, body);
  }
  for (const [dir, body] of Object.entries(answers)) t.put(`clone/${dir}/.answer.json`, body);
}

test('without a pull marker the run skips, audits nothing and writes nothing', () => {
  const t = setup();
  project(t);
  const { code, out } = t.cli(['run']);
  assert.equal(code, 0);
  assert.equal(out.status, 'skip');
  assert.match(out.reason, /no pull marker/);
  assert.deepEqual(t.calls(), []);
  assert.equal(t.exists('data/audit-state.json') || t.exists('data/audit-pending.json'), false);
});

test('a failed pull skips the run and quotes its error', () => {
  const t = setup();
  project(t);
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00', { ok: false, error: 'fatal: could not read from remote' }));
  const { out } = t.cli(['run']);
  assert.equal(out.status, 'skip');
  assert.match(out.reason, /fatal: could not read from remote/);
  assert.deepEqual(t.calls(), []);
});

test('a marker no newer than the last audited one skips the run', () => {
  const t = setup();
  project(t);
  t.put('data/clone-pulled.json', marker('2026-11-19T03:00:00+01:00'));
  t.put('data/audit-state.json', { marker_at: '2026-11-19T03:00:00+01:00', audited_at: '2026-11-19T03:30:00+01:00', ticket: null, advisories: {} });
  const { out } = t.cli(['run']);
  assert.equal(out.status, 'skip');
  assert.match(out.reason, /no pull since the last audit/);
  assert.deepEqual(t.calls(), []);
});

test('every lock file with a composer.json beside it is audited in its own directory with the pinned flags', () => {
  const t = setup();
  project(t, { locks: {
    '.': lock([['drupal/core', '10.3.0']]),
    'web/themes/custom/site': lock([['psr/log', '3.0.2']]),
    'vendor/acme/lib': lock([]), 'node_modules/x': lock([]), '.git/y': lock([]),
  } });
  t.put('clone/orphan/composer.lock', lock([])); // no composer.json beside it
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  const { out } = t.cli(['run']);
  assert.equal(out.status, 'audited');
  assert.deepEqual(out.locks, ['composer.lock', 'web/themes/custom/site/composer.lock']);
  assert.deepEqual(t.calls(), [
    `${t.clone} audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore`,
    `${join(t.clone, 'web/themes/custom/site')} audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore`,
  ]);
});

test('a composer failure is the answer, and nothing is written', () => {
  const t = setup();
  project(t);
  t.put('clone/.code', '100');
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  const { code, out } = t.cli(['run']);
  assert.equal(code, 1);
  assert.equal(out.status, 'error');
  assert.match(out.reason, /composer\.lock.*exit 100.*warning on stderr/);
  assert.equal(t.exists('data/audit-state.json') || t.exists('data/audit-pending.json'), false);
});

test('a lock without packages and a clean lock have no advisories', () => {
  const t = setup();
  project(t, { locks: { '.': lock([]), sub: lock([['psr/log', '3.0.2']]) }, answers: { sub: { advisories: [], abandoned: [] } } });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  const { out } = t.cli(['run']);
  assert.equal(out.status, 'audited');
  assert.equal(out.count, 0);
  assert.deepEqual([out.new, out.gone, out.comment], [[], [], null]);
});

test('findings carry the installed version, the fixed-in version and a ticket text with a table per lock file', () => {
  const t = setup();
  project(t, {
    locks: { '.': lock([['guzzlehttp/guzzle', '6.5.0']], [['phpunit/phpunit', '9.5.0']]), 'web/themes/site': lock([['drupal/core', '10.3.0']]) },
    answers: {
      '.': answer(
        advisory('PKSA-0001', 'guzzlehttp/guzzle', '>=8.0.0,<8.0.1|<7.15.2'),
        advisory('PKSA-0002', 'phpunit/phpunit', '>=9.0.0,<9.6.33', { severity: 'medium', cve: null }),
      ),
      'web/themes/site': answer(advisory('SA-CORE-2026-0003', 'drupal/core', '>=10.3.0,<10.3.9', { severity: null })),
    },
  });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  const { out } = t.cli(['run']);
  assert.equal(out.count, 3);
  assert.deepEqual(out.new.sort(), ['PKSA-0001 (composer.lock)', 'PKSA-0002 (composer.lock)', 'SA-CORE-2026-0003 (web/themes/site/composer.lock)']);
  assert.equal(out.title, 'Security updates: 3 Composer advisories (drupal/core, guzzlehttp/guzzle, phpunit/phpunit)');
  const d = out.description;
  assert.match(d, /### `composer\.lock`/);
  assert.match(d, /### `web\/themes\/site\/composer\.lock`/);
  assert.match(d, /\| Package \| Installed \| Fixed in \| Severity \| CVE \/ advisory \|/);
  assert.match(d, /\| guzzlehttp\/guzzle \| 6\.5\.0 \| 7\.15\.2 \| high \| \[CVE-2026-0001\]\(https:\/\/github\.com\/advisories\/GHSA-0001\) \|/);
  assert.match(d, /\| phpunit\/phpunit \| 9\.5\.0 \| 9\.6\.33 \| medium \| \[PKSA-0002\]\(https:\/\/github\.com\/advisories\/GHSA-0002\) \|/);
  assert.match(d, /\| drupal\/core \| 10\.3\.0 \| 10\.3\.9 \| — \|/);
  assert.match(d, /composer update guzzlehttp\/guzzle phpunit\/phpunit --with-dependencies/);
  assert.match(d, /cd web\/themes\/site && composer update drupal\/core --with-dependencies/);
});

test('commit records the findings, the marker, the audit time and the ticket; the next run sees them as known', () => {
  const t = setup();
  project(t, { answers: { '.': answer(advisory('PKSA-0001', 'guzzlehttp/guzzle', '<7.15.2')) } });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  t.cli(['run']);
  assert.equal(t.cli(['commit', '--ticket', 'YF-12']).code, 0);
  const state = t.read('data/audit-state.json');
  assert.equal(state.marker_at, '2026-11-20T03:00:00+01:00');
  assert.equal(state.audited_at, NIGHT.toISOString());
  assert.equal(state.ticket, 'YF-12');
  assert.deepEqual(state.advisories['PKSA-0001 (composer.lock)'], {
    id: 'PKSA-0001', lock: 'composer.lock', package: 'guzzlehttp/guzzle', installed: '6.5.0', affected: '<7.15.2', fixed_in: '7.15.2',
    severity: 'high', cve: 'CVE-2026-0001', link: 'https://github.com/advisories/GHSA-0001', first_seen: '2026-11-20',
  });
  assert.equal(t.exists('data/audit-pending.json'), false);

  // The next night: the same advisory plus a new one, one fixed in the clone.
  t.put('data/clone-pulled.json', marker('2026-11-21T03:00:00+01:00'));
  t.put('clone/.answer.json', answer(advisory('PKSA-0004', 'guzzlehttp/guzzle', '<7.16.0')));
  let { out } = t.cli(['run'], new Date('2026-11-21T03:30:00+01:00'));
  assert.equal(out.ticket, 'YF-12');
  assert.deepEqual([out.new, out.gone], [['PKSA-0004 (composer.lock)'], ['PKSA-0001 (composer.lock)']]);
  assert.match(out.comment, /New advisories/);
  assert.match(out.comment, /PKSA-0004|CVE-2026-0004/);
  assert.match(out.comment, /Resolved in the clone[\s\S]*guzzlehttp\/guzzle.*PKSA-0001/);
  t.cli(['commit'], new Date('2026-11-21T03:30:00+01:00'));
  const next = t.read('data/audit-state.json');
  assert.equal(next.ticket, 'YF-12');
  assert.deepEqual(Object.keys(next.advisories), ['PKSA-0004 (composer.lock)']);
  assert.equal(next.advisories['PKSA-0004 (composer.lock)'].first_seen, '2026-11-21');

  // A third night, nothing changed: nothing new, nothing gone, no comment.
  t.put('data/clone-pulled.json', marker('2026-11-22T03:00:00+01:00'));
  ({ out } = t.cli(['run'], new Date('2026-11-22T03:30:00+01:00')));
  assert.deepEqual([out.new, out.gone, out.comment], [[], [], null]);
});

test('commit --no-ticket forgets a closed ticket; commit without a run fails', () => {
  const t = setup();
  assert.equal(t.cli(['commit']).code, 1);
  project(t, { locks: { '.': lock([]) } });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  t.put('data/audit-state.json', { marker_at: '2026-11-19T03:00:00+01:00', ticket: 'YF-12', advisories: {} });
  t.cli(['run']);
  t.cli(['commit', '--no-ticket']);
  assert.equal(t.read('data/audit-state.json').ticket, null);
});

test('the run reports the bot language for its answer', () => {
  const t = setup();
  project(t, { locks: { '.': lock([]) } });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  t.put('data/bot-language.json', { language: 'en' });
  assert.equal(t.cli(['run']).out.language, 'en');
});

test('an advisory in two lock files is tracked per lock: fixing one is resolved there and new nowhere', () => {
  const t = setup();
  const both = { '.': lock([['guzzlehttp/guzzle', '6.5.0']]), 'web/themes/site': lock([['guzzlehttp/guzzle', '6.5.0']]) };
  project(t, { locks: both, answers: {
    '.': answer(advisory('PKSA-0001', 'guzzlehttp/guzzle', '<7.15.2')),
    'web/themes/site': answer(advisory('PKSA-0001', 'guzzlehttp/guzzle', '<7.15.2')),
  } });
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  assert.equal(t.cli(['run']).out.count, 2);
  t.cli(['commit', '--ticket', 'YF-12']);

  // The root lock is updated; the theme's lock still has the advisory.
  t.put('data/clone-pulled.json', marker('2026-11-21T03:00:00+01:00'));
  t.put('clone/.answer.json', answer());
  const { out } = t.cli(['run'], new Date('2026-11-21T03:30:00+01:00'));
  assert.equal(out.count, 1);
  assert.deepEqual(out.new, []);
  assert.deepEqual(out.gone, ['PKSA-0001 (composer.lock)']);
  assert.match(out.comment, /Resolved in the clone\n\n- guzzlehttp\/guzzle 6\.5\.0 · PKSA-0001 \(`composer\.lock`\)$/);
  assert.doesNotMatch(out.description, /### `composer\.lock`/);
  assert.match(out.description, /### `web\/themes\/site\/composer\.lock`[\s\S]*CVE-2026-0001/);
});

test('an unreadable audit state is an error result, and nothing is audited or written', () => {
  const t = setup();
  project(t);
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  t.put('data/audit-state.json', '{ not json');
  const { code, out } = t.cli(['run']);
  assert.equal(code, 1);
  assert.equal(out.status, 'error');
  assert.match(out.reason, /audit-state\.json/);
  assert.deepEqual(t.calls(), []);
  assert.equal(t.exists('data/audit-pending.json'), false);
});

test('a missing clone is an error result, and nothing is written', () => {
  const t = setup();
  t.put('data/clone-pulled.json', marker('2026-11-20T03:00:00+01:00'));
  rmSync(t.clone, { recursive: true });
  const { code, out } = t.cli(['run']);
  assert.equal(code, 1);
  assert.equal(out.status, 'error');
  assert.match(out.reason, /clone/);
  assert.equal(t.exists('data/audit-pending.json'), false);
});
