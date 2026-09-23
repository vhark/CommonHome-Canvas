/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* THE LEAK TESTS.
 *
 * Every assertion about a shared payload is made against the SERIALISED JSON,
 * not against the object. That is deliberate and it is the whole point: a
 * field can be present on an object and invisible to a naive property check -
 * non-enumerable, inherited from a prototype, or smuggled in by a toJSON -
 * and still travel to the browser. JSON is what the browser actually
 * receives, so JSON is what is audited.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {parseICalendar} from './parse.ts';
import {expandCalendar} from './recurrence.ts';
import {auditShared, bandFor, NEVER_SHARED_KEYS, shapeCalendar} from './shape.ts';
import {LEAKY_PRIVATE_DETAIL, STATUS_AND_TRANSP} from './fixtures.ts';

const ZONE = 'America/Denver';
const NOW = new Date('2026-09-22T12:00:00Z');

function occurrencesFrom(ics: string) {
  const parsed = parseICalendar(ics, {displayZone: ZONE});
  const {occurrences} = expandCalendar(parsed.events, {
    fromMs: Date.parse('2026-09-01T00:00:00Z'),
    toMs: Date.parse('2026-10-31T00:00:00Z'),
    displayZone: ZONE,
  });
  return {parsed, occurrences};
}

/* The exact strings planted in the fixture. If any of these appears in a
 * shared payload, a real household's address has leaked in the same way. */
const SECRETS = [
  '123 Imaginary Lane',
  'Nowhere Town',
  'ZZ1 9ZZ',
  '555-0100',
  'Fixtureperson',
  '45 Pretend Street',
  'FIXTURE-7',
  'depot@example.com',
];

test('a shared snapshot CONTAINS no description, location or attendee key', () => {
  const {parsed, occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const shared = shapeCalendar(occurrences, {
    level: 'shared',
    displayZone: ZONE,
    name: parsed.name,
    now: NOW,
  });

  const json = JSON.stringify(shared);

  /* Asserted on the SERIALISED form: a hidden-but-present field fails here. */
  for (const key of ['description', 'location', 'attendees', 'organizer', 'uid']) {
    assert.ok(!json.includes(`"${key}"`), `shared payload carries a "${key}" key`);
  }
  assert.deepEqual(auditShared(shared), [], 'auditShared found a forbidden key');

  /* And nothing planted in the fixture survives, by value as well as by key -
   * which catches a field renamed rather than removed. */
  for (const secret of SECRETS) {
    assert.ok(!json.includes(secret), `shared payload leaked: ${secret}`);
  }

  /* The events are still there: this is a share, not a blank. */
  assert.ok(shared.events.length > 0);
  assert.equal(shared.level, 'shared');
});

test('a shared snapshot withholds titles by default and the key is ABSENT', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const shared = shapeCalendar(occurrences, {level: 'shared', displayZone: ZONE, now: NOW});
  const json = JSON.stringify(shared);

  assert.ok(!json.includes('"title"'), 'titles were published without being opted in');
  assert.ok(!json.includes('Green Bin Collection'));
  assert.ok(!json.includes('Clinic Appointment'),
    'an event title revealed a medical appointment on a public link');

  /* Absent, not blanked: nothing downstream can distinguish a withheld title
   * from an untitled event and "helpfully" reach for the raw one. */
  for (const event of shared.events) {
    assert.equal(Object.hasOwn(event as object, 'title'), false);
  }
});

test('opting titles in publishes ONLY titles, never the other private fields', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const shared = shapeCalendar(occurrences, {
    level: 'shared',
    showTitles: true,
    displayZone: ZONE,
    now: NOW,
  });
  const json = JSON.stringify(shared);

  assert.ok(json.includes('Green Bin Collection'), 'opt-in titles did not appear');
  /* The upgrade is titles and nothing else. */
  assert.deepEqual(auditShared(shared), []);
  for (const secret of SECRETS) {
    assert.ok(!json.includes(secret), `opting into titles also leaked: ${secret}`);
  }
});

test('times are always published, at both levels', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  for (const level of ['private', 'shared'] as const) {
    const shaped = shapeCalendar(occurrences, {level, displayZone: ZONE, now: NOW});
    assert.ok(shaped.events.every((e) => typeof e.date === 'string' && e.date.length === 10));
    const timed = shaped.events.find((e) => !e.allDay);
    assert.ok(timed, 'the timed fixture event vanished');
    assert.match(timed!.startTime!, /^\d{2}:\d{2}$/);
  }
});

test('a private shaping DOES carry the detail - the levels genuinely differ', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const private_ = shapeCalendar(occurrences, {level: 'private', displayZone: ZONE, now: NOW});
  const json = JSON.stringify(private_);

  /* If this fails, the leak tests above are passing vacuously - the fixture
   * would be carrying nothing to leak. */
  assert.ok(json.includes('123 Imaginary Lane'), 'the fixture carries no private detail to protect');
  assert.ok(json.includes('"description"'));
  assert.ok(json.includes('"location"'));
  assert.ok(json.includes('"attendees"'));
  assert.ok(json.includes('Green Bin Collection'));
});

test('the shared shape is built by construction, so a new private field cannot leak', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);

  /* Simulates the regression this design exists to prevent: someone adds a
   * field to the event model. If shapeShared spread the private object, this
   * would appear in the share. */
  const contaminated = occurrences.map((o) => ({
    ...o,
    event: {...o.event, futureSecretField: 'SHOULD-NEVER-APPEAR-IN-A-SHARE'},
  }));

  const shared = shapeCalendar(contaminated as typeof occurrences, {
    level: 'shared',
    displayZone: ZONE,
    now: NOW,
  });
  assert.ok(!JSON.stringify(shared).includes('SHOULD-NEVER-APPEAR-IN-A-SHARE'));
  assert.ok(!JSON.stringify(shared).includes('futureSecretField'));
});

test('a hidden-but-present field is caught, which a property check would miss', () => {
  /* Constructs the exact failure mode the serialised assertion exists for. */
  const sneaky = {events: [Object.assign({date: '2026-09-25'}, {toJSON() {
    return {date: '2026-09-25', location: '123 Imaginary Lane'};
  }})]};
  assert.deepEqual(auditShared(sneaky), ['location'],
    'auditShared missed a field smuggled through toJSON');
});

test('the opaque id is not the UID, which can carry an email address', () => {
  const {occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const shared = shapeCalendar(occurrences, {level: 'shared', displayZone: ZONE, now: NOW});
  for (const event of shared.events) {
    assert.ok(!event.id.includes('@'));
    assert.ok(!event.id.includes('example.com'));
    assert.ok(event.id.length > 0 && event.id.length <= 12);
  }
  /* Stable across two shapings, so a browser can key a list on it. */
  const again = shapeCalendar(occurrences, {level: 'shared', displayZone: ZONE, now: NOW});
  assert.deepEqual(shared.events.map((e) => e.id), again.events.map((e) => e.id));
});

test('NEVER_SHARED_KEYS is the list the implementation is written against', () => {
  /* Guards against the list and the code drifting apart. */
  for (const key of ['description', 'location', 'attendees']) {
    assert.ok(NEVER_SHARED_KEYS.includes(key as never), `${key} fell out of NEVER_SHARED_KEYS`);
  }
});

test('an all-day event keeps its own date through shaping, in any display zone', () => {
  for (const zone of ['UTC', 'America/Denver', 'Pacific/Auckland']) {
    const parsed = parseICalendar(LEAKY_PRIVATE_DETAIL, {displayZone: zone});
    const {occurrences} = expandCalendar(parsed.events, {
      fromMs: Date.parse('2026-09-01T00:00:00Z'),
      toMs: Date.parse('2026-10-31T00:00:00Z'),
      displayZone: zone,
    });
    const shaped = shapeCalendar(occurrences, {level: 'private', displayZone: zone, now: NOW});
    const bin = shaped.events.find((e) => e.title === 'Green Bin Collection')!;
    assert.equal(bin.date, '2026-09-25', `the all-day event shifted in ${zone}`);
    assert.equal(bin.allDay, true);
    assert.equal(bin.startTime, null, 'an all-day event was given a clock time');
    assert.equal(bin.band, 'all-day');
  }
});

test('time bands are coarse, because a wall is read at three metres', () => {
  assert.equal(bandFor(null), 'all-day');
  assert.equal(bandFor('08:30'), 'morning');
  assert.equal(bandFor('11:59'), 'morning');
  assert.equal(bandFor('12:00'), 'afternoon');
  assert.equal(bandFor('16:59'), 'afternoon');
  assert.equal(bandFor('17:00'), 'evening');
  assert.equal(bandFor('21:30'), 'evening');
});

test('tentative and busy/free survive shaping at both levels', () => {
  const {occurrences} = occurrencesFrom(STATUS_AND_TRANSP);
  const shared = shapeCalendar(occurrences, {level: 'shared', displayZone: ZONE, now: NOW});
  assert.ok(shared.events.some((e) => e.tentative), 'TENTATIVE was lost');
  assert.ok(shared.events.some((e) => !e.busy), 'TRANSP:TRANSPARENT was lost');
  /* Busy/free with times only IS the safe default shared view. */
  assert.deepEqual(auditShared(shared), []);
});

test('warnings are display-safe: no URL, no event content', () => {
  const {parsed, occurrences} = occurrencesFrom(LEAKY_PRIVATE_DETAIL);
  const shared = shapeCalendar(occurrences, {
    level: 'shared',
    displayZone: ZONE,
    warnings: parsed.warnings,
    now: NOW,
  });
  for (const warning of shared.warnings) {
    assert.ok(!/https?:\/\//.test(warning.message));
    for (const secret of SECRETS) assert.ok(!warning.message.includes(secret));
  }
});
