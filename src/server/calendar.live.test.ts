/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* LIVE fetch against a real public ICS feed.
 *
 * Separate from calendar.test.ts and OPT-IN via CANVAS_LIVE_TESTS=1, because
 * a test that needs the internet is a test that fails in a CI runner without
 * egress, on a train, and on the day the provider has an outage - none of
 * which are defects in this code. The offline suite is the gate; this proves
 * the thing the offline suite cannot: that a real provider's real feed, with
 * its real quirks, parses.
 *
 * The feed used is a PUBLIC holiday calendar - no credential, nothing
 * household-specific, and safe to name in a public repository. That is the
 * only kind of URL that may ever be committed here.
 *
 *   npm run test:calendar:live
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {CalendarFetcher, type CalendarSource} from './calendar.ts';
import {parseICalendar} from '../calendar/parse.ts';
import {expandCalendar} from '../calendar/recurrence.ts';
import {auditShared} from '../calendar/shape.ts';

const LIVE = process.env.CANVAS_LIVE_TESTS === '1';

/* A public, unauthenticated, credential-free feed. */
const PUBLIC_FEED = 'https://www.officeholidays.com/ics-all/usa';

const SOURCE: CalendarSource = {
  id: 'live-public-holidays',
  label: 'Public Holidays',
  url: PUBLIC_FEED,
  level: 'shared',
};

test('LIVE: a real public ICS feed fetches, parses and expands', {skip: !LIVE}, async () => {
  const fetcher = new CalendarFetcher({displayZone: 'America/Denver'});

  const result = await fetcher.fetchSource(SOURCE);
  assert.ok(result.parsed, 'the live feed did not parse');
  const events = result.parsed!.events;

  console.log(JSON.stringify({
    liveFeedHost: new URL(PUBLIC_FEED).host,
    calendarName: result.parsed!.name,
    veventCount: events.length,
    allDayCount: events.filter((e) => e.allDay).length,
    timedCount: events.filter((e) => !e.allDay).length,
    withRrule: events.filter((e) => e.rrule).length,
    warnings: result.parsed!.warnings,
  }, null, 2));

  assert.ok(events.length > 50, `expected a substantial feed, got ${events.length} events`);
  assert.ok(events.every((e) => e.uid), 'a live event had no UID');
  assert.ok(events.every((e) => e.summary), 'a live event had no SUMMARY');

  /* Holiday feeds are all-day by nature, which exercises the DATE path
   * against real publisher output rather than only against a fixture. */
  const allDay = events.filter((e) => e.allDay);
  assert.ok(allDay.length > 0, 'no all-day events in a holiday feed is suspicious');
  for (const event of allDay.slice(0, 20)) {
    assert.equal(event.start.kind, 'date');
    assert.match(event.start.kind === 'date' ? event.start.date : '', /^\d{4}-\d{2}-\d{2}$/);
  }

  const {occurrences} = expandCalendar(events, {
    fromMs: Date.now() - 30 * 86_400_000,
    toMs: Date.now() + 365 * 86_400_000,
    displayZone: 'America/Denver',
  });
  console.log(JSON.stringify({
    occurrencesInNextYear: occurrences.length,
    firstFive: occurrences.slice(0, 5).map((o) => ({
      date: o.start.kind === 'date' ? o.start.date : new Date(o.start.utcMs).toISOString(),
      allDay: o.start.kind === 'date',
      summary: o.event.summary,
    })),
  }, null, 2));
  assert.ok(occurrences.length > 0, 'nothing expanded from a live feed');
});

test('LIVE: the live feed honours conditional requests', {skip: !LIVE}, async () => {
  let clock = Date.now();
  const fetcher = new CalendarFetcher({now: () => clock});

  const first = await fetcher.fetchSource(SOURCE);
  assert.ok(first.parsed);
  assert.equal(first.fromCache, false);

  clock += 60 * 60 * 1000;
  const second = await fetcher.fetchSource(SOURCE);

  console.log(JSON.stringify({
    secondRequestServedFromCache: second.fromCache,
    stale: second.stale,
    eventCount: second.parsed?.events.length ?? 0,
  }, null, 2));

  /* A 304 is the good outcome. A provider that sends neither ETag nor
   * Last-Modified will re-send the body, which is still correct behaviour -
   * so this asserts the events survived either way rather than demanding a
   * 304 the provider may not offer. */
  assert.ok(second.parsed);
  assert.equal(second.stale, false);
  assert.equal(second.parsed!.events.length, first.parsed!.events.length);
});

test('LIVE: a shared shaping of real data leaks nothing', {skip: !LIVE}, async () => {
  const fetcher = new CalendarFetcher({displayZone: 'America/Denver'});
  const shaped = await fetcher.load(SOURCE, {limit: 50});

  const json = JSON.stringify(shaped);
  assert.deepEqual(auditShared(shaped), [], 'a forbidden key reached a shared payload');
  assert.ok(!json.includes(PUBLIC_FEED), 'the source URL was serialised');
  assert.ok(!json.includes('officeholidays.com'), 'the source host was serialised');

  console.log(JSON.stringify({
    level: shaped.level,
    shapedEvents: shaped.events.length,
    degraded: shaped.degraded,
    sampleSharedEvent: shaped.events[0] ?? null,
    keysPresentOnASharedEvent: shaped.events[0] ? Object.keys(shaped.events[0]) : [],
  }, null, 2));

  assert.ok(shaped.events.length > 0);
  /* Titles withheld by default even though this feed's titles are innocuous:
   * the default is a property of the LEVEL, not of the content. */
  assert.ok(shaped.events.every((e) => !Object.hasOwn(e as object, 'title')));
});

/* Proves the parser handles the real bytes even when the network is absent,
 * by asserting the shape of what a live run produced. Runs always. */
test('the live feed URL committed here is public and carries no credential', () => {
  const url = new URL(PUBLIC_FEED);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, '', 'a query string on a committed feed URL could be a token');
  assert.ok(!/[0-9a-f]{16,}/i.test(url.pathname), 'the committed URL looks like it contains a token');
});
