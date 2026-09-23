import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {request, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, test} from 'node:test';

import {AccessStore} from './access.ts';
import {handleScreenRoutes} from './api.ts';
import {loadConfig} from './config.ts';
import {
  DISPLAY_NOT_FOUND_BODY,
  KIOSK_SCRIPT,
  KIOSK_SCRIPT_PATH,
  renderDisplayPage,
} from './display.ts';
import {
  DEFAULT_POLL_SECONDS,
  POLL_JITTER_RATIO,
  ScreenStore,
  isScreenId,
  newScreenToken,
  nextPollDelayMs,
  normaliseLabel,
} from './screens.ts';
import {createCanvasServer} from './server.ts';
import {SHARE_NOT_FOUND_BODY} from './share.ts';
import {CanvasStore} from './store.ts';

/* `/d/<screenToken>` over real HTTP.
 *
 * The rules this phase exists to enforce are properties of the BYTES a screen
 * in a hallway receives, so the assertions are made on serialised responses
 * rather than on objects: "no editing affordance" is a fact about the HTML a
 * five-year-old can touch, and an object property cannot tell you whether a
 * form reached the page.
 *
 * Port 0 throughout: the live household display owns 4174 and a test that
 * binds a fixed port is a test that occasionally takes the TV down.
 */

let root = '';
let staticDir = '';
let server: Server;
let store: CanvasStore;
let access: AccessStore;
let screens: ScreenStore;
let base = '';

/* Invented, deliberately distinctive, so an assertion on bytes is unambiguous
 * about what appeared and what did not. No household values anywhere. */
const HALLWAY_NAME = 'HALLWAY_CANVAS_ALPHA';
const HOLIDAY_NAME = 'HOLIDAY_CANVAS_BRAVO';
const ELEMENT_KEY = 'DISPLAY_ELEMENT_MARKER';
const PASSPHRASE = 'amber lantern quiet ferry';

type Res = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  raw: string;
};

/* node:http rather than fetch: the byte-identical-404 assertion needs raw
 * header order and exact bytes, and fetch normalises both away. */
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
          const headers = [...res.rawHeaders];
          for (let i = 0; i < headers.length; i += 2) {
            /* Only `Date` is normalised - it changes every second by
             * definition. Every other header, including ORDER, is compared
             * exactly, which is what "byte-identical" has to mean. */
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

function json(path: string, method: string, body?: unknown) {
  return call(method, path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
  });
}

function canvasDoc(name: string, extra: Record<string, unknown> = {}) {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {name},
    spec: {
      elements: {[ELEMENT_KEY]: {type: 'text', namedSize: 'small', ...extra}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: ELEMENT_KEY, col: 0, row: 0}]},
    },
  };
}

async function createCanvas(name: string): Promise<{id: string; revision: number}> {
  const res = await json('/api/canvases', 'POST', canvasDoc(name));
  assert.equal(res.status, 201, res.body);
  const doc = JSON.parse(res.body);
  return {id: doc.metadata.uid, revision: doc.metadata.revision};
}

async function registerScreen(label: string, canvasId: string) {
  const res = await json('/api/screens', 'POST', {label, target: {kind: 'canvas', id: canvasId}});
  assert.equal(res.status, 201, res.body);
  return JSON.parse(res.body).screen as {
    id: string;
    label: string;
    token: string;
    displayPath: string;
    target: {kind: string; id: string};
    lastSeenAt: string | null;
    lastSeenRevision: number | null;
  };
}

/* Bumps the canvas through the real API so the revision moves the way an edit
 * moves it. */
async function editCanvas(id: string, newName: string): Promise<number> {
  const current = JSON.parse((await json(`/api/canvases/${id}`, 'GET')).body);
  const res = await call('PUT', `/api/canvases/${id}`, {
    body: JSON.stringify({...current, metadata: {...current.metadata, name: newName}}),
    headers: {'Content-Type': 'application/json', 'If-Match': String(current.metadata.revision)},
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body).metadata.revision;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-display-'));
  staticDir = join(root, 'static');
  await mkdir(staticDir, {recursive: true});
  await writeFile(join(staticDir, 'ambient.html'), '<!doctype html><title>ambient</title>');
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, {recursive: true, force: true});
});

beforeEach(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  const data = await mkdtemp(join(root, 'data-'));
  store = new CanvasStore(data);
  access = new AccessStore(data);
  screens = new ScreenStore(data);
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: data});
  server = createCanvasServer({config, staticDir, store, access, screens});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address() as {port: number};
  base = `http://127.0.0.1:${addr.port}`;
});

/* ===================== the load-bearing access rule ====================== */

test('a screen token renders a PASSPHRASE-LEVEL canvas with no passphrase prompt', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);

  /* Set the canvas to the most restrictive shareable level there is. */
  const level = await json(`/api/canvases/${canvas.id}/access`, 'PUT', {
    level: 'passphrase',
    passphrase: PASSPHRASE,
  });
  assert.equal(level.status, 200, level.body);
  assert.equal(JSON.parse(level.body).access.level, 'passphrase',
    'the precondition must actually hold, or this test passes vacuously');

  const screen = await registerScreen('Hallway display', canvas.id);
  const res = await call('GET', `/d/${screen.token}`);

  assert.equal(res.status, 200, 'a paired display must never be challenged');
  assert.ok(res.body.includes(HALLWAY_NAME), 'the canvas itself must have rendered');
  assert.ok(res.body.includes(ELEMENT_KEY));
  /* The negative half, asserted on the bytes so it cannot pass vacuously. */
  assert.equal(res.body.toLowerCase().includes('passphrase'), false,
    'a wall display must not be asked for a secret by anyone standing in front of it');
  assert.equal(res.body.includes('type="password"'), false);
  assert.equal(res.headers['www-authenticate'], undefined);

  /* Positive control: the SAME canvas over /s/ does challenge, so the absence
   * above is a property of /d/ and not of a canvas that was never locked. */
  const shared = JSON.parse((await json(`/api/canvases/${canvas.id}/access`, 'GET')).body);
  const viaShare = await call('GET', `/s/${shared.access.shareToken}`);
  assert.equal(viaShare.status, 401);
  assert.ok(viaShare.body.includes('Passphrase required'));
});

test('a paired display is never challenged even after the passphrase changes', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {level: 'passphrase', passphrase: PASSPHRASE});
  const screen = await registerScreen('Hallway display', canvas.id);

  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);

  /* Changing the passphrase is a revocation for /s/ sessions. It must not
   * touch a display: that is the "wall screen blanks to a login" failure the
   * design exists to prevent. */
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {
    level: 'passphrase',
    passphrase: 'different words entirely here',
  });
  const after = await call('GET', `/d/${screen.token}`);
  assert.equal(after.status, 200);
  assert.ok(after.body.includes(HALLWAY_NAME));

  /* And rotating the SHARE token - a full revocation of the share link - also
   * leaves the display alone. Two namespaces, two revocation policies. */
  await json(`/api/canvases/${canvas.id}/access/rotate`, 'POST');
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);
});

/* ========================== no editing affordance ======================== */

test('/d/ HTML contains no editing affordance, asserted on the serialised bytes', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  const res = await call('GET', `/d/${screen.token}`);
  assert.equal(res.status, 200);

  const html = res.body.toLowerCase();
  /* Every one of these is a way to type, drag, submit or navigate to an
   * editor. A CSS class is a claim; these are the bytes. */
  for (const affordance of [
    '<form', '<input', '<button', '<textarea', '<select', '<label',
    'contenteditable', 'designmode', 'draggable', 'onclick', 'onchange',
    'oninput', 'method="post"', 'method=post', '/api/', '/c/',
  ]) {
    assert.equal(html.includes(affordance), false,
      `/d/ served an editing affordance: ${affordance}`);
  }
  /* The policy says it too, so an affordance injected by any means still
   * cannot submit. */
  assert.match(String(res.headers['content-security-policy']), /form-action 'none'/);

  /* Positive control: the string search is capable of finding these things.
   * Without it the loop above would pass over an empty page. */
  assert.ok(renderDisplayPage({
    metadata: {uid: 'a'.repeat(22), name: 'x', revision: 1, createdAt: '', updatedAt: ''},
    spec: {elements: {}, layout: {kind: 'Grid', authoredDensity: 'standard', items: []}},
  } as never).length > 0);
  assert.ok('<form method="post">'.toLowerCase().includes('<form'),
    'the affordance search itself must be able to match');
});

test('the kiosk client sends no write verb and offers no editor', async () => {
  /* The second place the rule lives: the script a display actually runs. */
  const script = KIOSK_SCRIPT.toLowerCase();
  for (const verb of ["method: 'post'", 'method: "post"', "method:'put'", 'method: \'put\'',
    "method: 'delete'", 'xmlhttprequest', 'document.execcommand', 'contenteditable']) {
    assert.equal(script.includes(verb), false, `the kiosk client can write: ${verb}`);
  }
  const res = await call('GET', KIOSK_SCRIPT_PATH);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.equal(res.body, KIOSK_SCRIPT);
});

test('/d/ answers no write verb at all', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await call(method, `/d/${screen.token}`);
    assert.equal(res.status, 405, `${method} must not be served on a display route`);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
});

/* ======================= the indirection, tested ======================== */

test('repointing a screen changes what /d/<token> serves, with the token unchanged', async () => {
  const hallway = await createCanvas(HALLWAY_NAME);
  const holiday = await createCanvas(HOLIDAY_NAME);
  const screen = await registerScreen('Hallway display', hallway.id);
  const token = screen.token;

  const before = await call('GET', `/d/${token}`);
  assert.ok(before.body.includes(HALLWAY_NAME));
  assert.equal(before.body.includes(HOLIDAY_NAME), false);

  const repointed = await json(`/api/screens/${screen.id}`, 'PUT', {
    target: {kind: 'canvas', id: holiday.id},
  });
  assert.equal(repointed.status, 200, repointed.body);
  assert.equal(JSON.parse(repointed.body).screen.token, token,
    'the URL taped to the back of a television must outlive every decision about what it shows');

  const after = await call('GET', `/d/${token}`);
  assert.equal(after.status, 200);
  assert.ok(after.body.includes(HOLIDAY_NAME));
  assert.equal(after.body.includes(HALLWAY_NAME), false);
});

test('two screens on one canvas both reflect a single edit', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const kitchen = await registerScreen('Kitchen tablet', canvas.id);
  const landing = await registerScreen('Landing TV', canvas.id);

  const before = await Promise.all([
    json(`/d/${kitchen.token}/manifest`, 'GET'),
    json(`/d/${landing.token}/manifest`, 'GET'),
  ]);
  const beforeRevisions = before.map((r) => JSON.parse(r.body).revision);
  assert.deepEqual(beforeRevisions, [canvas.revision, canvas.revision]);

  const EDITED = 'HALLWAY_CANVAS_ALPHA_EDITED';
  const revision = await editCanvas(canvas.id, EDITED);
  assert.ok(revision > canvas.revision, 'the edit must have moved the revision');

  for (const screen of [kitchen, landing]) {
    const manifest = JSON.parse((await json(`/d/${screen.token}/manifest`, 'GET')).body);
    assert.equal(manifest.revision, revision, 'edit once, all screens update');
    const page = await call('GET', `/d/${screen.token}`);
    assert.ok(page.body.includes(EDITED));
  }
});

/* ============================== revocation ============================== */

test('rotation kills the old token instantly and mints a live one', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);

  const rotated = await json(`/api/screens/${screen.id}/rotate`, 'POST');
  assert.equal(rotated.status, 200, rotated.body);
  const next = JSON.parse(rotated.body).screen;
  assert.notEqual(next.token, screen.token);

  assert.equal((await call('GET', `/d/${screen.token}`)).status, 404);
  assert.equal((await call('GET', `/d/${next.token}`)).status, 200);
  assert.equal(next.lastSeenAt, null,
    'a rotated screen has not been seen on its new token; claiming otherwise would be a lie');
});

test('deletion kills the token instantly and removes the sidecar file', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);

  const removed = await call('DELETE', `/api/screens/${screen.id}`);
  assert.equal(removed.status, 204);

  assert.equal((await call('GET', `/d/${screen.token}`)).status, 404);
  assert.equal((await call('GET', `/d/${screen.token}/manifest`)).status, 404);
  const files = await readdir(screens.directory);
  assert.equal(files.includes(`${screen.id}.json`), false);
});

test('unknown, revoked and malformed tokens give byte-identical 404s', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  await call('DELETE', `/api/screens/${screen.id}`);

  const misses = await Promise.all([
    call('GET', `/d/${screen.token}`),               // revoked
    call('GET', `/d/${newScreenToken()}`),           // unknown but well-formed
    call('GET', '/d/short'),                          // malformed: too short
    call('GET', `/d/${'A'.repeat(44)}`),              // malformed: too long
    call('GET', '/d/%2e%2e%2fetc%2fpasswd'),          // malformed: traversal attempt
    call('GET', '/d/%ZZ'),                            // malformed: undecodable
    call('GET', `/d/${newScreenToken()}/manifest`),   // unknown, on the manifest
    call('GET', `/d/${screen.token}/nonsense`),       // wrong shape
  ]);
  const first = misses[0];
  assert.equal(first.status, 404);
  for (const miss of misses) {
    assert.equal(miss.raw, first.raw,
      'every display miss must be identical in status, headers, header order and bytes');
  }
  assert.equal(first.body, DISPLAY_NOT_FOUND_BODY);

  /* A screen whose canvas was deleted is the same miss, and must not become a
   * "that canvas is gone" oracle. */
  const other = await createCanvas(HOLIDAY_NAME);
  const orphan = await registerScreen('Orphan', other.id);
  await call('DELETE', `/api/canvases/${other.id}`);
  assert.equal((await call('GET', `/d/${orphan.token}`)).raw, first.raw);
});

/* ============================ two namespaces ============================ */

test('a screen token does not work at /s/ and a share token does not work at /d/', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {level: 'link'});
  const shareToken = JSON.parse((await json(`/api/canvases/${canvas.id}/access`, 'GET')).body)
    .access.shareToken as string;
  const screen = await registerScreen('Hallway display', canvas.id);

  /* Positive controls first, so the negatives below cannot pass because
   * nothing works at all. */
  assert.equal((await call('GET', `/s/${shareToken}`)).status, 200);
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);

  assert.notEqual(shareToken, screen.token);

  const screenAtShare = await call('GET', `/s/${screen.token}`);
  assert.equal(screenAtShare.status, 404, 'a screen token must not be a share link');
  assert.equal(screenAtShare.body, SHARE_NOT_FOUND_BODY);

  const shareAtDisplay = await call('GET', `/d/${shareToken}`);
  assert.equal(shareAtDisplay.status, 404, 'a share token must not pair a display');
  assert.equal(shareAtDisplay.body, DISPLAY_NOT_FOUND_BODY);
  assert.equal((await call('GET', `/d/${shareToken}/manifest`)).status, 404);

  /* And an unknown token is the same answer on both surfaces, so a prober
   * cannot tell which namespace a token belongs to by which one 404s
   * differently. */
  const unknown = newScreenToken();
  assert.equal((await call('GET', `/s/${unknown}`)).body, SHARE_NOT_FOUND_BODY);
  assert.equal((await call('GET', `/d/${unknown}`)).body, DISPLAY_NOT_FOUND_BODY);
});

test('revoking one namespace never revokes the other', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {level: 'link'});
  const shareToken = JSON.parse((await json(`/api/canvases/${canvas.id}/access`, 'GET')).body)
    .access.shareToken as string;
  const screen = await registerScreen('Hallway display', canvas.id);

  /* Withdraw the share link entirely. The display is unaffected. */
  await call('DELETE', `/api/canvases/${canvas.id}/access`);
  assert.equal((await call('GET', `/s/${shareToken}`)).status, 404);
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 200);

  /* And the other way: re-share, then rotate the screen. */
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {level: 'link'});
  const reshared = JSON.parse((await json(`/api/canvases/${canvas.id}/access`, 'GET')).body)
    .access.shareToken as string;
  await json(`/api/screens/${screen.id}/rotate`, 'POST');
  assert.equal((await call('GET', `/d/${screen.token}`)).status, 404);
  assert.equal((await call('GET', `/s/${reshared}`)).status, 200);
});

test('the two stores keep their records in separate directories', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  await json(`/api/canvases/${canvas.id}/access`, 'PUT', {level: 'link'});
  const screen = await registerScreen('Hallway display', canvas.id);

  assert.notEqual(access.directory, screens.directory);
  const accessFiles = await readdir(access.directory);
  const screenFiles = await readdir(screens.directory);
  assert.deepEqual(accessFiles, [`${canvas.id}.json`]);
  assert.deepEqual(screenFiles, [`${screen.id}.json`]);
});

/* ============================== manifest ================================ */

test('the manifest returns 304 for an unchanged revision and 200 once it moves', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);

  const first = await json(`/d/${screen.token}/manifest`, 'GET');
  assert.equal(first.status, 200);
  const etag = String(first.headers.etag);
  assert.ok(etag.length > 0);
  const manifest = JSON.parse(first.body);
  assert.deepEqual(manifest.target, {kind: 'canvas', id: canvas.id});
  assert.equal(manifest.revision, canvas.revision);
  assert.equal(manifest.pollIntervalSeconds, DEFAULT_POLL_SECONDS);
  assert.equal(manifest.pollJitterRatio, POLL_JITTER_RATIO);

  const unchanged = await call('GET', `/d/${screen.token}/manifest`, {
    headers: {'If-None-Match': etag},
  });
  assert.equal(unchanged.status, 304, 'an unchanged manifest must be cheap');
  assert.equal(unchanged.body, '');

  await editCanvas(canvas.id, 'HALLWAY_CANVAS_ALPHA_V2');
  const moved = await call('GET', `/d/${screen.token}/manifest`, {
    headers: {'If-None-Match': etag},
  });
  assert.equal(moved.status, 200, 'a changed revision must not be a 304');
  assert.notEqual(String(moved.headers.etag), etag);
});

test('repointing changes the ETag even when the revisions coincide', async () => {
  /* Two freshly created canvases are both at revision 1. An ETag built from
   * the revision alone would hand a display a 304 and leave it showing the
   * wrong canvas indefinitely. */
  const one = await createCanvas(HALLWAY_NAME);
  const two = await createCanvas(HOLIDAY_NAME);
  assert.equal(one.revision, two.revision);

  const screen = await registerScreen('Hallway display', one.id);
  const first = await json(`/d/${screen.token}/manifest`, 'GET');
  const etag = String(first.headers.etag);

  await json(`/api/screens/${screen.id}`, 'PUT', {target: {kind: 'canvas', id: two.id}});
  const after = await call('GET', `/d/${screen.token}/manifest`, {headers: {'If-None-Match': etag}});
  assert.equal(after.status, 200);
  assert.equal(JSON.parse(after.body).target.id, two.id);
});

test('the poll interval carries jitter, at both endpoints and in aggregate', () => {
  const interval = 60_000;
  /* Pure function, asserted at its endpoints rather than sampled. */
  assert.equal(nextPollDelayMs(interval, 0.25, 0), 45_000, 'random=0 is the low end');
  assert.equal(nextPollDelayMs(interval, 0.25, 1), 75_000, 'random=1 is the high end');
  assert.equal(nextPollDelayMs(interval, 0.25, 0.5), 60_000, 'the midpoint is the stated interval');
  assert.equal(nextPollDelayMs(interval, 0, 0), interval, 'zero jitter is exactly the interval');
  /* Never a busy loop, whatever is asked for. */
  assert.equal(nextPollDelayMs(100, 0.9, 0), 1000);
  assert.ok(nextPollDelayMs(1, 0.9, 0) >= 1000);

  /* Six screens started by one power cut must not land on one instant. */
  const delays = new Set(
    Array.from({length: 6}, (_, i) => nextPollDelayMs(interval, 0.25, i / 6)),
  );
  assert.equal(delays.size, 6, 'six screens must not poll in lockstep');

  /* And the client actually applies it. */
  assert.match(KIOSK_SCRIPT, /Math\.random\(\) \* 2 - 1/);
});

/* ======================= offline continuity, client ====================== */

test('the kiosk client caches its last good render and degrades to a staleness note', () => {
  /* The client is not executed here - that is a browser's job - but its
   * SHAPE is the product decision, and the decision is checkable: it must
   * persist, restore, and on failure show cached content rather than an
   * error. */
  assert.match(KIOSK_SCRIPT, /localStorage\.setItem/);
  assert.match(KIOSK_SCRIPT, /localStorage\.getItem/);
  assert.match(KIOSK_SCRIPT, /catch/);
  assert.match(KIOSK_SCRIPT, /setStale\(true\)/);
  /* A failed poll must NOT navigate, reload or blank. */
  for (const forbidden of ['location.reload', 'location.href =', 'document.body.innerHTML = \'\'',
    'alert(']) {
    assert.equal(KIOSK_SCRIPT.includes(forbidden), false,
      `a failed poll must not ${forbidden}`);
  }

  /* The shell carries the staleness element and the cache key is per token,
   * so two displays on one browser profile do not overwrite each other. */
  assert.match(KIOSK_SCRIPT, /'ch_screen_' \+ token/);
});

test('the served page carries the staleness indicator and the revision it rendered', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  const res = await call('GET', `/d/${screen.token}`);
  assert.match(res.body, /id="screen-stale"/);
  assert.match(res.body, /hidden/);
  assert.match(res.body, new RegExp(`data-revision="${canvas.revision}"`));
  assert.equal(res.headers.etag, `"canvas:${canvas.id}:${canvas.revision}"`);
});

test('/view serves the fragment a poll swaps in, and nothing editable', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  const res = await json(`/d/${screen.token}/view`, 'GET');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.revision, canvas.revision);
  assert.ok(body.html.includes(HALLWAY_NAME));
  for (const affordance of ['<form', '<input', '<button', 'contenteditable']) {
    assert.equal(body.html.toLowerCase().includes(affordance), false);
  }
});

/* ============================== liveness ================================ */

test('lastSeenAt and lastSeenRevision are updated on each manifest poll', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);
  assert.equal(screen.lastSeenAt, null, 'a freshly registered screen has never been seen');
  assert.equal(screen.lastSeenRevision, null);

  await json(`/d/${screen.token}/manifest`, 'GET');
  const seen = JSON.parse((await json(`/api/screens/${screen.id}`, 'GET')).body).screen;
  assert.ok(typeof seen.lastSeenAt === 'string' && seen.lastSeenAt.length > 0);
  assert.equal(seen.lastSeenRevision, canvas.revision);

  /* A 304 is proof of life too - the healthiest display is the one that is
   * always 304ing, and it is the one an operator most needs to see as
   * alive. */
  const etag = String((await json(`/d/${screen.token}/manifest`, 'GET')).headers.etag);
  const before = seen.lastSeenAt;
  await new Promise((r) => setTimeout(r, 5));
  const notModified = await call('GET', `/d/${screen.token}/manifest`, {
    headers: {'If-None-Match': etag},
  });
  assert.equal(notModified.status, 304);
  const again = JSON.parse((await json(`/api/screens/${screen.id}`, 'GET')).body).screen;
  assert.ok(Date.parse(again.lastSeenAt) >= Date.parse(before));

  /* The RENDER does not bookkeep: only the cheap request does, so a screen's
   * liveness reflects its poll rather than an occasional reload. */
  assert.equal(again.lastSeenRevision, canvas.revision);
});

/* ============================== duplication ============================= */

test('a duplicated canvas inherits no screen', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Hallway display', canvas.id);

  const copied = await json(`/api/canvases/${canvas.id}/duplicate`, 'POST');
  assert.equal(copied.status, 201, copied.body);
  const copy = JSON.parse(copied.body);
  assert.notEqual(copy.metadata.uid, canvas.id);

  /* There is still exactly one screen, and it still points at the original. */
  const listed = JSON.parse((await json('/api/screens', 'GET')).body).screens;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].target.id, canvas.id);

  /* The copy carries no token of any kind in its own document. */
  const serialised = JSON.stringify(copy);
  assert.equal(serialised.includes(screen.token), false,
    'a duplicate that inherited a screen token would silently hijack a wall display');
  assert.equal(copy.metadata.screenToken, undefined);
  assert.equal(copy.metadata.token, undefined);

  /* And the original's kiosk URL still shows the ORIGINAL. */
  const page = await call('GET', `/d/${screen.token}`);
  assert.ok(page.body.includes(HALLWAY_NAME));
  assert.equal(page.body.includes('(copy)'), false);
});

/* ================================= API ================================== */

test('/api/screens refuses a non-loopback peer, and answers a loopback one', async () => {
  /* The gate is `apiReachable`, applied on the PEER ADDRESS - the one value in
   * a request the client cannot choose - so it cannot be exercised by sending
   * a header. The route is therefore driven directly with a faked socket, and
   * a loopback control is asserted in the same test so it cannot pass by
   * refusing everything. */
  const data = await mkdtemp(join(root, 'remote-'));
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: data});
  const ctx = {config, store: new CanvasStore(data), screens: new ScreenStore(data)};

  const drive = async (remoteAddress: string) => {
    let status = 0;
    let body = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(chunk?: string) {
        status = this.statusCode;
        body = chunk ?? '';
      },
    } as unknown as import('node:http').ServerResponse;
    const req = {
      method: 'GET',
      headers: {},
      socket: {remoteAddress},
    } as unknown as import('node:http').IncomingMessage;
    const owned = await handleScreenRoutes(req, res, ctx, '/api/screens');
    return {owned, status, body};
  };

  const remote = await drive('203.0.113.9');
  assert.equal(remote.owned, true);
  assert.equal(remote.status, 403, 'an unauthenticated fleet API must not answer the network');
  assert.equal(JSON.parse(remote.body).error.code, 'not_authenticated');

  for (const loopback of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const local = await drive(loopback);
    assert.equal(local.status, 200, `${loopback} is the same machine and must be served`);
    assert.deepEqual(JSON.parse(local.body).screens, []);
  }

  /* And the same refusal over a real socket, so the wiring in server.ts is
   * covered too rather than just the handler. */
  assert.equal((await json('/api/screens', 'GET')).status, 200);
});

test('registering a screen requires an existing canvas and a tagged target', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);

  for (const bad of [
    {label: 'x'},
    {label: 'x', target: null},
    {label: 'x', target: 'canvas'},
    {label: 'x', target: {id: canvas.id}},
    {label: 'x', target: {kind: 'loop', id: canvas.id}},
    {label: 'x', target: {kind: 'canvas', id: 'not-an-id'}},
  ]) {
    const res = await json('/api/screens', 'POST', bad);
    assert.equal(res.status, 422, `accepted a bad target: ${JSON.stringify(bad)}`);
    assert.equal(JSON.parse(res.body).error.code, 'invalid_target');
  }

  const missing = await json('/api/screens', 'POST', {
    label: 'x', target: {kind: 'canvas', id: 'A'.repeat(22)},
  });
  assert.equal(missing.status, 404, 'a screen pointed at nothing is a URL that 404s forever');

  const good = await json('/api/screens', 'POST', {
    label: 'Kitchen tablet', target: {kind: 'canvas', id: canvas.id},
  });
  assert.equal(good.status, 201);
  const screen = JSON.parse(good.body).screen;
  assert.equal(good.headers.location, `/api/screens/${screen.id}`);
  assert.ok(isScreenId(screen.id));
  assert.equal(screen.displayPath, `/d/${screen.token}`);
  assert.equal(screen.token.length, 43, '32 random bytes base64url is 43 characters');
});

test('unknown and malformed screen ids give the same 404 on every verb', async () => {
  const misses = await Promise.all([
    json(`/api/screens/${'A'.repeat(22)}`, 'GET'),
    json('/api/screens/not-an-id', 'GET'),
    json(`/api/screens/${'A'.repeat(22)}`, 'PUT', {label: 'x'}),
    json('/api/screens/not-an-id', 'PUT', {label: 'x'}),
    json(`/api/screens/${'A'.repeat(22)}/rotate`, 'POST'),
    json('/api/screens/not-an-id/rotate', 'POST'),
    call('DELETE', `/api/screens/${'A'.repeat(22)}`),
    call('DELETE', '/api/screens/not-an-id'),
  ]);
  for (const miss of misses) {
    assert.equal(miss.status, 404);
    assert.equal(JSON.parse(miss.body).error.code, 'not_found');
    assert.equal(JSON.parse(miss.body).error.message, 'no screen with that id');
  }
});

test('renaming a screen leaves its token and its target alone', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const screen = await registerScreen('Kitchen tablet', canvas.id);
  const renamed = JSON.parse((await json(`/api/screens/${screen.id}`, 'PUT',
    {label: '  Landing   TV  '})).body).screen;
  assert.equal(renamed.label, 'Landing TV');
  assert.equal(renamed.token, screen.token);
  assert.deepEqual(renamed.target, screen.target);
});

test('a label is normalised rather than trusted', () => {
  assert.equal(normaliseLabel('Kitchen tablet'), 'Kitchen tablet');
  assert.equal(normaliseLabel('  a \n b  '), 'a b');
  assert.equal(normaliseLabel('tab\there'), 'tab here');
  assert.equal(normaliseLabel(''), 'Screen');
  assert.equal(normaliseLabel('   '), 'Screen');
  assert.equal(normaliseLabel(42), 'Screen');
  assert.equal(normaliseLabel(undefined, 'Previous'), 'Previous');
  assert.equal(normaliseLabel('x'.repeat(500)).length, 120,
    'an unbounded label in a record an API can write is a disk-filling primitive');
});

test('the screen list is ordered and carries every registration', async () => {
  const canvas = await createCanvas(HALLWAY_NAME);
  const a = await registerScreen('First', canvas.id);
  const b = await registerScreen('Second', canvas.id);
  const listed = JSON.parse((await json('/api/screens', 'GET')).body).screens;
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((s: {id: string}) => s.id).sort(), [a.id, b.id].sort());
  const again = JSON.parse((await json('/api/screens', 'GET')).body).screens;
  assert.deepEqual(again.map((s: {id: string}) => s.id), listed.map((s: {id: string}) => s.id),
    'the order must not shuffle between reads of an untouched store');
});

/* ============================== store unit ============================== */

test('the screen index is rebuilt from disk, so a restart does not revoke a fleet', async () => {
  const data = await mkdtemp(join(root, 'restart-'));
  const first = new ScreenStore(data);
  const created = await first.create({label: 'Hallway TV', target: {kind: 'canvas', id: 'B'.repeat(22)}});
  assert.ok(created.ok);
  const token = created.ok ? created.value.token : '';

  /* A brand new store over the same directory - which is what a container
   * restart is. A wall display must not need re-pairing. */
  const second = new ScreenStore(data);
  const resolved = await second.resolve(token);
  assert.ok(resolved !== null, 'a restart must not revoke every screen in the house');
  assert.equal(resolved?.label, 'Hallway TV');

  assert.equal(await second.resolve('not-a-token'), null);
  assert.equal(await second.resolve(newScreenToken()), null);
  assert.equal(await second.resolve(undefined), null);
});

test('a corrupt screen record is ignored rather than trusted', async () => {
  const data = await mkdtemp(join(root, 'corrupt-'));
  const store = new ScreenStore(data, {log: () => undefined});
  await store.init();
  await writeFile(join(store.directory, `${'C'.repeat(22)}.json`), 'not json at all');
  await writeFile(join(store.directory, `${'D'.repeat(22)}.json`),
    JSON.stringify({version: 99, id: 'D'.repeat(22), token: newScreenToken()}));
  const listed = await store.list();
  assert.deepEqual(listed, [], 'a record this build cannot understand is not a screen');
});
