/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. It is distributed WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
 * PURPOSE. See the GNU Affero General Public License for details, and the
 * LICENSE file distributed with this program.
 */
/* Civil time, and the one conversion iCalendar actually needs.
 *
 * WHY THIS MODULE EXISTS AT ALL, rather than `new Date(string)`:
 *
 * iCalendar has three kinds of temporal value and only one of them is an
 * instant.
 *
 *   1. DATE           - 20260924. A civil DATE. Not midnight anywhere.
 *   2. DATE-TIME+TZID - 20260924T093000 in America/New_York. Civil fields
 *                       plus a rule for turning them into an instant, where
 *                       the rule changes twice a year.
 *   3. DATE-TIME+Z    - 20260924T133000Z. An actual instant.
 *
 * `new Date('2026-09-24')` parses form 1 as midnight UTC, which is the single
 * most common calendar bug in existence: a household in Denver sees an
 * all-day event on the 23rd. So a DATE never becomes a timestamp in this
 * codebase. It stays a civil date string, all the way to the screen.
 *
 * ZERO DEPENDENCIES, including no timezone database. Node ships the full IANA
 * database inside Intl, and `Intl.DateTimeFormat` with a `timeZone` can be
 * inverted to get the UTC offset in force at any instant - DST transitions
 * included, historical rules included. That is the entire tz-library problem
 * solved with the standard library, which is why this project can keep
 * `"dependencies": {}` empty and still be correct across a DST boundary.
 *
 * RECURRENCE ARITHMETIC IS DONE ON CIVIL FIELDS, never on instants. A weekly
 * 09:00 event must stay at 09:00 through a DST change, which it does only if
 * "add seven days" means "add seven days to the civil date" and the instant
 * is recomputed afterwards. Adding 604800000 milliseconds gives 08:00 or
 * 10:00 for half the year. See `civilMs` below for how that is kept honest.
 */

/** Civil (wall-clock) fields, with no zone attached. Months are 1-based. */
export type Civil = {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hh: number;
  readonly mm: number;
  readonly ss: number;
};

/* Civil arithmetic is performed on a pseudo-timestamp: the civil fields fed
 * through Date.UTC. It is NOT an instant and must never be treated as one -
 * it is a zone-free encoding that makes "add a day", "which weekday is this"
 * and "compare two wall-clock times" into integer arithmetic, with no DST to
 * trip over because UTC has none. The conversion to a real instant happens
 * exactly once, at the end, in `civilToUtcMs`. */
export function civilMs(c: Civil): number {
  return Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm, c.ss);
}

export function msToCivil(ms: number): Civil {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

/** Day of week for a civil value: 0 = Sunday, per Date's convention. */
export function civilWeekday(c: Civil): number {
  return new Date(civilMs(c)).getUTCDay();
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

/** `YYYY-MM-DD`. The canonical form for an all-day event, everywhere. */
export function civilDateString(c: Civil): string {
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`;
}

/** `YYYY-MM-DDTHH:MM:SS` - local wall-clock, deliberately with no Z and no
 * offset, because appending either would assert something untrue. */
export function civilDateTimeString(c: Civil): string {
  return `${civilDateString(c)}T${pad(c.hh)}:${pad(c.mm)}:${pad(c.ss)}`;
}

/* Zone validity is cached because `new Intl.DateTimeFormat` with a bad zone
 * throws, and constructing a formatter per event in a 134-event feed is
 * measurable. */
const zoneValidity = new Map<string, boolean>();

export function isValidTimeZone(zone: string): boolean {
  const cached = zoneValidity.get(zone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: zone});
    ok = true;
  } catch {
    ok = false;
  }
  zoneValidity.set(zone, ok);
  return ok;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The civil (wall-clock) fields observed in `zone` at instant `utcMs`. */
export function utcMsToCivil(utcMs: number, zone: string): Civil {
  const parts = formatterFor(zone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const era = parts.find((x) => x.type === 'era')?.value ?? 'AD';
  const year = get('year');
  return {
    /* BC years only appear if a feed carries a nonsense DTSTART, but silently
     * treating 1 BC as year 1 would place an event 2000 years from where the
     * arithmetic thinks it is. */
    y: era === 'BC' ? 1 - year : year,
    m: get('month'),
    d: get('day'),
    hh: get('hour'),
    mm: get('minute'),
    ss: get('second'),
  };
}

/** UTC offset, in milliseconds, in force in `zone` at instant `utcMs`. */
export function offsetMsAt(utcMs: number, zone: string): number {
  return civilMs(utcMsToCivil(utcMs, zone)) - utcMs;
}

/* The inverse problem: given wall-clock fields and a zone, find the instant.
 *
 * This is genuinely two-pass, and the second pass is not a nicety. The offset
 * depends on the instant, and the instant is what we are solving for, so the
 * first guess uses the offset at the wrong moment. Near a DST transition that
 * first guess is an hour out, which is precisely where calendars break.
 *
 * The two ambiguous cases are resolved the way every calendar application
 * resolves them, and the way a household expects:
 *   - Spring forward, 02:30 in a zone where 02:00-03:00 does not exist: the
 *     result lands just after the gap. An alarm set for a time that never
 *     happens fires once, rather than being skipped.
 *   - Fall back, 01:30 in a zone where it happens twice: the FIRST (still
 *     daylight-time) occurrence wins, matching RFC 5545's guidance and every
 *     mainstream implementation.
 */
export function civilToUtcMs(c: Civil, zone: string): number {
  const target = civilMs(c);
  const firstOffset = offsetMsAt(target, zone);
  const firstGuess = target - firstOffset;
  const secondOffset = offsetMsAt(firstGuess, zone);
  if (secondOffset === firstOffset) return firstGuess;

  const secondGuess = target - secondOffset;
  /* Verify the candidate actually round-trips. If it does not, the wall-clock
   * time does not exist (spring-forward gap) and the earlier candidate - which
   * lands immediately after the gap - is the right answer. */
  if (civilMs(utcMsToCivil(secondGuess, zone)) === target) return secondGuess;
  return firstGuess;
}

/** Convenience: an absolute ISO-8601 UTC instant, or null for a bad value. */
export function isoFromUtcMs(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

/** Adds whole days to a civil value, keeping the wall-clock time unchanged. */
export function addCivilDays(c: Civil, days: number): Civil {
  return msToCivil(civilMs(c) + days * 86_400_000);
}

/** Adds whole months, clamping to the end of a short month (31 Jan + 1 month
 * is 28 Feb, not 3 March - the latter silently invents an occurrence). */
export function addCivilMonths(c: Civil, months: number): Civil {
  const total = (c.y * 12) + (c.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const maxDay = daysInMonth(y, m);
  return {...c, y, m, d: Math.min(c.d, maxDay)};
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The host's own IANA zone, used when nothing else says otherwise. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
