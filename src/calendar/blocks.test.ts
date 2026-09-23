/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* Block layout logic: pure functions, asserted directly. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agenda,
  dayColumns,
  dayLabel,
  dayOffset,
  groupByDay,
  initials,
  personSlot,
  relativeWhen,
  todayIn,
  upNext,
} from './blocks.ts';
import type {ShapedEvent} from './shape.ts';

const ZONE = 'America/Denver';
/* 22 Sep 2026 is a Tuesday. 15:00Z is 09:00 in Denver. */
const NOW = new Date('2026-09-22T15:00:00Z');
const OPTS = {now: NOW, displayZone: ZONE, locale: 'en-US'};

function event(partial: Partial<ShapedEvent> & {date: string}): ShapedEvent {
  const base = {
    id: partial.id ?? Math.random().toString(36).slice(2, 10),
    date: partial.date,
    startTime: partial.startTime ?? null,
    endTime: partial.endTime ?? null,
    allDay: partial.allDay ?? partial.startTime === undefined,
    band: partial.band ?? 'all-day',
    tentative: partial.tentative ?? false,
    busy: partial.busy ?? true,
  } as ShapedEvent;
  /* The key is only ADDED when there is a title, never set to undefined:
   * `{title: undefined}` satisfies Object.hasOwn and would make the
   * withheld-title assertions pass vacuously. */
  return partial.title === undefined ? base : {...base, title: partial.title};
}

const SAMPLE: ShapedEvent[] = [
  event({date: '2026-09-22', startTime: '08:00', endTime: '08:30', allDay: false, band: 'morning', title: 'Already Finished'}),
  event({date: '2026-09-22', startTime: '14:00', endTime: '15:00', allDay: false, band: 'afternoon', title: 'Dentist'}),
  event({date: '2026-09-22', allDay: true, band: 'all-day', title: 'Bin Day'}),
  event({date: '2026-09-23', startTime: '09:30', endTime: '10:30', allDay: false, band: 'morning', title: 'Swimming'}),
  event({date: '2026-09-25', startTime: '19:00', endTime: '21:00', allDay: false, band: 'evening', title: 'Film Night'}),
  event({date: '2026-10-02', startTime: '10:00', endTime: '11:00', allDay: false, band: 'morning', title: 'Far Future'}),
];

/* --------------------------------------------------------------- grouping */

test("today is the household's civil date, not the server's", () => {
  assert.equal(todayIn(NOW, ZONE), '2026-09-22');
  /* The same instant is already the 23rd in Auckland. */
  assert.equal(todayIn(NOW, 'Pacific/Auckland'), '2026-09-23');
});

test('day offsets are whole days and survive a month boundary', () => {
  assert.equal(dayOffset('2026-09-22', '2026-09-22'), 0);
  assert.equal(dayOffset('2026-09-22', '2026-09-23'), 1);
  assert.equal(dayOffset('2026-09-30', '2026-10-01'), 1);
  assert.equal(dayOffset('2026-09-22', '2026-09-21'), -1);
  /* Across a DST boundary: still exactly 7 days, because these are dates. */
  assert.equal(dayOffset('2026-10-26', '2026-11-02'), 7);
});

test('day labels prefer the words a household uses', () => {
  assert.equal(dayLabel('2026-09-22', OPTS), 'Today');
  assert.equal(dayLabel('2026-09-23', OPTS), 'Tomorrow');
  assert.equal(dayLabel('2026-09-21', OPTS), 'Yesterday');
  assert.equal(dayLabel('2026-09-25', OPTS), 'Friday');
});

test('a weekday label never disagrees with the date it labels', () => {
  /* The label is formatted in UTC against a UTC-constructed date. Formatting
   * in the display zone would reintroduce the off-by-one-day bug. */
  for (const [date, expected] of [
    ['2026-09-25', 'Friday'],
    ['2026-09-26', 'Saturday'],
    ['2026-09-27', 'Sunday'],
    ['2026-09-28', 'Monday'],
  ] as const) {
    assert.equal(dayLabel(date, OPTS), expected);
    for (const zone of ['Pacific/Auckland', 'Pacific/Honolulu']) {
      assert.equal(dayLabel(date, {...OPTS, displayZone: zone}), expected,
        `the label for ${date} changed in ${zone}`);
    }
  }
});

test('within a day, all-day events sort first and timed ones by clock', () => {
  const groups = groupByDay(SAMPLE, OPTS);
  const today = groups.find((g) => g.date === '2026-09-22')!;
  assert.deepEqual(today.events.map((e) => e.title), ['Bin Day', 'Already Finished', 'Dentist']);
  assert.equal(today.isToday, true);
  assert.equal(today.label, 'Today');
});

test('weekends are flagged so a renderer can treat them differently', () => {
  const groups = groupByDay([event({date: '2026-09-26'}), event({date: '2026-09-28'})], OPTS);
  assert.equal(groups[0].isWeekend, true);
  assert.equal(groups[1].isWeekend, false);
});

/* ----------------------------------------------------------------- agenda */

test('the agenda hides finished events but keeps one in progress', () => {
  const inProgress = event({
    date: '2026-09-22', startTime: '08:30', endTime: '10:00',
    allDay: false, band: 'morning', title: 'Current Meeting',
  });
  const model = agenda([...SAMPLE, inProgress], OPTS);
  const titles = model.days.flatMap((d) => d.events.map((e) => e.title));

  assert.ok(!titles.includes('Already Finished'),
    'a finished event is still on the wall, which reads as current');
  assert.ok(titles.includes('Current Meeting'),
    'the meeting the household is currently in was hidden');
  assert.ok(titles.includes('Bin Day'), "today's all-day event was dropped");
  assert.ok(titles.includes('Dentist'));
});

test('the agenda groups by day, in order, and reports overflow', () => {
  const model = agenda(SAMPLE, {...OPTS, limit: 3});
  assert.equal(model.kind, 'agenda');
  assert.deepEqual(model.days.map((d) => d.date), ['2026-09-22', '2026-09-23']);
  assert.deepEqual(model.days.map((d) => d.label), ['Today', 'Tomorrow']);
  /* Five events are eligible (the 08:00 one has finished); three are shown. */
  assert.equal(model.overflow, 2, 'overflow should count what the limit dropped');
  assert.equal(model.empty, false);
});

test('the agenda horizon excludes events beyond it', () => {
  const model = agenda(SAMPLE, {...OPTS, days: 7, limit: 20});
  const dates = model.days.map((d) => d.date);
  assert.ok(!dates.includes('2026-10-02'), 'an event past the horizon was shown');
});

test('an empty agenda says so rather than rendering a blank rectangle', () => {
  const model = agenda([], OPTS);
  assert.equal(model.empty, true);
  assert.equal(model.emptyMessage, 'Nothing scheduled');
  assert.deepEqual(model.days, []);
});

/* ------------------------------------------------------------ day columns */

test('day columns start at today and emphasise exactly one column', () => {
  const model = dayColumns(SAMPLE, {...OPTS, days: 4});
  assert.equal(model.kind, 'day-columns');
  assert.equal(model.columns.length, 4);
  assert.deepEqual(model.columns.map((c) => c.date),
    ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  assert.deepEqual(model.columns.map((c) => c.emphasis), [true, false, false, false]);
  assert.deepEqual(model.columns.map((c) => c.position), [0, 1, 2, 3]);
});

test('an empty day still gets its column, because the layout must not move', () => {
  const model = dayColumns(SAMPLE, {...OPTS, days: 4});
  const quiet = model.columns.find((c) => c.date === '2026-09-24')!;
  assert.deepEqual(quiet.events, [],
    'the quiet day should be present and empty, not absent');
  assert.equal(quiet.label, 'Thursday');
  /* Positions are fixed regardless of contents: after a week the household
   * stops reading the headings and relies on where a day sits. */
  assert.equal(quiet.position, 2);
});

test('the column span is clamped to 3-5 rather than rejected', () => {
  assert.equal(dayColumns([], {...OPTS, days: 1}).columns.length, 3);
  assert.equal(dayColumns([], {...OPTS, days: 99}).columns.length, 5);
  assert.equal(dayColumns([], OPTS).columns.length, 4);
});

test('one busy day cannot push the other columns off the screen', () => {
  const busy = Array.from({length: 20}, (_, i) =>
    event({date: '2026-09-22', startTime: `${String(6 + i % 12).padStart(2, '0')}:00`, allDay: false, band: 'morning', title: `Event ${i}`}));
  const model = dayColumns(busy, {...OPTS, perDay: 5});
  assert.equal(model.columns[0].events.length, 5);
});

/* ---------------------------------------------------------------- up next */

test('up next shows the next one or two items and phrases them relatively', () => {
  const soon = event({
    date: '2026-09-22', startTime: '09:20', endTime: '09:50',
    allDay: false, band: 'morning', title: 'Leaving Soon',
  });
  const model = upNext([soon, ...SAMPLE], OPTS);
  assert.equal(model.kind, 'up-next');
  /* All-day sorts ahead of timed within the day, so Bin Day is primary. */
  assert.equal(model.primary?.title, 'Bin Day');
  assert.equal(model.primary?.when, 'Today');
  assert.equal(model.secondary?.title, 'Leaving Soon');
  assert.equal(model.secondary?.when, 'in 20 min');
});

test('up next can be limited to a single item for the smallest cell', () => {
  const model = upNext(SAMPLE, {...OPTS, count: 1});
  assert.ok(model.primary);
  assert.equal(model.secondary, null);
});

test('relative phrasing degrades to a day name once minutes stop helping', () => {
  const mk = (date: string, startTime: string | null) =>
    event({date, startTime: startTime ?? undefined, allDay: startTime === null,
      band: startTime === null ? 'all-day' : 'morning'});

  assert.equal(relativeWhen(mk('2026-09-22', '09:00'), OPTS), 'Now');
  assert.equal(relativeWhen(mk('2026-09-22', '09:45'), OPTS), 'in 45 min');
  assert.equal(relativeWhen(mk('2026-09-22', '11:00'), OPTS), 'in 2 hr');
  assert.equal(relativeWhen(mk('2026-09-22', '11:30'), OPTS), 'in 2 hr 30 min');
  /* Beyond four hours a clock time reads better than "in 7 hr". */
  assert.equal(relativeWhen(mk('2026-09-22', '18:00'), OPTS), '18:00');
  assert.equal(relativeWhen(mk('2026-09-23', '09:00'), OPTS), 'Tomorrow 09:00');
  assert.equal(relativeWhen(mk('2026-09-25', '19:00'), OPTS), 'Friday 19:00');
  assert.equal(relativeWhen(mk('2026-09-25', null), OPTS), 'Friday');
});

test('up next is empty rather than wrong when nothing is scheduled', () => {
  const model = upNext([], OPTS);
  assert.equal(model.empty, true);
  assert.equal(model.primary, null);
  assert.equal(model.emptyMessage, 'Nothing scheduled');
});

/* ------------------------------------------------- person identification */

test('a person gets a stable slot, so identity is position as well as colour', () => {
  /* Colour-only identity fails for the colour-blind and fails at distance,
   * so position is the primary channel and must be stable. */
  const slot = personSlot('Fixture One', 6);
  assert.equal(personSlot('Fixture One', 6), slot);
  assert.ok(slot >= 0 && slot < 6);
  assert.notEqual(personSlot('Fixture Two', 6), undefined);
  assert.equal(personSlot('', 6), 0);
});

test('initials give a third, non-colour identification channel', () => {
  assert.equal(initials('Fixture Person'), 'FP');
  assert.equal(initials('Mononym'), 'MO');
  assert.equal(initials('  Fixture  Middle  Person '), 'FP');
  assert.equal(initials(''), '');
});

/* ------------------------------------------------------- layout integrity */

test('no layout function mutates the events it is given', () => {
  const input = SAMPLE.map((e) => ({...e}));
  const snapshot = JSON.stringify(input);
  agenda(input, OPTS);
  dayColumns(input, OPTS);
  upNext(input, OPTS);
  groupByDay(input, OPTS);
  assert.equal(JSON.stringify(input), snapshot, 'a layout function mutated its input');
});

test('layouts never invent a field the shaping withheld', () => {
  /* A shared event has no title. No layout may fabricate one - a "Busy"
   * default inserted here would bypass the share-safety decision. */
  const untitled = [event({date: '2026-09-23', startTime: '10:00', allDay: false, band: 'morning'})];
  const model = agenda(untitled, OPTS);
  const shown = model.days[0].events[0];
  assert.equal(Object.hasOwn(shown as object, 'title'), false);
  assert.equal(upNext(untitled, OPTS).primary?.title, undefined);
});
