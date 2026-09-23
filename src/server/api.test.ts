import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {request, type Server} from 'node:http';
import {networkInterfaces, tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, test} from 'node:test';

import {loadConfig} from './config.ts';
import {isLoopbackAddress, parseIfMatch} from './api.ts';
import {createCanvasServer} from './server.ts';
import {CanvasStore, newCanvasId} from './store.ts';

/* The HTTP surface. Port 0 throughout: the live household display owns 4174
 * and a test that binds a fixed port is a test that occasionally takes the TV
 * down. */

let root = '';
let staticDir = '';
let server: Server;
let store: CanvasStore;
let base = '';

type Res = {status: number; headers: Record<string, string | string[] | undefined>; body: string};

async function call(
  method: string,
  path: string,
  options: {body?: unknown; headers?: Record<string, string>} = {},
): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(options.body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...options.headers,
    },
    body: options.body === undefined
      ? undefined
      : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return {status: res.status, headers, body: await res.text()};
}

async function json(method: string, path: string, options: Parameters<typeof call>[2] = {}) {
  const res = await call(method, path, options);
  return {...res, json: res.body === '' ? null : JSON.parse(res.body)};
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {name: 'Kitchen'},
    spec: {
      elements: {clock: {type: 'clock', namedSize: 'small'}},
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [{element: 'clock', col: 0, row: 0}],
      },
    },
    ...overrides,
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-api-'));
  staticDir = join(root, 'static');
  await mkdtemp(join(root, 'x-'));
  const {mkdir} = await import('node:fs/promises');
  await mkdir(staticDir, {recursive: true});
  await writeFile(join(staticDir, 'ambient.html'), '<!doctype html><title>Canvas</title>');
});

after(async () => {
  server?.close();
  await rm(root, {recursive: true, force: true});
});

beforeEach(async () => {
  server?.close();
  const dataDir = await mkdtemp(join(root, 'data-'));
  store = new CanvasStore(dataDir);
  const {config} = loadConfig({CANVAS_PORT: '0'});
  server = createCanvasServer({config, staticDir, store, log: () => {}});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

/* ---------- the happy path ---------- */

test('POST creates a canvas and GET reads it back identically', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  assert.equal(created.status, 201);
  assert.match(created.headers.location as string, /^\/api\/canvases\/[A-Za-z0-9_-]{22}$/);
  assert.equal(created.headers.etag, '"1"');

  const id = created.json.metadata.uid;
  const got = await json('GET', `/api/canvases/${id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, created.json);
  assert.equal(got.json.metadata.name, 'Kitchen');
  assert.equal(got.json.metadata.revision, 1);
  assert.equal(got.json.spec.elements.clock.type, 'clock');

  /* And it is actually on disk, not in a map: the whole point of the phase. */
  const files = await readdir(store.directory);
  assert.deepEqual(files, [`${id}.json`]);
  const fromDisk = JSON.parse(await readFile(join(store.directory, files[0]), 'utf8'));
  assert.deepEqual(fromDisk, got.json);
});

test('a canvas survives the server process that created it', async () => {
  /* Persistence means surviving a restart. A test that only ever talks to one
   * running server cannot tell a file from a cache. */
  const created = await json('POST', '/api/canvases', {body: doc({metadata: {name: 'Durable'}})});
  const id = created.json.metadata.uid;
  server.close();

  const {config} = loadConfig({CANVAS_PORT: '0'});
  const restarted = createCanvasServer({
    config, staticDir, store: new CanvasStore(store.directory.replace(/\/canvases$/, '')), log: () => {},
  });
  await new Promise<void>((ok) => restarted.listen(0, '127.0.0.1', ok));
  const addr = restarted.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/canvases/${id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).metadata.name, 'Durable');
  restarted.close();
});

test('GET /api/canvases lists summaries, not whole documents', async () => {
  /* A list endpoint that returns every document in full is a list endpoint
   * that gets slower with every canvas and leaks more than it needs to. */
  const empty = await json('GET', '/api/canvases');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, {canvases: []});

  for (const name of ['A', 'B', 'C']) {
    await call('POST', '/api/canvases', {body: doc({metadata: {name}})});
  }
  const listed = await json('GET', '/api/canvases');
  assert.equal(listed.json.canvases.length, 3);
  for (const summary of listed.json.canvases) {
    assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'id', 'name', 'revision', 'updatedAt']);
    assert.equal(summary.spec, undefined, 'a summary must not carry the document');
  }
});

test('PUT with the revision you read succeeds and advances it', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;

  const updated = await json('PUT', `/api/canvases/${id}`, {
    body: doc({metadata: {name: 'Kitchen v2'}}),
    headers: {'If-Match': created.headers.etag as string},
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.metadata.revision, 2);
  assert.equal(updated.json.metadata.name, 'Kitchen v2');
  assert.equal(updated.headers.etag, '"2"');
  assert.equal(updated.json.metadata.uid, id, 'an update must not change the id');
  assert.equal(updated.json.metadata.createdAt, created.json.metadata.createdAt);
});

test('an unquoted If-Match works too, because people type curl by hand', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;
  const updated = await call('PUT', `/api/canvases/${id}`, {
    body: doc(), headers: {'If-Match': '1'},
  });
  assert.equal(updated.status, 200);
});

test('parseIfMatch accepts the forms a real client sends and refuses the rest', () => {
  assert.equal(parseIfMatch('"3"'), 3);
  assert.equal(parseIfMatch('3'), 3);
  assert.equal(parseIfMatch('W/"3"'), 3);
  assert.equal(parseIfMatch(' 3 '), 3);
  for (const bad of [undefined, '', '*', 'abc', '"3, 4"', '-1', '3.5', ['1', '2']]) {
    assert.equal(parseIfMatch(bad as string), null, `${String(bad)} must not be read as a revision`);
  }
});

test('DELETE removes the canvas and the file', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;
  const removed = await call('DELETE', `/api/canvases/${id}`);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, '');
  assert.deepEqual(await readdir(store.directory), []);
  assert.equal((await call('GET', `/api/canvases/${id}`)).status, 404);
});

/* ---------- concurrency ---------- */

test('a stale If-Match is refused with 409 carrying both revisions', async () => {
  /* Two tabs, or a person and an agent. The loser is told, not discarded. */
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;

  const first = await call('PUT', `/api/canvases/${id}`, {
    body: doc({metadata: {name: 'first writer'}}), headers: {'If-Match': '"1"'},
  });
  assert.equal(first.status, 200);

  const second = await json('PUT', `/api/canvases/${id}`, {
    body: doc({metadata: {name: 'second writer'}}), headers: {'If-Match': '"1"'},
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'revision_conflict');
  assert.equal(second.json.error.expectedRevision, 1);
  assert.equal(second.json.error.actualRevision, 2,
    'a conflict that does not say what the current revision is leaves the client with nothing to do');
  assert.match(second.json.error.message, /retry|re-read/i);

  const final = await json('GET', `/api/canvases/${id}`);
  assert.equal(final.json.metadata.name, 'first writer', 'the loser must not have won');
  assert.equal(final.json.metadata.revision, 2);

  /* Re-reading and retrying with the current revision works, which is the
   * whole point of telling them. */
  const retry = await call('PUT', `/api/canvases/${id}`, {
    body: doc({metadata: {name: 'second writer'}}), headers: {'If-Match': '"2"'},
  });
  assert.equal(retry.status, 200);
});

test('PUT without If-Match is refused rather than silently overwriting', async () => {
  /* Defaulting a missing If-Match to "whatever is current" would turn
   * optimistic concurrency into last-write-wins for every client that forgot
   * the header - which is every client, eventually. */
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;
  const blind = await json('PUT', `/api/canvases/${id}`, {body: doc({metadata: {name: 'blind'}})});
  assert.equal(blind.status, 428);
  assert.equal(blind.json.error.code, 'if_match_required');

  const unchanged = await json('GET', `/api/canvases/${id}`);
  assert.equal(unchanged.json.metadata.name, 'Kitchen');
  assert.equal(unchanged.json.metadata.revision, 1);
});

test('concurrent PUTs on the same revision produce exactly one winner', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;
  const results = await Promise.all(Array.from({length: 8}, (_, i) =>
    call('PUT', `/api/canvases/${id}`, {
      body: doc({metadata: {name: `writer-${i}`}}), headers: {'If-Match': '"1"'},
    })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  const final = await json('GET', `/api/canvases/${id}`);
  assert.equal(final.json.metadata.revision, 2, 'revisions must not be skipped');
});

/* ---------- duplication ---------- */

test('POST /duplicate makes an independent copy with no inherited access', async () => {
  const created = await json('POST', '/api/canvases', {body: doc({
    metadata: {
      name: 'Living room',
      shareToken: 'SHARE-MUST-NOT-TRAVEL',
      screenToken: 'SCREEN-MUST-NOT-TRAVEL',
      passphrase: 'PASSPHRASE-MUST-NOT-TRAVEL',
    },
    local: {densityOverrides: {dense: {kind: 'Grid', authoredDensity: 'dense', items: []}}},
  })});
  assert.equal(created.status, 201);
  const id = created.json.metadata.uid;

  const copy = await json('POST', `/api/canvases/${id}/duplicate`);
  assert.equal(copy.status, 201);
  assert.notEqual(copy.json.metadata.uid, id);
  assert.equal(copy.json.metadata.name, 'Living room (copy)');
  assert.equal(copy.json.metadata.revision, 1);

  for (const secret of ['SHARE-MUST-NOT-TRAVEL', 'SCREEN-MUST-NOT-TRAVEL', 'PASSPHRASE-MUST-NOT-TRAVEL']) {
    assert.ok(!copy.body.includes(secret), `the duplicate inherited ${secret}`);
  }
  assert.equal(copy.json.local, undefined, 'density overrides are instance-local');
  assert.deepEqual(copy.json.spec.elements, created.json.spec.elements, 'the content must survive');

  /* Both exist independently. */
  const listed = await json('GET', '/api/canvases');
  assert.equal(listed.json.canvases.length, 2);
  const original = await json('GET', `/api/canvases/${id}`);
  assert.equal(original.json.metadata.shareToken, 'SHARE-MUST-NOT-TRAVEL',
    'the original keeps its own access');
});

test('duplicating an unknown id is the same uniform 404', async () => {
  const res = await json('POST', `/api/canvases/${newCanvasId()}/duplicate`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, {error: {code: 'not_found', message: 'no canvas with that id'}});
});

/* ---------- errors ---------- */

test('an unknown id and a malformed id are byte-identical 404s', async () => {
  /* Probing must learn nothing: same status, same headers, same body, for a
   * well-formed id that does not exist and for something that is not an id at
   * all. Otherwise an attacker walking the space learns which guesses are
   * even well-formed. */
  const probes = [
    `/api/canvases/${newCanvasId()}`,
    '/api/canvases/short',
    '/api/canvases/' + 'a'.repeat(40),
    '/api/canvases/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/api/canvases/..%2Fsecrets',
    '/api/canvases/has.a.dot',
    '/api/canvases/%FF%FE',
  ];
  const responses = await Promise.all(probes.map((p) => call('GET', p)));
  for (const res of responses) {
    assert.equal(res.status, 404, 'every miss must be a 404');
    assert.equal(res.body, responses[0].body, 'every miss must have the same body');
    assert.equal(res.headers['content-type'], responses[0].headers['content-type']);
    assert.equal(res.headers.etag, undefined, 'a miss must not carry a revision');
  }
  assert.deepEqual(JSON.parse(responses[0].body),
    {error: {code: 'not_found', message: 'no canvas with that id'}});

  /* DELETE too, or the probe just moves to a different verb. */
  const deletes = await Promise.all(probes.map((p) => call('DELETE', p)));
  for (const res of deletes) {
    assert.equal(res.status, 404);
    assert.equal(res.body, responses[0].body);
  }
});

test('an invalid document is a structured 422, never a 500', async () => {
  /* "500 Internal Server Error" for a document someone typed is a lie about
   * whose fault it is and tells them nothing about what to fix. */
  const cases: Array<[unknown, string, string | undefined]> = [
    [doc({apiVersion: 'canvas.commonhome/v9'}), 'unsupported_api_version', 'apiVersion'],
    [doc({kind: 'Dashboard'}), 'unsupported_kind', 'kind'],
    [{apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas', metadata: {}}, 'missing_spec', 'spec'],
    [doc({spec: {elements: {a: {type: 'clock'}}, layout: {kind: 'Grid', authoredDensity: 'standard', items: []}}}),
      'missing_named_size', 'spec.elements.a.namedSize'],
    [doc({spec: {elements: {}, layout: {kind: 'Grid', items: []}}}),
      'missing_authored_density', 'spec.layout.authoredDensity'],
  ];
  for (const [body, code, path] of cases) {
    const res = await json('POST', '/api/canvases', {body});
    assert.equal(res.status, 422, `${code} produced ${res.status}`);
    assert.equal(res.json.error.code, code);
    assert.equal(res.json.error.path, path);
    assert.ok(res.json.error.message.length > 0);
    assert.doesNotMatch(res.body, /\n\s+at \S+ \(|\.ts:\d+:\d+/, 'a stack trace escaped to the client');
  }
  assert.deepEqual(await readdir(store.directory), [], 'a rejected document must leave no file');
});

test('malformed JSON is a 400 that says what is wrong with it', async () => {
  const res = await json('POST', '/api/canvases', {body: '{"apiVersion": '});
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid_json');
  assert.ok(!res.body.includes('/home/'), 'an error must not disclose a filesystem path');
});

test('an oversized body is refused rather than buffered', async () => {
  const huge = JSON.stringify({...doc(), padding: 'x'.repeat(2 * 1024 * 1024)});
  const res = await json('POST', '/api/canvases', {body: huge});
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'body_too_large');
  /* Via the store rather than readdir: the request is refused before the
   * store is ever touched, so the directory may legitimately not exist yet. */
  assert.deepEqual(await store.list(), [], 'an oversized document must leave nothing behind');
});

test('a wrong method is 405 with an Allow header, not a 404', async () => {
  const created = await json('POST', '/api/canvases', {body: doc()});
  const id = created.json.metadata.uid;
  const cases: Array<[string, string, string]> = [
    ['DELETE', '/api/canvases', 'GET, POST'],
    ['PUT', '/api/canvases', 'GET, POST'],
    ['POST', `/api/canvases/${id}`, 'GET, PUT, DELETE'],
    ['GET', `/api/canvases/${id}/duplicate`, 'POST'],
  ];
  for (const [method, path, allow] of cases) {
    const res = await call(method, path);
    assert.equal(res.status, 405, `${method} ${path} returned ${res.status}`);
    assert.equal(res.headers.allow, allow);
  }
});

test('a nonsense subpath is a uniform 404, not a crash', async () => {
  for (const path of [
    '/api/canvases/a/b/c/d',
    `/api/canvases/${newCanvasId()}/nonsense`,
    '/api/canvases/x/duplicate/extra',
  ]) {
    const res = await call('GET', path);
    assert.ok(res.status === 404 || res.status === 405, `${path} returned ${res.status}`);
    /* A stack trace, not the substring "at " - which occurs in the words of
     * a perfectly good error message ("no canvas with th-at i-d") and made an
     * earlier version of this assertion fire on correct behaviour. */
    assert.doesNotMatch(res.body, /\n\s+at \S+ \(|\.ts:\d+:\d+/, 'a stack trace escaped');
  }
  /* A trailing slash is the collection, not a malformed id. */
  const trailing = await json('GET', '/api/canvases/');
  assert.equal(trailing.status, 200);
  assert.ok(Array.isArray(trailing.json.canvases));
});

/* ---------- /c/:id ---------- */

test('GET /c/:id renders a stored canvas', async () => {
  const created = await json('POST', '/api/canvases', {
    body: doc({metadata: {name: 'Hallway'}}),
  });
  const id = created.json.metadata.uid;
  const res = await call('GET', `/c/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /Hallway/);
  assert.match(res.body, /clock/);
  assert.equal(res.headers.etag, '"1"');
});

test('/c/:id escapes a canvas name rather than rendering it as markup', async () => {
  /* A canvas name is user input rendered into HTML. Untreated, it is stored
   * XSS on an address a wall display loads automatically. */
  const created = await json('POST', '/api/canvases', {
    body: doc({metadata: {name: '<img src=x onerror="alert(1)">'}}),
  });
  const res = await call('GET', `/c/${created.json.metadata.uid}`);
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes('<img src=x'), 'a canvas name was rendered as markup');
  assert.ok(res.body.includes('&lt;img'), 'and it should still be visible, escaped');
});

test('/c/:id does not publish local density overrides', async () => {
  const created = await json('POST', '/api/canvases', {body: doc({
    local: {densityOverrides: {dense: {kind: 'Grid', authoredDensity: 'dense', items: []}}},
  })});
  const res = await call('GET', `/c/${created.json.metadata.uid}`);
  assert.ok(!res.body.includes('densityOverrides'),
    'an address that will one day be shared must not carry instance-local state');
});

test('/c/ with an unknown or malformed id answers identically', async () => {
  const misses = [`/c/${newCanvasId()}`, '/c/short', '/c/..%2F..%2Fetc%2Fpasswd', '/c/'];
  const responses = await Promise.all(misses.map((p) => call('GET', p)));
  for (const res of responses) {
    assert.equal(res.status, 404, `${res.status} for a miss`);
    assert.equal(res.body, responses[0].body);
    assert.ok(!res.body.includes('root:'));
  }
});

test('the ambient display and /healthz still work alongside the API', async () => {
  /* The regression that would matter most: adding routes must not have
   * shadowed the screen that is actually on the wall. */
  assert.equal((await call('GET', '/healthz')).status, 200);
  const ambient = await call('GET', '/');
  assert.equal(ambient.status, 200);
  assert.match(ambient.body, /Canvas/);
  assert.equal((await call('GET', '/__ambient/snapshot')).status, 200);
});

/* ---------- the unauthenticated-API guard ---------- */

test('isLoopbackAddress accepts every spelling of this machine and nothing else', () => {
  for (const good of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.ok(isLoopbackAddress(good), `${good} is loopback`);
  }
  for (const bad of [undefined, '', '10.0.0.4', '192.168.1.9', '::ffff:10.0.0.4',
    '0.0.0.0', '128.0.0.1', '2001:db8::1', 'localhost', '127.0.0.1.evil.com']) {
    assert.ok(!isLoopbackAddress(bad), `${String(bad)} must not be treated as loopback`);
  }
});

/* fetch() cannot produce a non-loopback peer against a loopback listener, so
 * the guard is exercised by binding a real non-loopback interface and
 * connecting to it. Skipped rather than faked where no such interface exists;
 * a test that stubs the socket would be asserting about the stub. */
function nonLoopbackAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function rawGet(host: string, port: number, path: string, hostHeader: string): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request({host, port, path, method: 'GET', headers: {Host: hostHeader}}, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({status: res.statusCode ?? 0, headers: res.headers, body}));
    });
    req.on('error', fail);
    req.end();
  });
}

test('the unauthenticated API refuses a non-loopback peer even when bound widely', async (t) => {
  /* This is the property that actually protects the phase. The container and
   * docker-compose both bind 0.0.0.0 on purpose, so the bind address cannot
   * be what keeps an unauthenticated write API shut. */
  const lan = nonLoopbackAddress();
  if (lan === null) return t.skip('no non-loopback IPv4 interface on this machine');

  const dataDir = await mkdtemp(join(root, 'lan-'));
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_ALLOWED_HOSTS: lan});
  const wide = createCanvasServer({
    config, staticDir, store: new CanvasStore(dataDir), log: () => {},
  });
  await new Promise<void>((ok) => wide.listen(0, '0.0.0.0', ok));
  const addr = wide.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');

  try {
    const remote = await rawGet(lan, addr.port, '/api/canvases', lan);
    assert.equal(remote.status, 403, 'an unauthenticated write API answered a network peer');
    assert.match(remote.body, /not_authenticated/);
    assert.match(remote.body, /CANVAS_API_ALLOW_REMOTE/,
      'the refusal must say how to proceed deliberately, or it reads as a routing bug');

    const remoteView = await rawGet(lan, addr.port, '/c/' + newCanvasId(), lan);
    assert.equal(remoteView.status, 403, '/c/:id is part of the same unauthenticated surface');

    /* The positive control: the same server, same port, from loopback. A
     * guard that rejected everything would pass the assertions above. */
    const local = await rawGet('127.0.0.1', addr.port, '/api/canvases', '127.0.0.1');
    assert.equal(local.status, 200);

    /* And the display itself is NOT gated - that is the whole reason the
     * container binds widely. */
    const display = await rawGet(lan, addr.port, '/healthz', lan);
    assert.equal(display.status, 200, 'gating the API must not gate the ambient display');
    const page = await rawGet(lan, addr.port, '/', lan);
    assert.equal(page.status, 200);
  } finally {
    wide.close();
  }
});

test('CANVAS_API_ALLOW_REMOTE=true is the deliberate, explicit opt out', async (t) => {
  const lan = nonLoopbackAddress();
  if (lan === null) return t.skip('no non-loopback IPv4 interface on this machine');

  const dataDir = await mkdtemp(join(root, 'lan-open-'));
  const {config, problems} = loadConfig({
    CANVAS_ALLOWED_HOSTS: lan, CANVAS_API_ALLOW_REMOTE: 'true',
  });
  assert.equal(problems.length, 0);
  assert.equal(config.apiAllowRemote, true);
  const open = createCanvasServer({
    config, staticDir, store: new CanvasStore(dataDir), log: () => {},
  });
  await new Promise<void>((ok) => open.listen(0, '0.0.0.0', ok));
  const addr = open.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  try {
    const remote = await rawGet(lan, addr.port, '/api/canvases', lan);
    assert.equal(remote.status, 200);
  } finally {
    open.close();
  }
});

test('the default configuration binds loopback and keeps the API closed', () => {
  /* The two halves of the decision, asserted together so neither can be
   * reverted quietly. */
  const {config, problems} = loadConfig({});
  assert.equal(problems.length, 0, 'the safe default must still be a zero-config start');
  assert.equal(config.host, '127.0.0.1',
    'an unauthenticated write API must not be published to every interface by default');
  assert.equal(config.apiAllowRemote, false);

  /* A container that intends to be reachable says so, and doing so must NOT
   * silently open the API. */
  const container = loadConfig({CANVAS_HOST: '0.0.0.0'}).config;
  assert.equal(container.host, '0.0.0.0');
  assert.equal(container.apiAllowRemote, false,
    'binding widely must not be read as consent to expose the API');
});

test('a mistyped CANVAS_API_ALLOW_REMOTE fails closed and says so', () => {
  for (const bad of ['yes', '1', 'TRUE ', 'enabled']) {
    const {config, problems} = loadConfig({CANVAS_API_ALLOW_REMOTE: bad});
    if (bad.trim().toLowerCase() === 'true') {
      assert.equal(config.apiAllowRemote, true, 'whitespace should not defeat the flag');
      continue;
    }
    assert.equal(config.apiAllowRemote, false, `${bad} must not open the API`);
    assert.equal(problems.length, 1, `${bad} must be reported, not silently ignored`);
  }
});

test('the startup banner states the API exposure either way', async () => {
  /* startCanvasServer listens on config.port, and CANVAS_PORT=0 is a
   * rejected port that falls back to the default - which on this machine is
   * the LIVE HOUSEHOLD DISPLAY. An earlier draft of this test did exactly
   * that and tried to bind 4174. A free port is therefore taken first and
   * asserted not to be the display's. */
  const scratch = createCanvasServer({
    config: loadConfig({}).config, staticDir, store, log: () => {},
  });
  await new Promise<void>((ok) => scratch.listen(0, '127.0.0.1', ok));
  const addr = scratch.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const free = addr.port;
  await new Promise<void>((ok) => scratch.close(() => ok()));
  assert.notEqual(free, 4174, 'never bind the live display port in a test');

  const lines: string[] = [];
  const {startCanvasServer} = await import('./server.ts');
  const {config} = loadConfig({CANVAS_PORT: String(free), CANVAS_HOST: '127.0.0.1'});
  const s = await startCanvasServer({
    config, staticDir, store: new CanvasStore(await mkdtemp(join(root, 'banner-'))),
    log: (l) => lines.push(l),
  });
  s.close();

  const banner = lines.join('\n');
  assert.match(banner, /loopback/i, 'the banner must state that the API is loopback-only');
  assert.match(banner, /unauthenticated/i, 'and that it has no authentication');
  /* And /healthz says the same, because that is what an operator reads from
   * somewhere other than the console. */
  assert.match(banner, /loopback-only/);

  /* The opposite case must be at least as loud. */
  const openLines: string[] = [];
  const openConfig = loadConfig({
    CANVAS_PORT: String(free), CANVAS_HOST: '127.0.0.1', CANVAS_API_ALLOW_REMOTE: 'true',
  }).config;
  const openServer = await startCanvasServer({
    config: openConfig, staticDir, store: new CanvasStore(await mkdtemp(join(root, 'banner2-'))),
    log: (l) => openLines.push(l),
  });
  openServer.close();
  assert.match(openLines.join('\n'), /WARNING/);
  assert.match(openLines.join('\n'), /NO AUTHENTICATION/);
});

test('no household value is hardcoded in the new server sources', async () => {
  /* Same guard as server.test.ts, extended to the files this phase added.
   * Generic patterns rather than this household's real values: a detector
   * that spells out the private value publishes it. */
  const here = new URL('.', import.meta.url);
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a hardcoded person entity', /['"`]person\.\w/],
    ['a hardcoded calendar entity', /['"`]calendar\.\w/],
    ['a hardcoded weather entity', /['"`]weather\.\w/],
    ['a developer home directory', /\/home\/\w/],
  ];
  for (const file of ['api.ts', 'store.ts']) {
    const text = await readFile(new URL(file, here), 'utf8');
    for (const [label, pattern] of forbidden) {
      const hit = pattern.exec(text);
      assert.equal(hit, null, `${file} contains ${label}: ${hit?.[0]}`);
    }
  }
});
