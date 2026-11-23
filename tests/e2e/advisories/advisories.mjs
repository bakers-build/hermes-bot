#!/usr/bin/env node
// The end-to-end test's Packagist: a Composer repository that lists no packages and answers
// Composer's security-advisories API, so `composer audit` in the bot's container runs offline. The
// clone fixture's composer.json names it as its only repository (http://advisories, secure-http off).
// No dependencies.
//
//   GET  /packages.json                    the repository's root: its advisory API, no packages
//   GET  /p2/<package>.json                404: no package metadata
//   GET|POST /api/security-advisories/     {advisories: {<package>: [...]}} for the packages asked
//                                          (packages[]=… or packages[0]=…, in the query or the form body)
//   GET  /_calls                           every API call: {packages, at}
//
//   node tests/e2e/advisories/advisories.mjs   # listens on PORT (80)

import { createServer } from 'node:http';

// One advisory, for the fixture lock's acme/widget 1.0.0.
export const ADVISORIES = {
  'acme/widget': [
    {
      advisoryId: 'PKSA-e2e0-0000-0001',
      packageName: 'acme/widget',
      remoteId: 'e2e-0001',
      title: 'acme/widget: remote code execution in the widget renderer',
      link: 'https://advisories.e2e.test/PKSA-e2e0-0000-0001',
      cve: 'CVE-2026-0001',
      affectedVersions: '>=1.0.0,<1.2.3',
      source: 'e2e',
      reportedAt: '2026-11-01 00:00:00',
      composerRepository: 'http://advisories',
      severity: 'high',
      sources: [{ name: 'e2e', remoteId: 'e2e-0001' }],
    },
  ],
};

export function createAdvisories() {
  const calls = [];
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://advisories');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/packages.json') {
      // Composer reads security-advisories only beside a metadata-url; no package is ever served from it.
      return json(200, {
        packages: [],
        'metadata-url': '/p2/%package%.json',
        'security-advisories': { metadata: false, 'api-url': 'http://advisories/api/security-advisories/' },
      });
    }
    if (url.pathname === '/api/security-advisories/') {
      // packages[]=… or, as Composer posts them, packages[0]=…
      const asked = [...url.searchParams, ...new URLSearchParams(raw)].filter(([key]) => /^packages\[\d*\]$/.test(key)).map(([, name]) => name);
      calls.push({ packages: asked, at: new Date().toISOString() });
      return json(200, { advisories: Object.fromEntries(asked.filter((name) => ADVISORIES[name]).map((name) => [name, ADVISORIES[name]])) });
    }
    if (req.method === 'GET' && url.pathname === '/_calls') return json(200, calls);
    return json(404, { error: `no route ${req.method} ${url.pathname}` });
  });
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain) createAdvisories().listen(Number(process.env.PORT ?? 80), '0.0.0.0');
