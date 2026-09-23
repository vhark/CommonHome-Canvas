/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* Route handler tests: the last line of defence, and the level rules. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {CalendarFetcher, type CalendarSource, type FetchLike} from './calendar.ts';
import {emptyCalendar, handleCalendarRequest} from './calendar-route.ts';
import {LEAKY_PRIVATE_DETAIL} from '../calendar/fixtures.ts';

const SECRET_URL = 'https://calendar.example.com/ical/s3cr3t-t0ken-9f2b1a/basic.ics';
const NOW = new Date('2026-09-22T12:00:00Z');

const okFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  headers: {get: () => null},
  async text() {
    return LEAKY_PRIVATE_DETAIL;
  },
});

function setup(level: CalendarSource['level'] = 'private') {
  const source: CalendarSource = {id: 'cal-1', label: 'Fixture Calendar', url: SECRET_URL, level};
  const fetcher = new CalendarFetcher({fetchImpl: okFetch, displayZone: 'America/Denver'});
  return {fetcher, sources: new Map([[source.id, source]])};
}

test('an unknown source is a uniform 404, so the route cannot be enumerated', async () => {
  const {fetcher, sources} = setup();
  const result = await handleCalendarRequest(fetcher, sources, {sourceId: 'nope', level: 'shared'});
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, {error: 'not found'});
});

test('a shared request on a private source is shaped as SHARED', async () => {
  const {fetcher, sources} = setup('private');
  const result = await handleCalendarRequest(fetcher, sources,
    {sourceId: 'cal-1', level: 'shared', now: NOW});

  assert.equal(result.status, 200);
  const json = JSON.stringify(result.body);
  /* The stricter of the two wins. A private source reached through a share
   * link must not publish its detail. */
  assert.ok(!json.includes('123 Imaginary Lane'), 'a share link published a private source in full');
  assert.ok(!json.includes('"description"'));
  assert.ok(!json.includes('"location"'));
  assert.ok(!json.includes('"attendees"'));
});

test('a private request on a shared source stays shared, the safe direction', async () => {
  const {fetcher, sources} = setup('shared');
  const result = await handleCalendarRequest(fetcher, sources,
    {sourceId: 'cal-1', level: 'private', now: NOW});
  assert.equal((result.body as {level: string}).level, 'shared');
  assert.ok(!JSON.stringify(result.body).includes('123 Imaginary Lane'));
});

test('a private request on a private source does carry the detail', async () => {
  const {fetcher, sources} = setup('private');
  const result = await handleCalendarRequest(fetcher, sources,
    {sourceId: 'cal-1', level: 'private', now: NOW});
  assert.equal((result.body as {level: string}).level, 'private');
  assert.ok(JSON.stringify(result.body).includes('123 Imaginary Lane'),
    'the private path lost the detail, so the share test proves nothing');
});

test('the response never carries the source URL, at any level', async () => {
  for (const level of ['private', 'shared'] as const) {
    const {fetcher, sources} = setup(level);
    const result = await handleCalendarRequest(fetcher, sources,
      {sourceId: 'cal-1', level, now: NOW});
    const json = JSON.stringify(result.body);
    assert.ok(!json.includes(SECRET_URL));
    assert.ok(!json.includes('s3cr3t-t0ken-9f2b1a'));
    assert.ok(!json.includes('calendar.example.com'));
  }
});

test('a thrown error becomes a 503 with a well-formed empty payload, never a stack', async () => {
  const thrower: FetchLike = async (url) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  };
  /* Force the failure past the fetcher's own catch by breaking load(). */
  const fetcher = new CalendarFetcher({fetchImpl: thrower});
  const broken = {
    load: async () => {
      throw new Error(`boom ${SECRET_URL}`);
    },
  } as unknown as CalendarFetcher;

  const sources = new Map<string, CalendarSource>([
    ['cal-1', {id: 'cal-1', label: 'X', url: SECRET_URL, level: 'shared'}],
  ]);
  const result = await handleCalendarRequest(broken, sources, {sourceId: 'cal-1', level: 'shared'});

  assert.equal(result.status, 503);
  const json = JSON.stringify(result.body);
  assert.ok(!json.includes('s3cr3t-t0ken-9f2b1a'), 'an error message leaked the credential');
  assert.ok(!json.includes('boom'));
  /* Shape preserved, so the client keeps rendering rather than blanking. */
  assert.deepEqual((result.body as {events: unknown[]}).events, []);
  assert.ok(fetcher instanceof CalendarFetcher);
});

test('the route FAILS CLOSED if a forbidden field ever reaches a shared payload', async () => {
  /* Simulates the regression the audit exists for: a future shaping bug that
   * lets a location through. The household gets an empty block and a log
   * entry, not a published address. */
  const leaky = {
    load: async () => ({
      name: 'X',
      level: 'shared' as const,
      generatedAt: NOW.toISOString(),
      warnings: [],
      degraded: [],
      events: [{id: 'a', date: '2026-09-25', startTime: null, endTime: null,
        allDay: true, band: 'all-day' as const, tentative: false, busy: true,
        location: '123 Imaginary Lane'}],
    }),
  } as unknown as CalendarFetcher;

  const sources = new Map<string, CalendarSource>([
    ['cal-1', {id: 'cal-1', label: 'X', url: SECRET_URL, level: 'shared'}],
  ]);
  const result = await handleCalendarRequest(leaky, sources, {sourceId: 'cal-1', level: 'shared'});

  assert.equal(result.status, 500, 'a leaking payload was served with a 200');
  assert.ok(!JSON.stringify(result.body).includes('123 Imaginary Lane'));
  assert.deepEqual((result.body as {degraded: string[]}).degraded, ['calendar-blocked']);
});

test('responses are never cached, since a calendar is per-viewer', async () => {
  const {fetcher, sources} = setup();
  const result = await handleCalendarRequest(fetcher, sources, {sourceId: 'cal-1', level: 'shared'});
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.match(result.headers['Content-Type'], /application\/json/);
});

test('emptyCalendar is well-formed so a first-boot display renders its empty state', () => {
  const empty = emptyCalendar('shared');
  assert.deepEqual(empty.events, []);
  assert.equal(empty.level, 'shared');
  assert.deepEqual(empty.degraded, ['calendar']);
  assert.ok(!Number.isNaN(Date.parse(empty.generatedAt)));
});
