import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import type {Server} from 'node:http';
import {request} from 'node:http';

import {loadConfig} from './config.ts';
import {createCanvasServer, hostAllowed, resolveStaticPath} from './server.ts';
import {SnapshotSource} from './snapshot.ts';

/* Port 0 throughout: the live household display owns 4174 and a test that
 * binds a fixed port is a test that occasionally takes the TV down. */

let staticDir = '';
let server: Server;
let base = '';

const SECRETS = ['s3cret-ha-token-DO-NOT-LEAK', 'access-key-DO-NOT-LEAK'];

before(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'canvas-static-'));
  await writeFile(join(staticDir, 'ambient.html'), '<!doctype html><title>Canvas</title>');
  await mkdir(join(staticDir, 'assets'), {recursive: true});
  await writeFile(join(staticDir, 'assets', 'ambient-abc123.js'), 'export const x = 1;\n');
  /* A file OUTSIDE the static root, so traversal has something real to find:
   * a traversal test that can only ever 404 proves nothing. */
  await writeFile(join(staticDir, '..', 'canvas-traversal-canary.txt'), 'CANARY');

  /* The environment a stranger has: empty, except credentials we then assert
   * never reach a response body. */
  const {config} = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.invalid:8123',
    HOMEASSISTANT_TOKEN: SECRETS[0],
    UNSPLASH_ACCESS_KEY: SECRETS[1],
    CANVAS_PORT: '0',
  });

  server = createCanvasServer({config, staticDir});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
});

test('the server starts and serves with an entirely empty environment', async () => {
  /* The headline property of the whole project: a stranger with Docker and no
   * home automation server, no photo account and no .env gets a screen. */
  const {config, problems} = loadConfig({});
  assert.equal(problems.length, 0);
  const bare = createCanvasServer({config, staticDir});
  await new Promise<void>((ok) => bare.listen(0, '127.0.0.1', ok));
  const addr = bare.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.status, 'ok');
  assert.equal(body.config.homeAssistant, 'disabled');
  assert.equal(body.config.photos, 'disabled');
  bare.close();
});

test('/healthz returns 200 and never requires an integration', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json() as any;
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptimeSeconds, 'number');
});

test('/healthz reports that credentials are set without revealing them', async () => {
  const text = await (await fetch(`${base}/healthz`)).text();
  assert.match(text, /token set/, 'health should report presence');
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), 'health endpoint leaked a credential');
  }
});

test('/__ambient/snapshot returns a valid snapshot with nothing configured', async () => {
  const {config} = loadConfig({CANVAS_PORT: '0'});
  const bare = createCanvasServer({config, staticDir});
  await new Promise<void>((ok) => bare.listen(0, '127.0.0.1', ok));
  const addr = bare.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const res = await fetch(`http://127.0.0.1:${addr.port}/__ambient/snapshot`);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.weather, null);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.peopleHome, []);
  assert.equal(body.photo, null);
  /* Nothing configured is not a degraded source. An unset integration must
   * not render as a broken one on the health strip. */
  assert.deepEqual(body.degraded, []);
  assert.ok(Date.parse(body.generatedAt) > 0);
  bare.close();
});

test('no credential appears in any response body', async () => {
  const bodies = await Promise.all(
    ['/healthz', '/__ambient/snapshot', '/ambient.html', '/nope'].map(
      async (p) => (await fetch(base + p)).text(),
    ),
  );
  for (const body of bodies) {
    for (const secret of SECRETS) {
      assert.ok(!body.includes(secret), `a response body leaked ${secret}`);
    }
    assert.ok(!body.includes('Bearer '), 'a response body leaked an auth header');
  }
});

/* fetch() treats Host as a forbidden header and silently rewrites it, so a
 * Host-allowlist test written with fetch quietly asserts nothing. Raw
 * node:http is the only way to send the header the server actually checks. */
function rawGet(port: number, path: string, host: string): Promise<{status: number; body: string}> {
  return new Promise((ok, fail) => {
    const req = request({host: '127.0.0.1', port, path, method: 'GET', headers: {Host: host}}, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({status: res.statusCode ?? 0, body}));
    });
    req.on('error', fail);
    req.end();
  });
}

test('a bogus Host header is rejected', async () => {
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const res = await rawGet(addr.port, '/healthz', 'evil.example.com');
  assert.equal(res.status, 403);
  assert.ok(!res.body.includes('token set'), 'a rejected host must learn nothing about config');

  /* And the positive control, so the test cannot pass by rejecting everything. */
  const ok = await rawGet(addr.port, '/healthz', '127.0.0.1');
  assert.equal(ok.status, 200);
});

test('loopback is always allowed so a fresh container can be health-checked', () => {
  const {config} = loadConfig({});
  assert.ok(hostAllowed('127.0.0.1:4174', config.allowedHosts));
  assert.ok(hostAllowed('localhost', config.allowedHosts));
  assert.ok(!hostAllowed('attacker.test', config.allowedHosts));
  assert.ok(!hostAllowed(undefined, config.allowedHosts));
});

test('a configured base URL implicitly allows its own host', () => {
  const {config} = loadConfig({CANVAS_BASE_URL: 'https://canvas.example.org'});
  assert.ok(hostAllowed('canvas.example.org', config.allowedHosts));
});

test('path traversal cannot escape the static root', async () => {
  for (const attack of [
    '/../canvas-traversal-canary.txt',
    '/../../etc/passwd',
    '/assets/../../canvas-traversal-canary.txt',
    '/%2e%2e/canvas-traversal-canary.txt',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  ]) {
    const res = await fetch(base + attack, {redirect: 'manual'});
    const text = await res.text();
    assert.ok(res.status === 403 || res.status === 404, `${attack} returned ${res.status}`);
    assert.ok(!text.includes('CANARY'), `${attack} escaped the static root`);
    assert.ok(!text.includes('root:'), `${attack} read /etc/passwd`);
  }
});

test('resolveStaticPath refuses anything outside the root', () => {
  const root = '/srv/canvas';
  assert.equal(resolveStaticPath('/../../etc/passwd', root), null);
  assert.equal(resolveStaticPath('/a/../../../etc/passwd', root), null);
  assert.equal(resolveStaticPath('/x\0.html', root), null);
  assert.equal(resolveStaticPath('/%', root), null, 'undecodable input must not throw through');
  assert.equal(resolveStaticPath('/', root), '/srv/canvas/ambient.html');
  assert.equal(resolveStaticPath('/assets/a.js', root), '/srv/canvas/assets/a.js');
});

test('static files are served with correct MIME types', async () => {
  const html = await fetch(`${base}/ambient.html`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await html.text(), /<!doctype html>/i);

  const js = await fetch(`${base}/assets/ambient-abc123.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
  /* Hashed assets are immutable; the entry HTML must not be, or a wall screen
   * keeps a stale bundle until someone power-cycles it. */
  assert.match(js.headers.get('cache-control') ?? '', /immutable/);
  assert.match(html.headers.get('cache-control') ?? '', /no-cache/);
});

test('/ serves the ambient display', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Canvas/);
});

test('security headers are set on every response', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

test('a write method is refused', async () => {
  const res = await fetch(`${base}/__ambient/snapshot`, {method: 'POST'});
  assert.equal(res.status, 405);
});

test('a missing file is a 404, not a stack trace', async () => {
  const res = await fetch(`${base}/does-not-exist.js`);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.ok(!text.includes('at '), 'a stack trace escaped to the client');
});

test('one failing source degrades alone and never blanks the screen', async () => {
  /* The property that keeps a household screen useful: weather is dead,
   * everything else still renders. */
  const {config} = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.invalid:8123',
    HOMEASSISTANT_TOKEN: SECRETS[0],
    CANVAS_WEATHER_ENTITY: 'weather.example',
    CANVAS_CALENDAR_ENTITY: 'calendar.example',
    CANVAS_PERSON_ENTITIES: 'person.example',
  });
  const source = new SnapshotSource(config, async (url) => {
    if (url.includes('weather.example')) throw new Error('upstream down');
    if (url.includes('calendars/')) {
      return {ok: true, status: 200, json: async () => ([
        {summary: 'School run', start: {dateTime: '2030-01-01T08:00:00Z'}, description: 'private'},
      ])};
    }
    return {ok: true, status: 200, json: async () => ({
      state: 'home', attributes: {friendly_name: 'Alex'},
    })};
  });
  const snap = await source.snapshot();
  assert.deepEqual(snap.degraded, ['weather']);
  assert.equal(snap.weather, null);
  assert.equal(snap.events.length, 1);
  assert.deepEqual(snap.peopleHome, ['Alex']);
  /* Household-private calendar fields must not be shaped into the response. */
  assert.ok(!JSON.stringify(snap).includes('private'));
});

test('an unset entity is skipped, not reported as degraded', async () => {
  const {config} = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.invalid:8123',
    HOMEASSISTANT_TOKEN: SECRETS[0],
  });
  let called = 0;
  const source = new SnapshotSource(config, async () => {
    called += 1;
    throw new Error('should not be called');
  });
  const snap = await source.snapshot();
  assert.equal(called, 0, 'an unset entity must not produce a request');
  assert.deepEqual(snap.degraded, []);
});

test('the snapshot never carries a credential', async () => {
  const {config} = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.invalid:8123',
    HOMEASSISTANT_TOKEN: SECRETS[0],
    UNSPLASH_ACCESS_KEY: SECRETS[1],
    CANVAS_WEATHER_ENTITY: 'weather.example',
  });
  const source = new SnapshotSource(config, async (url) => {
    if (url.includes('unsplash')) {
      return {ok: true, status: 200, json: async () => ({
        urls: {raw: 'https://images.example/photo?ixid=abc'},
        color: '#123456', blur_hash: 'LKO2', links: {download_location: 'https://api.example/dl'},
        user: {name: 'A Photographer', links: {html: 'https://unsplash.com/@a'}},
      })};
    }
    return {ok: true, status: 200, json: async () => ({
      state: 'sunny', attributes: {temperature: 21, temperature_unit: '°C', attribution: 'Met'},
    })};
  });
  const serialised = JSON.stringify(await source.snapshot());
  for (const secret of SECRETS) assert.ok(!serialised.includes(secret));
  assert.ok(serialised.includes('A Photographer'), 'attribution must survive');
  assert.ok(serialised.includes('ixid=abc'), 'the provider ixid must be preserved');
});

test('no household value is hardcoded in the server sources', async () => {
  /* This repository is heading for a public GitHub repo. A LAN address or a
   * person entity baked into a source file is both a privacy leak and an
   * instant non-starter for anyone else.
   *
   * The patterns are deliberately generic rather than naming this household's
   * actual entities: a leak detector that has to spell out the private value
   * publishes it, which is the bug it exists to prevent. Prefix matching also
   * catches entities nobody thought to enumerate. */
  const {readFile} = await import('node:fs/promises');
  const here = new URL('.', import.meta.url);
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a hardcoded person entity', /['"`]person\.\w/],
    ['a hardcoded calendar entity', /['"`]calendar\.\w/],
    ['a hardcoded weather entity', /['"`]weather\.\w/],
    ['a developer home directory', /\/home\/\w/],
  ];
  for (const file of ['server.ts', 'snapshot.ts', 'main.ts', 'config.ts', 'store.ts', 'api.ts']) {
    const text = await readFile(new URL(file, here), 'utf8');
    for (const [label, pattern] of forbidden) {
      const hit = pattern.exec(text);
      assert.equal(hit, null, `${file} contains ${label}: ${hit?.[0]}`);
    }
  }
});
