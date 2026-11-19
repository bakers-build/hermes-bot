import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hermesTranslate, protectedParts, translateAll } from './translate.mjs';

test('the protected parts are fenced code, code spans, URLs, ticket identifiers and file paths', () => {
  const text = 'See `npm test` in poller/updates.mjs and README.md for ACME-7 and AC3 at https://a.example/x?y=1.\n\n```\nnode run.mjs\n```';
  assert.deepEqual(protectedParts(text), [
    '```\nnode run.mjs\n```',
    '`npm test`',
    'https://a.example/x?y=1',
    'ACME-7',
    'poller/updates.mjs',
    'README.md',
    'run.mjs',
  ]);
  assert.deepEqual(protectedParts('Rafi approved the change, e.g. at 3 a.m. Then we ship.'), []);
});

test('translateAll keys each translation by its original, calls once per distinct text and none for English', async () => {
  const calls = [];
  const translate = async (text, code) => (calls.push([text, code]), `${code}: ${text}`);
  const out = await translateAll(['One.', 'Two.', 'One.'], 'fr', translate, () => {});
  assert.deepEqual([...out], [['One.', 'fr: One.'], ['Two.', 'fr: Two.']]);
  assert.deepEqual(calls, [['One.', 'fr'], ['Two.', 'fr']]);
  assert.deepEqual([...(await translateAll(['One.'], 'en', translate, () => {}))], []);
  assert.equal(calls.length, 2);
});

// A stand-in for the hermes CLI: it records its arguments and answers as the env tells it.
function fakeHermes(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-hermes-'));
  const command = join(dir, 'hermes');
  writeFileSync(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\n${script}\n`);
  chmodSync(command, 0o755);
  return { command, args: () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) };
}

test('hermesTranslate runs one Hermes call in safe mode with no tool, on the given model, and answers its output', async (t) => {
  const hermes = fakeHermes(t, "process.stdout.write('Rafi hat die Änderung freigegeben.\\n');");
  const translate = hermesTranslate({ command: hermes.command, model: 'claude-sonnet-4-6' });
  assert.equal(await translate('Rafi approved the change.', 'de'), 'Rafi hat die Änderung freigegeben.');
  const args = hermes.args();
  const prompt = args[args.indexOf('-z') + 1];
  assert.deepEqual(args.filter((a) => a !== prompt), ['--safe-mode', '-z', '-m', 'claude-sonnet-4-6', '--provider', 'anthropic', '-t', 'context_engine']);
  assert.match(prompt, /ISO 639-1 code "de"/);
  assert.ok(prompt.endsWith('<text>\nRafi approved the change.\n</text>'), prompt);
});

test('hermesTranslate rejects on a non-zero exit, with its error output', async (t) => {
  const hermes = fakeHermes(t, "process.stderr.write('Anthropic said 429'); process.exit(2);");
  await assert.rejects(hermesTranslate({ command: hermes.command, model: 'm' })('Text.', 'de'), /exited 2: Anthropic said 429/);
});

test('hermesTranslate rejects a call that outlasts its timeout', async (t) => {
  const hermes = fakeHermes(t, 'setTimeout(() => {}, 10000);');
  await assert.rejects(hermesTranslate({ command: hermes.command, model: 'm', timeout: 200 })('Text.', 'de'), /timed out/);
});

test('hermesTranslate rejects when the command does not exist', async () => {
  await assert.rejects(hermesTranslate({ command: '/nonexistent/hermes', model: 'm' })('Text.', 'de'), /ENOENT/);
});

test('hermesTranslate rejects with the reason Hermes prints on its output when its error output is empty', async (t) => {
  const hermes = fakeHermes(t, "process.stdout.write('Anthropic rejected your API key.\\n\\nProvider said: HTTP 401\\n'); process.exit(2);");
  await assert.rejects(hermesTranslate({ command: hermes.command, model: 'm' })('Text.', 'de'), /exited 2: Anthropic rejected your API key\. Provider said: HTTP 401/);
});
