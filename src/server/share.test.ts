import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {request, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, test} from 'node:test';

import {AccessStore} from './access.ts';
import {loadConfig} from './config.ts';
import {createCanvasServer} from './server.ts';
import {
  LOCKED_PAGE,
  SHARE_NOT_FOUND_BODY,
  buildSessionCookie,
  extractPassphrase,
  parseCookies,
  sessionCookieName,
} from './share.ts';
import {CanvasStore, newCanvasId} from './store.ts';

/* `/s/<token>` over real HTTP.
 *
 * Every assertion about locking is made on the SERIALISED RESPONSE BODY, never
 * on an object property. The rule this phase exists to enforce is that a
 * locked response must not CONTAIN the canvas, and only the bytes can say
 * whether it does.
 *
 * Port 0 throughout: the live household display owns 4174 and a test that
 * binds a fixed port is a test that occasionally takes the TV down.
 */

let root = '';
let staticDir = '';
let server: Server;
let store: CanvasStore;
let access: AccessStore;
let base = '';

/* Invented strings, deliberately distinctive, so an assertion on bytes is
 * unambiguous about what leaked. */
const ELEMENT_KEY = 'MEALPLAN_ELEMENT_MUST_NOT_LEAK';
const EVENT_TITLE = 'CALENDAR_EVENT_MUST_NOT_LEAK';
const CANVAS_NAME = 'NAME_MUST_NOT_LEAK';
const PASSPHRASE = 'cobalt heron willow drift';

type Res = {status: number; headers: Record<string, string | string[] | undefined>; body: string; raw: string};

/* node:http rather than fetch, because a raw response is needed: header ORDER
 * and the exact bytes matter to the byte-identical-404 assertion, and fetch
 * normalises both away. */
function call(
  method: string,
  path: string,
  options: {body?: string; headers?: Record<string, string>} = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {Host: url.host, ...options.headers},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          /* rawHeaders preserves order and case, which is what "byte-identical"
           * has to mean for a response. `Date` is normalised out and ONLY
           * `Date`: it changes every second by definition, so leaving it in
           * would make the comparison flaky rather than strict, while every
           * other header - including order - is compared exactly. */
          const headers = [...res.rawHeaders];
          for (let i = 0; i < headers.length; i += 2) {
            if (headers[i].toLowerCase() === 'date') headers[i + 1] = '<normalised>';
          }
          const raw = `${res.statusCode}\n${headers.join('\n')}\n\n${body}`;
          resolve({status: res.statusCode ?? 0, headers: res.headers, body, raw});
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function form(passphrase: string): {body: string; headers: Record<string, string>} {
  const body = new URLSearchParams({passphrase}).toString();
  return {
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
  };
}

async function makeCanvas(): Promise<string> {
  const created = await store.create({
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {name: CANVAS_NAME},
    spec: {
      elements: {
        [ELEMENT_KEY]: {type: 'calendar', namedSize: 'wide', events: [{title: EVENT_TITLE}]},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [{element: ELEMENT_KEY, col: 0, row: 0}],
      },
    },
  });
  assert.ok(created.ok, 'fixture canvas must be creatable');
  return created.value.metadata.uid;
}

/* Everything a locked response is forbidden to contain. */
const CANVAS_DATA = [ELEMENT_KEY, EVENT_TITLE, CANVAS_NAME, 'calendar', 'namedSize', 'authoredDensity', 'Grid'];

function assertNoCanvasData(res: Res, label: string): void {
  for (const needle of CANVAS_DATA) {
    assert.equal(
      res.raw.includes(needle), false,
      `${label}: the response contains canvas data (${needle}) — enforcement is happening after production`,
    );
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-share-'));
  staticDir = join(root, 'static');
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
  access = new AccessStore(dataDir);
  await store.init();
  await access.init();
  const {config} = loadConfig({CANVAS_PORT: '0'});
  server = createCanvasServer({config, staticDir, store, access, log: () => {}});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

/* ============================== the central rule ========================== */

test('a locked /s/<token> body contains no element, no layout and no calendar data', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const locked = await call('GET', `/s/${token}`);
  assert.equal(locked.status, 401);
  assertNoCanvasData(locked, 'GET with no session');

  /* Not even the id or the revision, which would identify the canvas to
   * somebody who already holds an id from elsewhere. */
  assert.equal(locked.body.includes(id), false, 'the canvas id is in the locked page');
  assert.equal(locked.raw.includes(token), false, 'the token is echoed into the locked response');

  /* And a wrong POST is the same. */
  const wrong = await call('POST', `/s/${token}`, form('not the passphrase'));
  assertNoCanvasData(wrong, 'POST with the wrong passphrase');

  /* Positive control: the data IS there once unlocked, so this test cannot
   * pass by the fixture being empty. */
  const right = await call('POST', `/s/${token}`, form(PASSPHRASE));
  assert.equal(right.status, 200);
  for (const needle of [ELEMENT_KEY, EVENT_TITLE, CANVAS_NAME]) {
    assert.ok(right.body.includes(needle), `the unlocked page should contain ${needle}`);
  }
});

test('a wrong passphrase is byte-identical to having no session at all', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const noSession = await call('GET', `/s/${token}`);
  const wrong = await call('POST', `/s/${token}`, form('wrong entirely'));
  /* A near-miss too: an attacker must not learn they are close. */
  const nearMiss = await call('POST', `/s/${token}`, form(PASSPHRASE + 'x'));

  assert.equal(noSession.status, wrong.status);
  assert.equal(noSession.status, nearMiss.status);
  assert.equal(noSession.body, wrong.body, 'a wrong passphrase is a distinguishable answer');
  assert.equal(noSession.body, nearMiss.body);
  assert.equal(wrong.body, LOCKED_PAGE);
  assert.equal(wrong.headers['set-cookie'], undefined, 'a failed unlock must not set a cookie');
});

test('unknown, revoked and malformed tokens produce byte-identical 404s', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'link'});
  assert.ok(set.ok);
  const revoked = set.record.shareToken!;
  await access.rotate(id);

  const responses: Array<[string, Res]> = [];
  responses.push(['unknown', await call('GET', '/s/' + 'A'.repeat(43))]);
  responses.push(['revoked', await call('GET', `/s/${revoked}`)]);
  responses.push(['malformed: too short', await call('GET', '/s/abc')]);
  responses.push(['malformed: too long', await call('GET', '/s/' + 'A'.repeat(44))]);
  responses.push(['malformed: bad characters', await call('GET', '/s/' + 'A'.repeat(42) + '%2F')]);
  responses.push(['malformed: traversal', await call('GET', '/s/' + '..%2F'.repeat(8))]);
  responses.push(['empty', await call('GET', '/s/')]);
  responses.push(['too many segments', await call('GET', `/s/${revoked}/extra`)]);
  /* A private canvas's former existence must not be detectable either. */
  const other = await makeCanvas();
  const priv = await access.set(other, {level: 'link'});
  assert.ok(priv.ok);
  const wasShared = priv.record.shareToken!;
  await access.set(other, {level: 'private'});
  responses.push(['made private', await call('GET', `/s/${wasShared}`)]);

  const [, first] = responses[0];
  for (const [label, res] of responses) {
    assert.equal(res.status, 404, `${label} returned ${res.status}`);
    assert.equal(res.body, SHARE_NOT_FOUND_BODY, `${label} has a different body`);
    /* Byte-identical means the whole response head too: same headers, same
     * order, same values. Anything that differs is an oracle. */
    assert.equal(res.raw, first.raw, `${label} is distinguishable from an unknown token`);
  }
});

test('a HEAD of a locked canvas leaks nothing either', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const head = await call('HEAD', `/s/${set.record.shareToken}`);
  assert.equal(head.status, 401);
  assert.equal(head.body, '');
  assertNoCanvasData(head, 'HEAD with no session');
  /* Specifically: no ETag, which would publish the revision number of a
   * canvas the caller has not unlocked. */
  assert.equal(head.headers.etag, undefined, 'a locked HEAD published the canvas revision');
});

/* ================================ behaviour table ======================== */

test('level link renders for anyone holding the token, with no passphrase', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'link'});
  assert.ok(set.ok);
  const res = await call('GET', `/s/${set.record.shareToken}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(ELEMENT_KEY));
  assert.equal(res.headers['set-cookie'], undefined, 'a link-level canvas needs no session');
});

test('a private canvas is a 404 at /s/, and never has a token to begin with', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'private'});
  assert.ok(set.ok);
  assert.equal(set.record.shareToken, null);
  /* Nothing to guess: there is no token. Every guess is the uniform miss. */
  const res = await call('GET', '/s/' + 'B'.repeat(43));
  assert.equal(res.status, 404);
  assert.equal(res.body, SHARE_NOT_FOUND_BODY);
});

test('a valid session renders; the cookie is HttpOnly, SameSite=Lax and canvas-scoped', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const unlocked = await call('POST', `/s/${token}`, form(PASSPHRASE));
  assert.equal(unlocked.status, 200);
  const cookie = ([] as string[]).concat(unlocked.headers['set-cookie'] as string[])[0];
  assert.ok(cookie, 'a correct passphrase must set a session cookie');
  assert.ok(cookie.includes('HttpOnly'), 'the cookie must be HttpOnly');
  assert.ok(cookie.includes('SameSite=Lax'));
  assert.ok(cookie.includes(`Path=/s/${token}`), 'the cookie must be scoped to this link, not the site');
  assert.ok(cookie.startsWith(`${sessionCookieName(id)}=`), 'the cookie must be named for this canvas');
  /* Plain http request: Secure would make the browser silently drop it. */
  assert.equal(cookie.includes('Secure'), false, 'Secure on a plain-http request breaks the unlock silently');

  /* The cookie value is a random session id, not the passphrase or a hash. */
  const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
  assert.notEqual(value, PASSPHRASE);
  const {createHash} = await import('node:crypto');
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const digest = createHash(algorithm).update(PASSPHRASE).digest();
    assert.notEqual(value, digest.toString('hex'));
    assert.notEqual(value, digest.toString('base64url'));
  }
  assert.notEqual(value, set.record.credentials[0].hash);

  /* Re-fetch with the cookie: rendered, no second prompt. */
  const withCookie = await call('GET', `/s/${token}`, {headers: {Cookie: `${sessionCookieName(id)}=${value}`}});
  assert.equal(withCookie.status, 200);
  assert.ok(withCookie.body.includes(ELEMENT_KEY));

  /* A forged session id is not a session. */
  const forged = await call('GET', `/s/${token}`, {headers: {Cookie: `${sessionCookieName(id)}=forged`}});
  assert.equal(forged.status, 401);
  assertNoCanvasData(forged, 'forged cookie');
});

test('a session for one canvas does not unlock another', async () => {
  const photos = await makeCanvas();
  const finances = await makeCanvas();
  const a = await access.set(photos, {level: 'passphrase', passphrase: 'photos phrase'});
  const b = await access.set(finances, {level: 'passphrase', passphrase: 'finances phrase'});
  assert.ok(a.ok && b.ok);

  const unlocked = await call('POST', `/s/${a.record.shareToken}`, form('photos phrase'));
  assert.equal(unlocked.status, 200);
  const cookie = ([] as string[]).concat(unlocked.headers['set-cookie'] as string[])[0];
  const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));

  /* Sent under the other canvas's cookie name AND under its own name, because
   * a browser that ignored Path would send both. */
  for (const name of [sessionCookieName(finances), sessionCookieName(photos)]) {
    const res = await call('GET', `/s/${b.record.shareToken}`, {headers: {Cookie: `${name}=${value}`}});
    assert.equal(res.status, 401, `a session opened another canvas via cookie ${name}`);
    assertNoCanvasData(res, `cross-canvas session via ${name}`);
  }
});

/* ================================= headers =============================== */

test('every /s/ response is noindex, nofollow and no-referrer, including the 404', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const cases: Array<[string, Res]> = [
    ['rendered', await call('GET', `/s/${(await access.set(await makeCanvas(), {level: 'link'}) as {ok: true; record: {shareToken: string}}).record.shareToken}`)],
    ['locked', await call('GET', `/s/${token}`)],
    ['not found', await call('GET', '/s/' + 'C'.repeat(43))],
  ];
  for (const [label, res] of cases) {
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', `${label} is indexable`);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', `${label} leaks a Referer`);
    assert.ok(String(res.headers['cache-control']).includes('no-store'), `${label} is cacheable`);
  }
});

/* ================================ rotation =============================== */

test('rotation kills the old token and the sessions it granted, immediately', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const oldToken = set.record.shareToken!;

  const unlocked = await call('POST', `/s/${oldToken}`, form(PASSPHRASE));
  assert.equal(unlocked.status, 200);
  const cookie = ([] as string[]).concat(unlocked.headers['set-cookie'] as string[])[0];
  const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
  const cookieHeader = {Cookie: `${sessionCookieName(id)}=${value}`};

  /* Still working, so the negative below means something. */
  assert.equal((await call('GET', `/s/${oldToken}`, {headers: cookieHeader})).status, 200);

  const rotated = await access.rotate(id);
  assert.ok(rotated);
  const newToken = rotated.shareToken!;
  assert.notEqual(newToken, oldToken);

  /* The old link is the uniform 404 - not a 401, which would confirm it once
   * existed. */
  const dead = await call('GET', `/s/${oldToken}`, {headers: cookieHeader});
  assert.equal(dead.status, 404);
  assert.equal(dead.body, SHARE_NOT_FOUND_BODY);
  assertNoCanvasData(dead, 'rotated-away token with a live cookie');

  /* And the session is dead on the NEW link too, or rotation would only have
   * changed the URL. */
  const stillLocked = await call('GET', `/s/${newToken}`, {headers: cookieHeader});
  assert.equal(stillLocked.status, 401);
  assertNoCanvasData(stillLocked, 'old session against the new token');

  /* The new link works with the same passphrase. */
  assert.equal((await call('POST', `/s/${newToken}`, form(PASSPHRASE))).status, 200);
});

/* ============================ rate limiting ============================== */

test('repeated wrong passphrases are made progressively slower', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const timings: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = Date.now();
    const res = await call('POST', `/s/${token}`, form('guess ' + i));
    timings.push(Date.now() - started);
    assert.equal(res.status, 401);
    assert.equal(res.body, LOCKED_PAGE, 'a throttled answer must not be distinguishable');
  }
  /* The last attempt must be materially slower than the first: an unthrottled
   * online attack walks a four-word household passphrase quickly. */
  assert.ok(timings.at(-1)! > timings[0] + 400,
    `attempts did not slow down: ${timings.join(', ')}ms`);
});

/* ========================= the /api/canvases/:id/access surface =========== */

test('the access API sets a level, reports the link, and never reports a hash', async () => {
  const id = await makeCanvas();
  const put = await call('PUT', `/api/canvases/${id}/access`, {
    body: JSON.stringify({level: 'passphrase', passphrase: PASSPHRASE, sessionTimeout: 7}),
    headers: {'Content-Type': 'application/json'},
  });
  assert.equal(put.status, 200);
  const described = JSON.parse(put.body).access;
  assert.equal(described.level, 'passphrase');
  assert.equal(described.hasPassphrase, true);
  assert.deepEqual(described.sessionTimeout, {kind: 'days', days: 7});
  assert.ok(described.shareToken);
  assert.equal(described.sharePath, `/s/${described.shareToken}`);

  const record = (await access.read(id))!;
  assert.equal(put.body.includes(record.credentials[0].hash), false, 'the API reported a hash');
  assert.equal(put.body.includes(record.credentials[0].salt), false, 'the API reported a salt');
  assert.equal(put.body.includes(PASSPHRASE), false, 'the API echoed the passphrase');

  /* The link really works. */
  assert.equal((await call('POST', described.sharePath, form(PASSPHRASE))).status, 200);

  /* The non-secret level label is mirrored onto the document for display. */
  const doc = JSON.parse((await call('GET', `/api/canvases/${id}`)).body);
  assert.equal(doc.metadata.accessLevel, 'passphrase');
  assert.equal(doc.metadata.shareToken, undefined, 'the token must not reach the document');
});

test('the access API refuses a level it does not know and a passphrase level with no passphrase', async () => {
  const id = await makeCanvas();
  for (const body of [
    {level: 'public'},
    {level: 'passphrase'},
    {level: 'link', sessionTimeout: 'forever'},
  ]) {
    const res = await call('PUT', `/api/canvases/${id}/access`, {
      body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json'},
    });
    assert.equal(res.status, 422, `${JSON.stringify(body)} returned ${res.status}`);
  }
});

test('access routes on an unknown id are the same uniform 404 as everything else', async () => {
  const unknown = newCanvasId();
  for (const [method, path] of [
    ['GET', `/api/canvases/${unknown}/access`],
    ['DELETE', `/api/canvases/${unknown}/access`],
    ['POST', `/api/canvases/${unknown}/access/rotate`],
    ['GET', '/api/canvases/not-an-id/access'],
    ['POST', '/api/canvases/not-an-id/access/rotate'],
  ] as const) {
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path} returned ${res.status}`);
    assert.deepEqual(JSON.parse(res.body), {error: {code: 'not_found', message: 'no canvas with that id'}});
  }
});

test('deleting a canvas takes its share link with it', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'link'});
  assert.ok(set.ok);
  const token = set.record.shareToken!;
  assert.equal((await call('GET', `/s/${token}`)).status, 200);

  assert.equal((await call('DELETE', `/api/canvases/${id}`)).status, 204);
  const dead = await call('GET', `/s/${token}`);
  assert.equal(dead.status, 404);
  assert.equal(dead.body, SHARE_NOT_FOUND_BODY);
});

test('a duplicate of a protected canvas is unprotected and unreachable by the original token', async () => {
  const id = await makeCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: PASSPHRASE});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const copy = JSON.parse((await call('POST', `/api/canvases/${id}/duplicate`)).body);
  const copyId = copy.metadata.uid;
  assert.notEqual(copyId, id);

  /* Unprotected: no sidecar, no level label claiming a protection it lacks. */
  const copyAccess = JSON.parse((await call('GET', `/api/canvases/${copyId}/access`)).body).access;
  assert.equal(copyAccess.level, 'private');
  assert.equal(copyAccess.shareToken, null);
  assert.equal(copy.metadata.accessLevel, undefined,
    'a duplicate must not carry a level label it cannot honour');

  /* Unreachable by the original token: the token still points at the
   * ORIGINAL. A copy that took over the original's link is the hijack
   * screens-and-fleet.md §5 calls the most dangerous possible behaviour. */
  const viaOldToken = await call('POST', `/s/${token}`, form(PASSPHRASE));
  assert.equal(viaOldToken.status, 200);
  const doc = JSON.parse((await call('GET', `/api/canvases/${id}`)).body);
  assert.ok(viaOldToken.body.includes(doc.metadata.uid));
  assert.equal(viaOldToken.body.includes(copyId), false, 'the original token served the duplicate');

  /* And the copy has no link of its own to be found at. */
  assert.equal(copy.metadata.shareToken, undefined);
});

/* ============================== unit corners ============================= */

test('cookies are parsed without a dependency, including the awkward spellings', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), {a: '1', b: '2'});
  assert.deepEqual(parseCookies('  a = 1 ;b=2;'), {a: '1', b: '2'});
  assert.deepEqual(parseCookies('a="quoted"'), {a: 'quoted'});
  assert.deepEqual(parseCookies('a=1; a=2'), {a: '1'}, 'the first value wins, as browsers send most-specific first');
  assert.deepEqual(parseCookies('novalue; a=1'), {a: '1'});
  assert.deepEqual(parseCookies('=orphan; a=1'), {a: '1'});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(['a=1', 'b=2']), {a: '1', b: '2'});
  /* A base64url session id contains '-' and '_' and must survive intact. */
  assert.deepEqual(parseCookies('s=aB-_cD=='), {s: 'aB-_cD=='});
});

test('"no timeout" means a session cookie, not an immortal one', () => {
  const sessionScoped = buildSessionCookie({
    canvasId: 'a'.repeat(22), token: 'b'.repeat(43), sessionId: 'sid', expiresAt: null, secure: false,
  });
  assert.equal(sessionScoped.includes('Expires'), false,
    'a cookie with no expiry is a session cookie; an explicit far-future date is unrevocable');
  assert.equal(sessionScoped.includes('Max-Age'), false);

  const dated = buildSessionCookie({
    canvasId: 'a'.repeat(22), token: 'b'.repeat(43), sessionId: 'sid',
    expiresAt: new Date(Date.now() + 86_400_000), secure: true,
  });
  assert.ok(dated.includes('Expires='));
  assert.ok(dated.includes('Max-Age='));
  assert.ok(dated.includes('Secure'), 'a TLS request must get a Secure cookie');
});

test('a passphrase is read from a form post and from JSON, and from nothing else', () => {
  assert.equal(extractPassphrase('application/x-www-form-urlencoded', 'passphrase=a+b%20c'), 'a b c');
  assert.equal(extractPassphrase('application/json', '{"passphrase":"a b c"}'), 'a b c');
  assert.equal(extractPassphrase('application/json; charset=utf-8', '{"passphrase":"x"}'), 'x');
  assert.equal(extractPassphrase('application/json', 'not json'), null);
  assert.equal(extractPassphrase('application/json', '{"passphrase":42}'), null);
  assert.equal(extractPassphrase(undefined, 'other=1'), null);
});
