/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* Parser and recurrence tests, against synthetic fixtures. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  occurrenceKey,
  parseDurationMs,
  parseICalendar,
  parseLine,
  timeToDateString,
  unescapeText,
  unfold,
} from './parse.ts';
import {expandCalendar, parseRRule, UNSUPPORTED_PARTS} from './recurrence.ts';
import {civilToUtcMs, offsetMsAt, utcMsToCivil} from './time.ts';
import {
  ALL_DAY,
  AWKWARD_SYNTAX,
  DST_CROSSING,
  MONTHLY_PATTERNS,
  SERIES_WITH_OVERRIDE,
  STATUS_AND_TRANSP,
  TIMED_WITH_VTIMEZONE,
  UNSUPPORTED_BYSETPOS,
  WEEKLY_WITH_UNTIL_AND_EXDATE,
} from './fixtures.ts';

const DENVER = 'America/Denver';

/** Expand a fixture over a wide window, in one line. */
function occurrencesOf(ics: string, zone = 'UTC', from = '2026-09-01', to = '2027-01-01') {
  const parsed = parseICalendar(ics, {displayZone: zone});
  return expandCalendar(parsed.events, {
    fromMs: Date.parse(`${from}T00:00:00Z`),
    toMs: Date.parse(`${to}T00:00:00Z`),
    displayZone: zone,
  });
}

/* ------------------------------------------------------------ line syntax */

test('folded lines are rejoined and the continuation space is not part of the value', () => {
  const lines = unfold(AWKWARD_SYNTAX);
  const summary = lines.find((l) => l.startsWith('SUMMARY'));
  assert.ok(summary);
  assert.match(summary!, /folded across lines by the publisher$/);
  /* The fold point must not leave a stray space inside the word. */
  assert.ok(!summary!.includes('fo lded'), 'unfolding inserted a space mid-word');
});

test('a quoted parameter containing a comma and a colon does not break the split', () => {
  const line = parseLine('ATTENDEE;CN="Fixture, Person";ROLE=REQ-PARTICIPANT:mailto:person@example.com');
  assert.ok(line);
  assert.equal(line!.name, 'ATTENDEE');
  assert.equal(line!.params.CN, 'Fixture, Person');
  assert.equal(line!.params.ROLE, 'REQ-PARTICIPANT');
  /* The value keeps its own colon: mailto: is not a parameter separator. */
  assert.equal(line!.value, 'mailto:person@example.com');
});

test('escaped text is unescaped: commas survive and \\n becomes a newline', () => {
  assert.equal(unescapeText('Bring cake\\, candles'), 'Bring cake, candles');
  assert.equal(unescapeText('Line one\\nLine two'), 'Line one\nLine two');
  const {events} = parseICalendar(AWKWARD_SYNTAX);
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /^Bring cake, candles/);
  assert.equal(events[0].description, 'Line one\nLine two');
  assert.deepEqual(events[0].attendees, ['Fixture, Person']);
});

test('DURATION is read when a publisher omits DTEND', () => {
  assert.equal(parseDurationMs('PT1H30M'), 5_400_000);
  assert.equal(parseDurationMs('P1D'), 86_400_000);
  assert.equal(parseDurationMs('P2W'), 1_209_600_000);
  assert.equal(parseDurationMs('nonsense'), null);
});

/* ------------------------------------------------------- weekly + UNTIL */

test('a weekly RRULE stops at UNTIL and EXDATE removes exactly one occurrence', () => {
  const {occurrences} = occurrencesOf(WEEKLY_WITH_UNTIL_AND_EXDATE);
  const dates = occurrences.map((o) => timeToDateString(o.start, 'UTC'));

  /* Mondays from 7 Sep to 5 Oct inclusive = 7, 14, 21, 28 Sep, 5 Oct.
   * EXDATE removes 21 Sep, so four remain and UNTIL keeps 5 Oct. */
  assert.deepEqual(dates, ['2026-09-07', '2026-09-14', '2026-09-28', '2026-10-05']);
  assert.ok(!dates.includes('2026-09-21'), 'EXDATE did not remove its occurrence');
  /* Nothing past UNTIL, even though the query window runs to January. */
  assert.ok(dates.every((d) => d <= '2026-10-05'), 'an occurrence escaped past UNTIL');
});

test('EXDATE matching is by occurrence identity, not by a loose date compare', () => {
  const parsed = parseICalendar(WEEKLY_WITH_UNTIL_AND_EXDATE);
  const series = parsed.events.find((e) => !e.recurrenceId)!;
  assert.equal(series.exdates.length, 1);
  assert.equal(occurrenceKey(series.exdates[0]), `T:${Date.parse('2026-09-21T18:00:00Z')}`);
});

/* ------------------------------------------------------- RECURRENCE-ID */

test('a RECURRENCE-ID override replaces its occurrence and can move it', () => {
  const {occurrences} = occurrencesOf(SERIES_WITH_OVERRIDE);
  assert.equal(occurrences.length, 5, 'override added an instance instead of replacing one');

  const moved = occurrences.filter((o) => o.isOverride);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].event.summary, 'Morning Standup (moved late)');
  /* It moved from 09:00 to 14:00 on the same day. */
  assert.equal(moved[0].start.kind === 'datetime' && moved[0].start.utcMs,
    Date.parse('2026-09-09T14:00:00Z'));

  /* And the original 09:00 slot on that day is gone. */
  const nineAmOnTheNinth = occurrences.some((o) =>
    o.start.kind === 'datetime' && o.start.utcMs === Date.parse('2026-09-09T09:00:00Z'));
  assert.equal(nineAmOnTheNinth, false, 'the overridden occurrence was still emitted');
});

/* ---------------------------------------------- THE ALL-DAY BUG, explicitly */

test('an all-day event is a DATE and lands on that date in every timezone', () => {
  /* The assertion that matters: the SAME calendar date, whatever zone the
   * household is in. A DATE has no instant, so there is nothing to shift. */
  for (const zone of ['UTC', 'America/Denver', 'Pacific/Auckland', 'Asia/Kolkata', 'Pacific/Honolulu']) {
    const parsed = parseICalendar(ALL_DAY, {displayZone: zone});
    const event = parsed.events[0];
    assert.equal(event.allDay, true);
    assert.equal(event.start.kind, 'date');
    assert.equal(timeToDateString(event.start, zone), '2026-09-24',
      `all-day event moved off 2026-09-24 in ${zone}`);
  }
});

test('the all-day event is NOT stored as a timestamp, which is what would shift it', () => {
  const parsed = parseICalendar(ALL_DAY, {displayZone: DENVER});
  const start = parsed.events[0].start;
  /* Structural: there is no utcMs on a date value, so a caller CANNOT render
   * it in the wrong zone by accident - the mistake is unrepresentable. */
  assert.equal(start.kind, 'date');
  assert.equal((start as Record<string, unknown>).utcMs, undefined);
});

test('THE MIDNIGHT-UTC TRAP: this test fails if a DATE is treated as an instant', () => {
  /* Demonstrates the bug concretely rather than asserting its absence in the
   * abstract. This is what the naive implementation does: */
  const naive = new Date('2026-09-24');           // parsed as midnight UTC
  const naiveDenverDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: DENVER, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(naive);
  assert.equal(naiveDenverDate, '2026-09-23',
    'precondition: midnight-UTC parsing really does shift a day west of UTC');

  /* And this is what the parser does instead. If someone "simplifies" IcsTime
   * to a Date, this assertion flips to 2026-09-23 and the test fails. */
  const parsed = parseICalendar(ALL_DAY, {displayZone: DENVER});
  assert.equal(timeToDateString(parsed.events[0].start, DENVER), '2026-09-24');
  assert.notEqual(timeToDateString(parsed.events[0].start, DENVER), naiveDenverDate);
});

test('an all-day event with no DTEND still covers exactly one day', () => {
  const noEnd = ALL_DAY.replace('DTEND;VALUE=DATE:20260925\n', '');
  const parsed = parseICalendar(noEnd);
  assert.equal(parsed.events[0].end.kind, 'date');
  assert.equal(parsed.events[0].end.kind === 'date' && parsed.events[0].end.date, '2026-09-25');
});

/* -------------------------------------------------------------- VTIMEZONE */

test('a timed event with a VTIMEZONE resolves to the right instant', () => {
  const parsed = parseICalendar(TIMED_WITH_VTIMEZONE, {displayZone: 'UTC'});
  const start = parsed.events[0].start;
  assert.equal(start.kind, 'datetime');
  assert.equal(start.kind === 'datetime' && start.zone, DENVER);
  /* 24 Sep 2026 is MDT (UTC-6), so 16:00 local is 22:00Z. */
  assert.equal(start.kind === 'datetime' && start.utcMs, Date.parse('2026-09-24T22:00:00Z'));
  /* And the wall-clock fields are preserved as written. */
  assert.equal(start.kind === 'datetime' && start.civil.hh, 16);
});

test('a timed event renders on the correct local date in its own zone', () => {
  const parsed = parseICalendar(TIMED_WITH_VTIMEZONE, {displayZone: DENVER});
  assert.equal(timeToDateString(parsed.events[0].start, DENVER), '2026-09-24');
  /* The same instant is already the 25th in Auckland, and that is CORRECT for
   * a timed event - unlike an all-day one, it really is a point in time. */
  assert.equal(timeToDateString(parsed.events[0].start, 'Pacific/Auckland'), '2026-09-25');
});

/* ------------------------------------------------------------------- DST */

test('a weekly series keeps its wall-clock time across a DST boundary', () => {
  const {occurrences} = occurrencesOf(DST_CROSSING, DENVER, '2026-10-01', '2026-12-01');
  assert.equal(occurrences.length, 3);

  const local = occurrences.map((o) => {
    const c = utcMsToCivil(o.start.kind === 'datetime' ? o.start.utcMs : 0, DENVER);
    return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')} ${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
  });

  /* US DST ended on 1 Nov 2026. All three are still at 09:00 LOCAL. */
  assert.deepEqual(local, [
    '2026-10-26 09:00',
    '2026-11-02 09:00',
    '2026-11-09 09:00',
  ]);

  /* And the underlying instants are NOT 7 days apart, which is the proof the
   * arithmetic was civil rather than millisecond-based. */
  const a = occurrences[0].start.kind === 'datetime' ? occurrences[0].start.utcMs : 0;
  const b = occurrences[1].start.kind === 'datetime' ? occurrences[1].start.utcMs : 0;
  assert.equal(b - a, 7 * 86_400_000 + 3_600_000,
    'the DST hour was not absorbed; this is the naive +604800000ms bug');
});

test('the offset lookup tracks a real DST transition', () => {
  assert.equal(offsetMsAt(Date.parse('2026-10-26T15:00:00Z'), DENVER), -6 * 3_600_000);
  assert.equal(offsetMsAt(Date.parse('2026-11-02T16:00:00Z'), DENVER), -7 * 3_600_000);
});

test('a wall-clock time inside the spring-forward gap still resolves', () => {
  /* 02:30 on 8 March 2026 does not exist in Denver. It must not be NaN and
   * must not silently become the previous day. */
  const ms = civilToUtcMs({y: 2026, m: 3, d: 8, hh: 2, mm: 30, ss: 0}, DENVER);
  assert.ok(Number.isFinite(ms));
  const back = utcMsToCivil(ms, DENVER);
  assert.equal(back.d, 8);
  assert.equal(back.hh, 3, 'a nonexistent local time should land just after the gap');
});

/* ----------------------------------------------------- monthly patterns */

test('monthly by ordinal weekday and by negative month day both expand', () => {
  const {occurrences} = occurrencesOf(MONTHLY_PATTERNS);

  const firstMondays = occurrences
    .filter((o) => o.event.uid === 'first-monday@example.com')
    .map((o) => timeToDateString(o.start, 'UTC'));
  assert.deepEqual(firstMondays, ['2026-09-07', '2026-10-05', '2026-11-02', '2026-12-07']);

  const lastDays = occurrences
    .filter((o) => o.event.uid === 'last-day@example.com')
    .map((o) => timeToDateString(o.start, 'UTC'));
  /* 30 Sep, 31 Oct, 30 Nov, 31 Dec - the month lengths differ, which is the
   * whole point of BYMONTHDAY=-1. */
  assert.deepEqual(lastDays, ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
});

test('COUNT counts from the series start, not from the query window', () => {
  /* Querying a window that begins after the series does not grant extra
   * occurrences - a classic off-by-a-decade bug on annual events. */
  const parsed = parseICalendar(MONTHLY_PATTERNS);
  const {occurrences} = expandCalendar(parsed.events, {
    fromMs: Date.parse('2026-11-01T00:00:00Z'),
    toMs: Date.parse('2028-01-01T00:00:00Z'),
    displayZone: 'UTC',
  });
  const firstMondays = occurrences.filter((o) => o.event.uid === 'first-monday@example.com');
  assert.equal(firstMondays.length, 2, 'COUNT was re-applied inside the window');
});

/* ------------------------------------------------- declined RRULE features */

test('BYSETPOS is declined with a named warning rather than guessed', () => {
  const {occurrences, warnings} = occurrencesOf(UNSUPPORTED_BYSETPOS);

  const declined = warnings.find((w) => w.code === 'unsupported_rrule_part');
  assert.ok(declined, 'no warning was raised for an unsupported RRULE part');
  assert.equal(declined!.detail, 'BYSETPOS');
  /* The warning is safe to render: no URL, no event content. */
  assert.ok(!/https?:/.test(declined!.message));

  /* The event is not lost - the first instance is still shown, the repeats
   * are not invented. */
  assert.equal(occurrences.length, 1);
  assert.equal(timeToDateString(occurrences[0].start, 'UTC'), '2026-09-30');
});

test('every declined RRULE part is refused by the parser, none silently ignored', () => {
  for (const part of UNSUPPORTED_PARTS) {
    const result = parseRRule(`FREQ=MONTHLY;${part}=1`);
    assert.equal(result.ok, false, `${part} was accepted but is not implemented`);
    assert.equal(result.ok === false && result.warning.detail, part);
  }
});

test('an unsupported FREQ is declined rather than approximated', () => {
  const result = parseRRule('FREQ=HOURLY;COUNT=5');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.warning.code, 'unsupported_freq');
});

test('an infinite rule is capped rather than looping forever', () => {
  const infinite = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:forever@example.com
SUMMARY:Daily Forever
DTSTART:20260101T080000Z
DTEND:20260101T081500Z
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR
`;
  const parsed = parseICalendar(infinite);
  const {occurrences} = expandCalendar(parsed.events, {
    fromMs: Date.parse('2026-01-01T00:00:00Z'),
    toMs: Date.parse('2026-02-01T00:00:00Z'),
    displayZone: 'UTC',
  });
  assert.equal(occurrences.length, 31);
});

/* --------------------------------------------------------- status, transp */

test('CANCELLED is a tombstone and never renders; TENTATIVE and TRANSP survive', () => {
  const {occurrences} = occurrencesOf(STATUS_AND_TRANSP, 'UTC', '2026-09-20', '2026-09-30');
  const uids = occurrences.map((o) => o.event.uid);
  assert.ok(!uids.includes('cancelled@example.com'), 'a cancelled event was rendered');
  assert.ok(uids.includes('transparent@example.com'));
  assert.ok(uids.includes('tentative@example.com'));

  const transparent = occurrences.find((o) => o.event.uid === 'transparent@example.com')!;
  assert.equal(transparent.event.transparent, true);
  const tentative = occurrences.find((o) => o.event.uid === 'tentative@example.com')!;
  assert.equal(tentative.event.status, 'TENTATIVE');
});

/* ------------------------------------------------------------- robustness */

test('a truncated feed yields the events that were complete', () => {
  const truncated = WEEKLY_WITH_UNTIL_AND_EXDATE.slice(0, WEEKLY_WITH_UNTIL_AND_EXDATE.indexOf('END:VEVENT'));
  const parsed = parseICalendar(truncated);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].summary, 'Pottery Club');
});

test('an event with no DTSTART is skipped with a warning, not crashed on', () => {
  const broken = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:no-start@example.com
SUMMARY:Undated
END:VEVENT
END:VCALENDAR
`;
  const parsed = parseICalendar(broken);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.warnings[0].code, 'missing_dtstart');
});

test('a VALARM inside a VEVENT is not mistaken for event properties', () => {
  const withAlarm = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:alarmed@example.com
SUMMARY:Real Summary
DTSTART:20260924T100000Z
DTEND:20260924T110000Z
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Alarm text that is not the event description
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR
`;
  const parsed = parseICalendar(withAlarm);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].summary, 'Real Summary');
  assert.equal(parsed.events[0].description, '',
    "the alarm's DESCRIPTION was attributed to the event");
});

test('the calendar name is read from X-WR-CALNAME when present', () => {
  assert.equal(parseICalendar(WEEKLY_WITH_UNTIL_AND_EXDATE).name, 'Fixture Club Calendar');
  assert.equal(parseICalendar(ALL_DAY).name, null);
});
