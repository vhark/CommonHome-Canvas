/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* THE END-TO-END VERSION OF THE TWO PROMISES THAT MATTER.
 *
 * feeds.test.ts asserts them against the render functions. This file asserts
 * them against a real HTTP server over a real socket, because the wiring
 * between a route and the renderer is exactly where a promise proven one layer
 * down stops being true - a route that forgot to pass `feeds`, or passed the
 * private set to `/s/`, would pass every test in that file.
 *
 * Port 0 throughout. The live household television owns 4174 and a test that
 * binds a fixed port is a test that occasionally takes the TV down.
 */

import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import type {Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';

import {AccessStore} from './access.ts';
import {loadConfig} from './config.ts';
import {defaultCanvasDocument} from './default-canvas.ts';
import {FeedCache} from './feeds.ts';
import {ScreenStore} from './screens.ts';
import {createCanvasServer} from './server.ts';
import type {Snapshot} from './snapshot.ts';
import {CanvasStore} from './store.ts';

/* Invented. The public repo is exported with `git ls-files`. */
const HA_TOKEN = 'ha-token-DO-NOT-LEAK-e41b';
const PHOTO_KEY = 'photo-key-DO-NOT-LEAK-9c02';
const ICS_URL = 'https://calendars.example.com/feeds/DO-NOT-LEAK-secret.ics';
const SECRETS = [HA_TOKEN, PHOTO_KEY, ICS_URL, 'DO-NOT-LEAK', 'weather.example'];

let server: Server;
let base = '';
let canvasId = '';
let screenToken = '';
let shareToken = '';
let feeds: FeedCache;
let snapshotCalls = 0;

function snapshot(): Snapshot {
  return {
    weather: {
      state: 'partlycloudy',
      temperature: 12.6,
      unit: '\u00b0C',
      attribution: 'Weather forecast from Example Met Service, delivered by Home Assistant.',
    },
    events: [],
    peopleHome: [],
    photo: {
      url: 'https://images.example.com/wall.jpg?w=1920',
      color: '#1d2a22',
      blurHash: null,
      photographer: 'Wren Alderby',
      photographerUrl: 'https://photos.example.com/@wren',
      source: 'Example Photos',
      sourceUrl: 'https://photos.example.com/',
    },
    generatedAt: new Date().toISOString(),
    degraded: [],
  };
}

before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-feeds-e2e-'));
  const {config} = loadConfig({
    CANVAS_PORT: '0',
    CANVAS_DATA_DIR: dataDir,
    CANVAS_TIMEZONE: 'UTC',
    HOMEASSISTANT_URL: 'https://ha.example.com',
    HOMEASSISTANT_TOKEN: HA_TOKEN,
    CANVAS_WEATHER_ENTITY: 'weather.example',
    UNSPLASH_ACCESS_KEY: PHOTO_KEY,
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LABEL: 'Hall calendar',
  });

  const store = new CanvasStore(dataDir);
  const access = new AccessStore(dataDir);
  const screens = new ScreenStore(dataDir);
  await store.init();

  const created = await store.create(defaultCanvasDocument());
  assert.ok(created.ok, 'the default canvas should be storable');
  canvasId = created.value.metadata.uid;

  const screen = await screens.create({label: 'Test wall', target: {kind: 'canvas', id: canvasId}});
  assert.ok(screen.ok);
  screenToken = screen.value.token;

  await access.init();
  const shared = await access.set(canvasId, {level: 'link'});
  assert.ok(shared.ok, 'the canvas should be shareable');
  shareToken = shared.record.shareToken ?? '';
  assert.notEqual(shareToken, '', 'the share should have issued a token');

  /* No calendar fetcher is injected, so the calendar source will simply never
   * succeed and its block renders degraded - which is itself worth having on
   * a page the credential assertions run over: a failed fetch is the state in
   * which an error message carrying a URL would most plausibly escape. */
  feeds = new FeedCache({
    config,
    snapshotSource: {
      async snapshot() {
        snapshotCalls += 1;
        return snapshot();
      },
    },
  });
  await feeds.refreshNow();

  server = createCanvasServer({config, store, access, screens, feeds, staticDir: dataDir});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  feeds?.stop();
  server?.close();
});

async function body(path: string): Promise<string> {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return res.text();
}

test('/d/, /s/ and /c/ all render live data through the one renderer', async () => {
  const display = await body(`/d/${screenToken}`);
  const share = await body(`/s/${shareToken}`);
  const preview = await body(`/c/${canvasId}`);

  for (const [name, html] of [['/d/', display], ['/s/', share], ['/c/', preview]] as const) {
    assert.match(html, /ch-photo-image/, `${name} lost the photograph`);
    assert.match(html, /Wren Alderby · Example Photos/, `${name} lost the photo credit`);
    assert.match(html, /ch-weather-temp">13/, `${name} lost the temperature`);
    assert.match(html, /Example Met Service/, `${name} lost the weather attribution`);
    assert.match(html, /ch-clock-time/, `${name} lost the clock`);
    assert.match(html, /ch-text-body/, `${name} lost the quote band`);
  }
});

test('no credential appears in any byte of any surface', async () => {
  const rendered = await Promise.all([
    body(`/d/${screenToken}`),
    body(`/d/${screenToken}/view`),
    body(`/d/${screenToken}/manifest`),
    body(`/s/${shareToken}`),
    body(`/c/${canvasId}`),
  ]);
  /* Every rendered byte of every surface, against the whole list including
   * the entity id - a document must never name one, because that is what
   * makes a canvas portable between households. */
  for (const page of rendered) {
    for (const secret of SECRETS) {
      assert.ok(!page.includes(secret), `a rendered surface carried ${secret}`);
    }
  }

  /* /healthz is held to the CREDENTIAL list only, deliberately. It is
   * loopback-gated, it is the page an operator reads when a screen is dark,
   * and `describeConfig` has always named the configured weather entity there
   * so that "the integration is on but pointed at nothing" is diagnosable
   * without shell access. An entity id is a local name, not a bearer
   * credential; the token, the key and the calendar URL are, and none of them
   * may appear. */
  const health = await body('/healthz');
  for (const secret of [HA_TOKEN, PHOTO_KEY, ICS_URL, 'DO-NOT-LEAK']) {
    assert.ok(!health.includes(secret), `/healthz carried ${secret}`);
  }
});

test('polling /view many times causes no provider request at all', async () => {
  const before = snapshotCalls;
  for (let i = 0; i < 30; i += 1) await body(`/d/${screenToken}/view`);
  assert.equal(
    snapshotCalls,
    before,
    `30 /view polls caused ${snapshotCalls - before} provider requests`,
  );
});

test('/healthz reports the feeds without naming a source', async () => {
  const health = JSON.parse(await body('/healthz')) as {feeds: Record<string, string>};
  assert.ok(Object.keys(health.feeds).length >= 2, 'the feed summary is missing');
  assert.match(JSON.stringify(health.feeds), /every \d+s/);
  for (const secret of SECRETS) {
    assert.ok(!JSON.stringify(health.feeds).includes(secret));
  }
});
