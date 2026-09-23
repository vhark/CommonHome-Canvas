/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* What this file is actually proving.
 *
 * The danger this phase introduced is not "the data is wrong". It is that
 * wiring live sources into a render path turns a pure function into an I/O
 * function, and turns six wall screens into six provider requests a minute.
 * So the assertions here are mostly about ABSENCE: no fetch on the render
 * path, no growth in request count with render count, no credential in the
 * output, no private field on a shared surface.
 *
 * Everything is offline. There is no test in this file that would behave
 * differently on a machine with no network, which is the only kind of test
 * worth having about a thing that must not use the network.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {loadConfig} from './config.ts';
import {defaultCanvasDocument, QUOTE_OF_DAY} from './default-canvas.ts';
import {COLD_REASON, FeedCache, MIN_REFRESH_MS, WEATHER_REFRESH_MS} from './feeds.ts';
import {prepareRender, renderOptionsFor, withServerBlocks} from './render-context.ts';
import type {Snapshot} from './snapshot.ts';
import {validateDocument} from '../canvas/document.ts';
import {renderCanvasFragment} from '../render/index.ts';
import {NEVER_SHARED_KEYS} from '../calendar/shape.ts';
import {adjacentAuthorPairs, orderOf, quoteOfDay, QUOTES} from '../quotes/index.ts';

/* Invented throughout. The public repo is exported with `git ls-files`, so a
 * real household value in a fixture is a permanent publication. */
const HA_TOKEN = 'ha-token-DO-NOT-LEAK-2f9d';
const PHOTO_KEY = 'unsplash-key-DO-NOT-LEAK-71ac';
const ICS_URL = 'https://calendars.example.com/private/DO-NOT-LEAK-token.ics';

const NOW = new Date('2026-09-22T15:04:00Z');

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CANVAS_PORT: '0',
    CANVAS_TIMEZONE: 'UTC',
    CANVAS_LOCALE: 'en-GB',
    HOMEASSISTANT_URL: 'https://ha.example.com',
    HOMEASSISTANT_TOKEN: HA_TOKEN,
    CANVAS_WEATHER_ENTITY: 'weather.example',
    UNSPLASH_ACCESS_KEY: PHOTO_KEY,
    ...extra,
  };
}

function goodSnapshot(): Snapshot {
  return {
    weather: {
      state: 'partlycloudy',
      temperature: 17.4,
      unit: '\u00b0C',
      attribution: 'Weather forecast from Example Met Service, delivered by Home Assistant.',
    },
    events: [],
    peopleHome: [],
    photo: {
      url: 'https://images.example.com/photo.jpg?w=1920&h=1080',
      color: '#2b3a2f',
      blurHash: null,
      photographer: 'Wren Alderby',
      photographerUrl: 'https://photos.example.com/@wren',
      source: 'Example Photos',
      sourceUrl: 'https://photos.example.com/',
    },
    generatedAt: NOW.toISOString(),
    degraded: [],
  };
}

/* A source that records every call. The whole fetch-count proof rests on this
 * being the ONLY way to reach a provider in the wiring under test. */
function countingSource(produce: () => Snapshot = goodSnapshot) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async snapshot(): Promise<Snapshot> {
      calls += 1;
      return produce();
    },
  };
}

/* ------------------------------------------------------- 1. render purity -- */

test('a render performs no I/O: fetch throws if called, and the page still renders', async () => {
  const {config} = loadConfig(env());
  const source = countingSource();
  const feeds = new FeedCache({config, snapshotSource: source});
  await feeds.refreshNow();

  const real = globalThis.fetch;
  let touched = false;
  /* POISONED. Any attempt to reach the network from the render path is a
   * thrown error rather than a slow test, so this cannot pass by accident on
   * a machine that happens to be offline. */
  (globalThis as {fetch: unknown}).fetch = (...args: unknown[]) => {
    touched = true;
    throw new Error(`the render path called fetch: ${String(args[0])}`);
  };
  try {
    const prepared = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
    const html = renderCanvasFragment(prepared.doc, prepared.options);
    assert.equal(touched, false, 'the render path called fetch');
    assert.match(html, /ch-canvas/);
    assert.match(html, /ch-weather-temp/, 'the poisoned render still produced live weather');
    assert.match(html, /ch-photo-image/, 'the poisoned render still produced the photograph');
  } finally {
    (globalThis as {fetch: unknown}).fetch = real;
  }
  feeds.stop();
});

/* --------------------------------------------------- 2. one fetch, N renders -- */

test('fifty renders of the same canvas do not raise the provider request count', async () => {
  const {config} = loadConfig(env());
  const source = countingSource();
  const feeds = new FeedCache({config, snapshotSource: source});

  await feeds.refreshNow();
  const afterFirstRefresh = source.calls;

  const doc = defaultCanvasDocument();
  let bytes = 0;
  for (let i = 0; i < 50; i += 1) {
    const prepared = prepareRender(doc, {config, feeds}, 'private', NOW);
    bytes += renderCanvasFragment(prepared.doc, prepared.options).length;
  }
  const afterFiftyRenders = source.calls;

  assert.equal(afterFirstRefresh, 1, 'one refresh should be one provider request');
  assert.equal(
    afterFiftyRenders,
    afterFirstRefresh,
    `50 renders raised the provider request count from ${afterFirstRefresh} to ${afterFiftyRenders}`,
  );
  assert.ok(bytes > 0);

  /* And the number moves with REFRESHES, so the assertion above is not
   * passing because nothing fetches at all. */
  await feeds.refreshNow();
  assert.equal(source.calls, 2, 'a refresh should have raised the count');
  feeds.stop();
});

test('six screens rendering the same canvas share one refresh', async () => {
  const {config} = loadConfig(env());
  const source = countingSource();
  const feeds = new FeedCache({config, snapshotSource: source});
  await feeds.refreshNow();

  const doc = defaultCanvasDocument();
  /* Six screens, one poll each - the real fleet, at the real cadence. */
  for (let screen = 0; screen < 6; screen += 1) {
    const prepared = prepareRender(doc, {config, feeds}, 'private', NOW);
    renderCanvasFragment(prepared.doc, prepared.options);
  }
  assert.equal(source.calls, 1, `six screens produced ${source.calls} provider requests`);
  feeds.stop();
});

test('the refresh interval is per source and is floored', () => {
  assert.equal(WEATHER_REFRESH_MS, 5 * 60 * 1000);
  assert.equal(MIN_REFRESH_MS, 60 * 1000);
  const {config} = loadConfig(env({
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LABEL: 'House',
    CANVAS_CALENDAR_1_REFRESH: '3600',
  }));
  const feeds = new FeedCache({config, snapshotSource: countingSource()});
  const described = feeds.describeFeeds();
  assert.equal(Object.keys(described).length, 2, 'one entry per configured source');
  assert.match(described.snapshot!, /every 300s/);
  assert.match(described[`calendar:${config.calendars[0]!.id}`]!, /every 3600s/);
  feeds.stop();
});

/* ----------------------------------------------- 3. per-block degradation -- */

test('a failing weather source leaves the photo, clock and quote rendered', async () => {
  const {config} = loadConfig(env());
  /* Weather down, photo up. Exactly the shape SnapshotSource produces when
   * one upstream is unreachable and the other is not. */
  const source = countingSource(() => ({...goodSnapshot(), weather: null, degraded: ['weather']}));
  const feeds = new FeedCache({config, snapshotSource: source});
  await feeds.refreshNow();

  const prepared = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
  const html = renderCanvasFragment(prepared.doc, prepared.options);

  assert.match(
    html,
    /data-block="weather"[^>]*data-state="degraded"/,
    'the weather block should be degraded',
  );
  assert.match(html, /data-block="photo"[^>]*data-state="ok"/, 'the photo block should still render');
  assert.match(html, /data-block="clock"[^>]*data-state="ok"/, 'the clock should still render');
  assert.match(html, /data-block="quote"[^>]*data-state="ok"/, 'the quote should still render');
  assert.match(html, /ch-photo-image/);
  assert.match(html, /ch-clock-time/);
  /* And no error page anywhere in it. */
  assert.doesNotMatch(html, /Internal|error|exception/i);
  feeds.stop();
});

test('a source that succeeded once keeps serving its last good value after a failure', async () => {
  const {config} = loadConfig(env());
  let fail = false;
  const source = countingSource(() =>
    fail ? {...goodSnapshot(), weather: null, photo: null, degraded: ['weather', 'photo']} : goodSnapshot());
  const feeds = new FeedCache({config, snapshotSource: source});

  await feeds.refreshNow();
  const before = renderCanvasFragment(
    ...(() => {
      const p = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
      return [p.doc, p.options] as const;
    })(),
  );
  assert.match(before, /17\s*(&#160;|\u00a0)?\s*°C|17/);

  fail = true;
  await feeds.refreshNow();
  const after = renderCanvasFragment(
    ...(() => {
      const p = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
      return [p.doc, p.options] as const;
    })(),
  );
  /* A wall showing a twenty-minute-old temperature is right. A dimmed
   * rectangle where the temperature was is not. */
  assert.match(after, /data-block="weather"[^>]*data-state="ok"/, 'last known good was dropped');
  assert.match(after, /ch-photo-image/, 'the last known good photograph was dropped');
  feeds.stop();
});

/* ------------------------------------------------------- 4. cold start ---- */

test('cold start renders degraded blocks and no error page', () => {
  const {config} = loadConfig(env());
  /* Constructed and NEVER refreshed - the state a first boot is in for the
   * first few seconds, and the state a totally unreachable network leaves it
   * in indefinitely. */
  const feeds = new FeedCache({config, snapshotSource: countingSource()});

  const data = feeds.dataFor('private');
  assert.equal(data.weather?.default?.ok, false);
  assert.equal(data.photos?.default?.ok, false);
  assert.equal((data.weather!.default as {reason: string}).reason, COLD_REASON);

  const prepared = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
  const html = renderCanvasFragment(prepared.doc, prepared.options);
  assert.match(html, /data-block="weather"[^>]*data-state="degraded"/);
  assert.match(html, /data-block="photo"[^>]*data-state="degraded"/);
  assert.match(html, new RegExp(COLD_REASON));
  /* The page still rendered: the clock and the quote are real content, not a
   * placeholder for a failed page. */
  assert.match(html, /data-block="clock"[^>]*data-state="ok"/);
  assert.match(html, /data-block="quote"[^>]*data-state="ok"/);
  assert.equal(feeds.fetchCounts().snapshot, 0, 'cold start must not have fetched');
  feeds.stop();
});

test('an unconfigured household gets no feed entries at all, not failed ones', () => {
  const {config} = loadConfig({CANVAS_PORT: '0'});
  const feeds = new FeedCache({config});
  assert.deepEqual(feeds.dataFor('private'), {weather: {}, photos: {}, calendars: {}});
  assert.deepEqual(feeds.describeFeeds(), {feeds: '(none configured)'});
  /* Which means a document carrying its own values renders them: no feed
   * entry is different from a feed that failed. */
  const doc = validateDocument({
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'authored-fixture'},
    spec: {
      elements: {
        w: {type: 'weather', namedSize: 'small', state: 'sunny', temperature: 21, unit: '\u00b0C', place: 'Study'},
      },
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'w', col: 0, row: 0}]},
    },
  });
  assert.ok(doc.ok);
  const html = renderCanvasFragment(doc.value, renderOptionsFor(config, 'private', NOW, feeds));
  assert.match(html, /data-state="ok"/);
  assert.match(html, /Study/);
  feeds.stop();
});

/* ------------------------------------------------- 5. share safety, live --- */

/* A calendar shaped at BOTH levels by the FeedCache, driven by a fake fetcher
 * so no ICS is downloaded. The fetcher's own `load` is what the cache calls,
 * so this exercises the real two-shapings code path. */
function fakeFetcher(level: 'private' | 'shared') {
  let loads = 0;
  return {
    get loads() {
      return loads;
    },
    displayZone: 'UTC',
    async load(source: {level: string; label: string}) {
      loads += 1;
      const shared = source.level === 'shared';
      return {
        name: source.label,
        level: source.level,
        generatedAt: NOW.toISOString(),
        warnings: [],
        degraded: [],
        events: [
          shared
            ? {
              id: 'occ-1',
              date: '2026-09-22',
              startTime: '18:30',
              endTime: '19:30',
              allDay: false,
              band: 'evening',
              tentative: false,
              busy: true,
            }
            : {
              id: 'occ-1',
              date: '2026-09-22',
              startTime: '18:30',
              endTime: '19:30',
              allDay: false,
              band: 'evening',
              title: 'Choir practice',
              description: 'Bring the folder from the hall cupboard',
              location: '14 Hollybush Lane',
              attendees: ['rowan@example.com'],
              tentative: false,
              busy: true,
            },
        ],
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _declaredLevel: level,
  };
}

function calendarCanvas() {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'calendar-fixture', name: 'Hall'},
    spec: {
      elements: {
        cal: {type: 'calendar', namedSize: 'wide', source: 'default', layout: 'agenda'},
      },
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'cal', col: 0, row: 0}]},
    },
  } as never;
}

test('a shared render of a live calendar emits no private field, and the private control proves it differs', async () => {
  const {config} = loadConfig(env({
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LABEL: 'Hall calendar',
    CANVAS_CALENDAR_1_LEVEL: 'private',
  }));
  const fetcher = fakeFetcher('private');
  const feeds = new FeedCache({
    config,
    snapshotSource: countingSource(),
    calendarFetcher: fetcher as never,
  });
  await feeds.refreshNow();

  const doc = calendarCanvas();
  const shared = renderCanvasFragment(
    ...(() => {
      const p = prepareRender(doc, {config, feeds}, 'shared', NOW);
      return [p.doc, p.options] as const;
    })(),
  );
  const priv = renderCanvasFragment(
    ...(() => {
      const p = prepareRender(doc, {config, feeds}, 'private', NOW);
      return [p.doc, p.options] as const;
    })(),
  );

  /* THE POSITIVE CONTROL, first. Without this the absence assertion below is
   * satisfied by a renderer that emits nothing at all. */
  assert.match(priv, /Choir practice/, 'the private render lost its titles; the shared test would be vacuous');
  assert.match(priv, /Hollybush/, 'the private render lost its locations; the shared test would be vacuous');
  assert.match(priv, /rowan@example\.com/);
  assert.match(priv, /hall cupboard/);

  /* And now the absence. */
  for (const needle of ['Choir practice', 'Hollybush', 'rowan@example.com', 'hall cupboard']) {
    assert.ok(!shared.includes(needle), `the shared render leaked: ${needle}`);
  }
  for (const key of NEVER_SHARED_KEYS) {
    assert.ok(!shared.includes(`ch-event-${key}`), `the shared render emitted a ${key} element`);
  }
  /* Not empty either: the shared viewer sees that something is on at 18:30. */
  assert.match(shared, /18:30/);
  assert.match(shared, /Busy/);
  feeds.stop();
});

test('calendars are shaped twice at the source, not per request', async () => {
  const {config} = loadConfig(env({
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LABEL: 'Hall calendar',
  }));
  const fetcher = fakeFetcher('private');
  const feeds = new FeedCache({
    config,
    snapshotSource: countingSource(),
    calendarFetcher: fetcher as never,
  });
  await feeds.refreshNow();
  /* Two shapings per refresh, and that is the whole cost. */
  assert.equal(fetcher.loads, 2, `expected two shapings per refresh, saw ${fetcher.loads}`);

  const doc = calendarCanvas();
  for (let i = 0; i < 20; i += 1) {
    const p = prepareRender(doc, {config, feeds}, i % 2 === 0 ? 'shared' : 'private', NOW);
    renderCanvasFragment(p.doc, p.options);
  }
  assert.equal(fetcher.loads, 2, `20 renders caused ${fetcher.loads - 2} extra shapings`);

  /* And the two sets genuinely differ - a shaping that produced the same
   * events twice would satisfy the count and none of the point. */
  const sharedFeed = feeds.dataFor('shared').calendars!.default!;
  const privateFeed = feeds.dataFor('private').calendars!.default!;
  assert.ok(sharedFeed.ok && privateFeed.ok);
  assert.equal(sharedFeed.value.level, 'shared');
  assert.equal(privateFeed.value.level, 'private');
  assert.equal(sharedFeed.value.events[0]!.title, undefined);
  assert.equal(privateFeed.value.events[0]!.title, 'Choir practice');
  feeds.stop();
});

test('a source the household marked shared is shaped shared on BOTH tables', async () => {
  const {config} = loadConfig(env({
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LEVEL: 'shared',
  }));
  const feeds = new FeedCache({
    config,
    snapshotSource: countingSource(),
    calendarFetcher: fakeFetcher('shared') as never,
  });
  await feeds.refreshNow();
  const privateFeed = feeds.dataFor('private').calendars!.default!;
  assert.ok(privateFeed.ok);
  /* The stricter of the two wins, and the owner's own wall gets the shared
   * shaping because that is what the household declared. */
  assert.equal(privateFeed.value.level, 'shared');
  feeds.stop();
});

/* ------------------------------------------------------ 6. no credentials -- */

test('no credential appears in any rendered byte, on any surface', async () => {
  const {config} = loadConfig(env({
    CANVAS_CALENDAR_1_URL: ICS_URL,
    CANVAS_CALENDAR_1_LABEL: 'Hall calendar',
  }));
  const feeds = new FeedCache({
    config,
    snapshotSource: countingSource(),
    calendarFetcher: fakeFetcher('private') as never,
  });
  await feeds.refreshNow();

  const secrets = [HA_TOKEN, PHOTO_KEY, ICS_URL, 'DO-NOT-LEAK', 'weather.example', 'calendars.example.com'];
  const doc = calendarCanvas();
  for (const level of ['private', 'shared'] as const) {
    for (const candidate of [doc, defaultCanvasDocument()]) {
      const p = prepareRender(candidate, {config, feeds}, level, NOW);
      const html = renderCanvasFragment(p.doc, p.options);
      for (const secret of secrets) {
        assert.ok(!html.includes(secret), `${level} render leaked ${secret}`);
      }
    }
  }
  /* The health description is read by whoever is debugging a dark screen and
   * is the other place a URL would plausibly end up. */
  const described = JSON.stringify(feeds.describeFeeds());
  for (const secret of secrets.slice(0, 4)) {
    assert.ok(!described.includes(secret), `describeFeeds leaked ${secret}`);
  }
  feeds.stop();
});

/* ------------------------------------------------- 7. quote determinism ---- */

test('the same date yields the same quote, and a different date a different one', () => {
  const a = quoteOfDay(new Date('2026-09-22T00:30:00Z'), 'UTC');
  const b = quoteOfDay(new Date('2026-09-22T23:30:00Z'), 'UTC');
  assert.deepEqual(a, b, 'the quote changed during the day');
  const c = quoteOfDay(new Date('2026-09-23T12:00:00Z'), 'UTC');
  assert.notDeepEqual(a, c, 'the quote did not change overnight');
});

test('the quote changes at the household midnight, not UTC midnight', () => {
  /* 2026-09-23T04:00Z is still the 22nd in Denver. */
  const instant = new Date('2026-09-23T04:00:00Z');
  const denver = quoteOfDay(instant, 'America/Denver');
  const utc = quoteOfDay(instant, 'UTC');
  assert.deepEqual(denver, quoteOfDay(new Date('2026-09-22T18:00:00Z'), 'America/Denver'));
  assert.notDeepEqual(denver, utc);
});

test('no author appears on two adjacent days, including across the wrap', () => {
  const order = orderOf(QUOTES);
  assert.equal(order.length, QUOTES.length);
  assert.equal(new Set(order).size, QUOTES.length, 'the order is not a permutation');

  const computed = adjacentAuthorPairs(QUOTES, order);
  const storage = adjacentAuthorPairs(QUOTES, QUOTES.map((_, i) => i));
  assert.equal(computed, 0, `${computed} adjacent same-author pairs in the computed order`);
  /* The control: storage order is genuinely bad, so zero above is a result
   * and not a property of the library happening to be already spaced. */
  assert.ok(storage > 0, 'storage order had no adjacent pairs; this test proves nothing');
});

test('a full cycle of days never repeats an author two days running', () => {
  let repeats = 0;
  let previous = quoteOfDay(new Date('2026-01-01T12:00:00Z'), 'UTC');
  for (let day = 1; day <= QUOTES.length; day += 1) {
    const at = new Date(Date.UTC(2026, 0, 1 + day, 12));
    const next = quoteOfDay(at, 'UTC');
    if (previous !== null && next !== null && previous.author === next.author) repeats += 1;
    previous = next;
  }
  assert.equal(repeats, 0, `${repeats} days repeated their author`);
});

test('the quote block is filled by the server and the document carries no words', () => {
  const doc = defaultCanvasDocument();
  const authored = doc.spec.elements.quote!;
  assert.equal(authored[QUOTE_OF_DAY], true);
  assert.equal(authored.body, undefined, 'the stored document must not carry the quote text');

  const filled = withServerBlocks(doc, {now: NOW, timeZone: 'UTC'});
  const body = String(filled.spec.elements.quote!.body);
  const expected = quoteOfDay(NOW, 'UTC')!;
  assert.ok(body.includes(expected.text));
  assert.ok(body.includes(expected.author));
  /* And the input was not written into. */
  assert.equal(doc.spec.elements.quote!.body, undefined);
});

test('withServerBlocks returns an untouched document when nothing is marked', () => {
  const doc = calendarCanvas();
  assert.equal(withServerBlocks(doc), doc, 'a canvas with no quote block should not be rebuilt');
});

/* ------------------------------------------- the default canvas, as shipped -- */

test('the default canvas is a valid document that names no credential', () => {
  const doc = defaultCanvasDocument();
  const checked = validateDocument(doc);
  assert.ok(checked.ok, checked.ok ? '' : JSON.stringify(checked.error));
  const json = JSON.stringify(doc);
  for (const forbidden of ['http://', 'https://', 'token', 'key', '@']) {
    assert.ok(!json.toLowerCase().includes(forbidden), `the default canvas carries ${forbidden}`);
  }
});

test('the default canvas has exactly one clock', () => {
  const clocks = Object.values(defaultCanvasDocument().spec.elements)
    .filter((block) => block.type === 'clock');
  assert.equal(clocks.length, 1, `the default canvas has ${clocks.length} clocks`);
});

test('the default canvas reproduces the ambient screen through real blocks', async () => {
  const {config} = loadConfig(env());
  const feeds = new FeedCache({config, snapshotSource: countingSource()});
  await feeds.refreshNow();

  const p = prepareRender(defaultCanvasDocument(), {config, feeds}, 'private', NOW);
  const html = renderCanvasFragment(p.doc, p.options);

  /* Full-bleed photograph occupying the whole standard grid. */
  assert.match(html, /data-block="photo"[^>]*data-cells="12x7"/);
  assert.match(html, /ch-photo-image[\s\S]*background-image:url/);
  /* The photographer, credited beneath the photograph, per the licence. */
  assert.match(html, /data-credit-of="photo"[^>]*>Wren Alderby · Example Photos</);
  /* Weather top-right, with its source directly beneath the number. */
  assert.match(html, /data-block="weather"[^>]*grid-column:10/);
  assert.match(html, /ch-weather-temp">17/);
  assert.match(html, /ch-weather-condition">Partly cloudy</);
  assert.match(html, /data-credit-of="weather"[^>]*>Example Met Service</);
  /* The quote band, full width, at the bottom. */
  assert.match(html, /data-block="quote"[^>]*data-cells="12x4"/);
  assert.match(html, /grid-row:8 \/ span 4/);
  /* One clock, and it is the product's, not a second one from a shell. */
  assert.equal((html.match(/ch-clock-time/g) ?? []).length, 1);
  feeds.stop();
});

test('the three surfaces render the same canvas byte-identically when the data is share-safe', async () => {
  const {config} = loadConfig(env());
  const feeds = new FeedCache({config, snapshotSource: countingSource()});
  await feeds.refreshNow();
  const doc = defaultCanvasDocument();
  const shared = prepareRender(doc, {config, feeds}, 'shared', NOW);
  const priv = prepareRender(doc, {config, feeds}, 'private', NOW);
  /* Weather and photography carry no per-viewer detail, so the shared and
   * private tables hold the same objects and the bytes agree. The calendar
   * test above is where the two levels are proven to differ. */
  assert.equal(
    renderCanvasFragment(shared.doc, shared.options),
    renderCanvasFragment(priv.doc, priv.options),
  );
  feeds.stop();
});
