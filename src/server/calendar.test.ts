/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* Server-side calendar fetch: conditional requests, degradation, and the
 * credential rule.
 *
 * The URLs used here are synthetic (example.com, RFC 2606) and the fetch is
 * injected, so this file makes no network calls. The live fetch against a real
 * public feed lives in calendar.live.test.ts, which is opt-in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CalendarFetcher,
  describeSource,
  normaliseSourceUrl,
  redactUrls,
  sourceFingerprint,
  type CalendarSource,
  type FetchLike,
} from './calendar.ts';
import {auditShared} from '../calendar/shape.ts';
import {LEAKY_PRIVATE_DETAIL, WEEKLY_WITH_UNTIL_AND_EXDATE} from '../calendar/fixtures.ts';

/* The "secret address" shape: an unguessable token in the path, exactly like
 * a Google secret address or a Nextcloud share. Entirely invented. */
const SECRET_URL = 'https://calendar.example.com/ical/s3cr3t-t0ken-9f2b1a/basic.ics';
const SECRET_TOKEN = 's3cr3t-t0ken-9f2b1a';

const SOURCE: CalendarSource = {
  id: 'cal-1',
  label: 'Fixture Calendar',
  url: SECRET_URL,
  level: 'shared',
};

type Call = {url: string; headers: Record<string, string>};

function stubFetch(
  responses: {status: number; body?: string; etag?: string; lastModified?: string}[],
): {fetch: FetchLike; calls: Call[]} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({url, headers: {...(init?.headers ?? {})}});
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get(name: string) {
          const n = name.toLowerCase();
          if (n === 'etag') return r.etag ?? null;
          if (n === 'last-modified') return r.lastModified ?? null;
          return null;
        },
      },
      async text() {
        return r.body ?? '';
      },
    };
  };
  return {fetch, calls};
}

/* ------------------------------------------------------- the credential */

test('THE CREDENTIAL TEST: the source URL never appears in any shaped output', async () => {
  const {fetch} = stubFetch([{status: 200, body: LEAKY_PRIVATE_DETAIL, etag: '"v1"'}]);
  const fetcher = new CalendarFetcher({fetchImpl: fetch, displayZone: 'America/Denver'});

  for (const level of ['private', 'shared'] as const) {
    const shaped = await fetcher.load({...SOURCE, id: `cal-${level}`, level},
      {now: new Date('2026-09-22T12:00:00Z')});
    const json = JSON.stringify(shaped);

    assert.ok(!json.includes(SECRET_URL), 'the source URL was serialised into a snapshot');
    assert.ok(!json.includes(SECRET_TOKEN), 'the source token was serialised into a snapshot');
    assert.ok(!json.includes('calendar.example.com'), 'the source host was serialised');
    assert.ok(!json.includes('"url"'), 'a url key reached the payload');
    /* Even the events must be there, so this is not passing on an empty
     * payload. */
    assert.ok(shaped.events.length > 0);
  }
});

test('a failure path cannot leak the URL either, since errors are redacted', async () => {
  const thrower: FetchLike = async (url) => {
    /* Node's fetch really does put the URL in network error messages. */
    throw new Error(`getaddrinfo ENOTFOUND ${url}`);
  };
  const fetcher = new CalendarFetcher({fetchImpl: thrower});
  const shaped = await fetcher.load(SOURCE, {now: new Date('2026-09-22T12:00:00Z')});
  const json = JSON.stringify(shaped);

  assert.ok(!json.includes(SECRET_TOKEN));
  assert.ok(!json.includes(SECRET_URL));
  /* Just 'calendar': with no cached body there is nothing STALE to disclose,
   * only data that is absent. Claiming staleness here would tell the
   * household it was looking at old events when it is looking at none. */
  assert.deepEqual(shaped.degraded, ['calendar']);
  assert.deepEqual(shaped.events, []);
});

test('redactUrls strips any calendar address from a string bound for a log', () => {
  assert.equal(
    redactUrls(`getaddrinfo ENOTFOUND ${SECRET_URL}`),
    'getaddrinfo ENOTFOUND [calendar url redacted]',
  );
  assert.ok(!redactUrls(`fetch failed for webcal://x.example.com/${SECRET_TOKEN}`).includes(SECRET_TOKEN));
});

test('describeSource reports the provider host without the token', () => {
  const described = describeSource(SOURCE);
  const json = JSON.stringify(described);
  assert.ok(!json.includes(SECRET_TOKEN), 'describeSource leaked the token');
  assert.ok(!json.includes('/ical/'), 'describeSource leaked the path');
  /* The host IS reported: it tells a household which provider is failing,
   * which is what they need to debug, and carries no credential. */
  assert.equal(described.provider, 'calendar.example.com');
  assert.equal(described.address, 'set (never displayed)');
  assert.equal(described.titles, 'withheld');
  /* There is no url key at all - a settings form cannot round-trip it. */
  assert.equal(Object.hasOwn(described, 'url'), false);
});

test('the fingerprint identifies a source in a log without revealing it', () => {
  const fp = sourceFingerprint(SECRET_URL);
  assert.equal(fp, sourceFingerprint(SECRET_URL), 'fingerprint is not stable');
  assert.notEqual(fp, sourceFingerprint(SECRET_URL + 'x'));
  assert.ok(!fp.includes(SECRET_TOKEN));
  assert.ok(fp.length <= 10);
});

/* ------------------------------------------------------ conditional GETs */

test('an ETag is replayed as If-None-Match on the next refresh', async () => {
  const {fetch, calls} = stubFetch([
    {status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE, etag: '"abc123"', lastModified: 'Mon, 07 Sep 2026 10:00:00 GMT'},
    {status: 304},
  ]);
  let clock = 1_000_000;
  const fetcher = new CalendarFetcher({fetchImpl: fetch, now: () => clock});

  const first = await fetcher.fetchSource(SOURCE);
  assert.equal(first.fromCache, false);
  assert.equal(first.parsed?.events.length, 1);
  assert.equal(calls[0].headers['If-None-Match'], undefined,
    'a conditional header was sent before anything was cached');

  /* Past the refresh interval, so a request is actually made. */
  clock += 60 * 60 * 1000;
  const second = await fetcher.fetchSource(SOURCE);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['If-None-Match'], '"abc123"',
    'the ETag was not replayed; polling a public feed unconditionally is rude');
  assert.equal(calls[1].headers['If-Modified-Since'], 'Mon, 07 Sep 2026 10:00:00 GMT');
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(second.parsed?.events.length, 1);
});

test('a fresh cache is served without any request at all', async () => {
  const {fetch, calls} = stubFetch([{status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE, etag: '"v1"'}]);
  let clock = 1_000_000;
  const fetcher = new CalendarFetcher({fetchImpl: fetch, now: () => clock});

  await fetcher.fetchSource(SOURCE);
  clock += 60_000; // one minute: well inside the refresh interval
  const second = await fetcher.fetchSource(SOURCE);

  assert.equal(calls.length, 1, 'a wall display polled the provider needlessly');
  assert.equal(second.fromCache, true);
});

test('a User-Agent naming the project is sent, not a blank or a spoofed browser', async () => {
  const {fetch, calls} = stubFetch([{status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE}]);
  await new CalendarFetcher({fetchImpl: fetch}).fetchSource(SOURCE);
  assert.match(calls[0].headers['User-Agent'], /CommonHomeCanvas/);
});

/* ------------------------------------------------- graceful degradation */

test('a failed refresh serves last-known-good rather than blanking the screen', async () => {
  const {fetch} = stubFetch([
    {status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE, etag: '"v1"'},
    {status: 500},
  ]);
  let clock = 1_000_000;
  const fetcher = new CalendarFetcher({fetchImpl: fetch, now: () => clock});

  await fetcher.fetchSource(SOURCE);
  clock += 60 * 60 * 1000;
  const degraded = await fetcher.fetchSource(SOURCE);

  /* Yesterday's events, disclosed as stale. A household still learns when
   * the bins go out. */
  assert.equal(degraded.stale, true);
  assert.deepEqual(degraded.degraded, ['calendar']);
  assert.equal(degraded.parsed?.events.length, 1, 'the cached events were discarded');
});

test('load() discloses staleness so the display can say so rather than lie', async () => {
  const {fetch} = stubFetch([
    {status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE, etag: '"v1"'},
    {status: 503},
  ]);
  let clock = Date.parse('2026-09-07T00:00:00Z');
  const fetcher = new CalendarFetcher({fetchImpl: fetch, displayZone: 'UTC', now: () => clock});

  await fetcher.load(SOURCE, {now: new Date(clock)});
  clock += 60 * 60 * 1000;
  const shaped = await fetcher.load(SOURCE, {now: new Date(clock)});

  assert.ok(shaped.degraded.includes('calendar-stale'));
  assert.ok(shaped.events.length > 0, 'a failed refresh blanked the calendar');
});

test('an HTML error page served with a 200 is treated as a failure, not an empty calendar', async () => {
  const {fetch} = stubFetch([{status: 200, body: '<!doctype html><html><body>Sign in</body></html>'}]);
  const result = await new CalendarFetcher({fetchImpl: fetch}).fetchSource(SOURCE);
  assert.equal(result.parsed, null);
  assert.deepEqual(result.degraded, ['calendar'],
    'a login page parsed as a calendar with zero events, which reads as "nothing on"');
});

test('a timeout degrades rather than hanging the display', async () => {
  const slow: FetchLike = async (_url, init) => {
    await new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      setTimeout(resolve, 50);
    });
    throw new Error('unreachable');
  };
  const fetcher = new CalendarFetcher({fetchImpl: slow});
  const result = await fetcher.fetchSource({...SOURCE, id: 'slow'});
  assert.equal(result.parsed, null);
  assert.deepEqual(result.degraded, ['calendar']);
});

/* --------------------------------------------------------- URL handling */

test('webcal:// is accepted, because it is what Apple and Outlook hand out', () => {
  const result = normaliseSourceUrl('webcal://calendar.example.com/feed.ics');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.url, 'https://calendar.example.com/feed.ics');
});

test('plain http is refused off-loopback, since the URL is a bearer credential', () => {
  const remote = normaliseSourceUrl('http://calendar.example.com/feed.ics');
  assert.equal(remote.ok, false);
  assert.equal(remote.ok === false && remote.reason, 'a calendar address must be https');

  /* Loopback is allowed: a household testing locally is not putting a token
   * on the wire. */
  assert.equal(normaliseSourceUrl('http://127.0.0.1:4210/feed.ics').ok, true);
});

test('a rejection reason never quotes the input, which may BE the credential', () => {
  const bad = normaliseSourceUrl('not a url ' + SECRET_TOKEN);
  assert.equal(bad.ok, false);
  assert.ok(!(bad.ok === false && bad.reason.includes(SECRET_TOKEN)),
    'the error message echoed the credential back');
  assert.equal(normaliseSourceUrl('').ok, false);
});

/* ------------------------------------------------- end-to-end share safety */

test('load() on a shared source is share-safe end to end', async () => {
  const {fetch} = stubFetch([{status: 200, body: LEAKY_PRIVATE_DETAIL}]);
  const fetcher = new CalendarFetcher({fetchImpl: fetch, displayZone: 'America/Denver'});
  const shaped = await fetcher.load(SOURCE, {now: new Date('2026-09-22T12:00:00Z')});

  const json = JSON.stringify(shaped);
  assert.deepEqual(auditShared(shaped), []);
  for (const secret of ['123 Imaginary Lane', 'ZZ1 9ZZ', '555-0100', 'Fixtureperson', SECRET_TOKEN]) {
    assert.ok(!json.includes(secret), `end-to-end load leaked: ${secret}`);
  }
  assert.ok(!json.includes('Clinic Appointment'), 'titles were published without opt-in');
});

test('changing the URL forgets the cached body, so a revoked link stops working', async () => {
  const {fetch, calls} = stubFetch([{status: 200, body: WEEKLY_WITH_UNTIL_AND_EXDATE, etag: '"v1"'}]);
  const fetcher = new CalendarFetcher({fetchImpl: fetch});
  await fetcher.fetchSource(SOURCE);
  fetcher.forget(SOURCE.id);
  await fetcher.fetchSource(SOURCE);
  assert.equal(calls.length, 2, 'a forgotten source was still served from cache');
  assert.equal(calls[1].headers['If-None-Match'], undefined);
});

/* --------------------------------------------------- publication hygiene */

test('no household value is hardcoded in the calendar sources or fixtures', async () => {
  /* Mirrors the existing scan in server.test.ts, extended to the modules this
   * phase adds. This repository is exported to a public one, so a real
   * address, a LAN IP or - worst of all - a real calendar URL baked into a
   * source file or a test fixture would be published.
   *
   * The patterns stay generic: a leak detector that spells out the private
   * value publishes it, which is the bug it exists to prevent. */
  const {readFile} = await import('node:fs/promises');
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a developer home directory', /\/home\/\w/],
    /* A calendar URL carrying a long opaque token is the credential this
     * phase exists to protect. None may ever be committed. */
    ['a calendar URL with an embedded token', /https?:\/\/[^\s'"`]*\/[0-9a-f]{16,}/i],
    /* example.com is reserved by RFC 2606 and is the only host that may
     * appear in a committed subscription link. */
    ['a webcal subscription link', /webcal:\/\/(?![\w-]*\.?example\.com\b)[^\s'"`]+/i],
  ];

  const files = [
    new URL('./calendar.ts', import.meta.url),
    new URL('./calendar.test.ts', import.meta.url),
    new URL('./calendar.live.test.ts', import.meta.url),
    new URL('../calendar/parse.ts', import.meta.url),
    new URL('../calendar/recurrence.ts', import.meta.url),
    new URL('../calendar/shape.ts', import.meta.url),
    new URL('../calendar/blocks.ts', import.meta.url),
    new URL('../calendar/time.ts', import.meta.url),
    new URL('../calendar/fixtures.ts', import.meta.url),
  ];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const name = file.pathname.split('/').pop();
    for (const [label, pattern] of forbidden) {
      const hit = pattern.exec(text);
      /* Reports the MATCH only. An assertion that dumps the whole file would
       * print the very value it is guarding, into a CI log. */
      assert.equal(hit?.[0] ?? null, null, `${name} contains ${label}`);
    }
  }
});

test('every host named in a fixture is a reserved example domain', async () => {
  /* RFC 2606 reserves example.com precisely so test data never points at
   * somebody's real server. */
  const {readFile} = await import('node:fs/promises');
  const text = await readFile(new URL('../calendar/fixtures.ts', import.meta.url), 'utf8');
  const hosts = text.match(/@[\w.-]+\.\w+/g) ?? [];
  assert.ok(hosts.length > 0, 'the fixtures should contain some addresses to check');
  for (const host of hosts) {
    assert.match(host, /@(?:[\w-]+\.)*example\.com$/, `fixture references a non-example host: ${host}`);
  }
});
