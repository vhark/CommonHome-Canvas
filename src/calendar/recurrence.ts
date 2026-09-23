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
/* Recurrence expansion: a deliberately small subset, honestly bounded.
 *
 * WHAT IS SUPPORTED, and why this set:
 *
 *   FREQ=DAILY | WEEKLY | MONTHLY | YEARLY
 *   INTERVAL
 *   BYDAY            - including ordinals for MONTHLY/YEARLY (2TU, -1FR)
 *   BYMONTHDAY       - including negative values (-1 = last day of month)
 *   BYMONTH
 *   COUNT / UNTIL
 *   WKST             - honoured for weekly interval alignment
 *   EXDATE, RDATE, RECURRENCE-ID
 *
 * That covers, in full: "every weekday", "every other Tuesday", "first Monday
 * of the month", "last Friday of the month", "the 15th", "the last day of the
 * month", "annually on a date", and every bin-collection, school-term,
 * payday and club-night pattern a household actually writes down.
 *
 * WHAT IS DECLINED, LOUDLY - see UNSUPPORTED_PARTS below. Each one produces a
 * structured warning and the series is NOT expanded. This is the important
 * design decision in this file, so it is worth defending:
 *
 *   A wrong date on a kitchen wall is worse than a missing one. Someone
 *   misses a hospital appointment. A half-correct BYSETPOS implementation
 *   fails silently - it renders a plausible date that happens to be wrong -
 *   whereas declining produces a visible, explainable gap plus a warning the
 *   settings page can show. The failure mode is the whole argument.
 *
 * ARITHMETIC IS CIVIL, NOT INSTANT-BASED. "Every Monday at 09:00" must stay
 * at 09:00 across a DST change, which is true only if the recurrence walks
 * wall-clock dates and converts to an instant at the end. See time.ts.
 */

import {
  addCivilDays,
  addCivilMonths,
  civilMs,
  civilToUtcMs,
  civilWeekday,
  daysInMonth,
  msToCivil,
  type Civil,
} from './time.ts';
import {
  occurrenceKey,
  type CalendarWarning,
  type IcsEvent,
  type IcsTime,
} from './parse.ts';

/* RRULE parts this expander refuses rather than approximates.
 *
 * BYSETPOS is the notable one: it selects the nth member of the set produced
 * by the other BY* rules within each interval, which means it can only be
 * implemented correctly on top of a full RFC 5545 set-building pipeline. A
 * shortcut that handles "BYSETPOS=-1 with BYDAY" and nothing else would cover
 * the common case and be wrong for the rest, with no signal to the household
 * that it had gone wrong.
 *
 * BYYEARDAY, BYWEEKNO, BYHOUR, BYMINUTE, BYSECOND appear in generated feeds
 * almost never, and each multiplies occurrences within a period rather than
 * selecting among them - a different shape of expansion entirely. */
export const UNSUPPORTED_PARTS = [
  'BYSETPOS',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
] as const;

const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/* A hard ceiling on generated occurrences.
 *
 * An RRULE with neither COUNT nor UNTIL is infinite and entirely legal - a
 * birthday is the obvious case. Without a cap, a malformed or merely daily
 * infinite rule queried over a wide window becomes an unbounded loop inside a
 * display server that a household cannot restart easily. The cap is reported
 * as a warning rather than being silent, so a truncated series is visible. */
const MAX_OCCURRENCES = 2000;

/* An equally important second guard: iterations, not just yields. A rule like
 * FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30 matches nothing, ever, and would spin
 * forever looking for a thirtieth of February. */
const MAX_ITERATIONS = 100_000;

export type RRule = {
  readonly freq: string;
  readonly interval: number;
  readonly count: number | null;
  readonly until: IcsTime | null;
  readonly byDay: readonly {ordinal: number | null; weekday: number}[];
  readonly byMonthDay: readonly number[];
  readonly byMonth: readonly number[];
  readonly weekStart: number;
};

export type RRuleParseResult =
  | {readonly ok: true; readonly rule: RRule}
  | {readonly ok: false; readonly warning: CalendarWarning};

export function parseRRule(text: string): RRuleParseResult {
  const parts = new Map<string, string>();
  for (const piece of text.split(';')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    parts.set(piece.slice(0, eq).trim().toUpperCase(), piece.slice(eq + 1).trim());
  }

  for (const banned of UNSUPPORTED_PARTS) {
    if (parts.has(banned)) {
      return {
        ok: false,
        warning: {
          code: 'unsupported_rrule_part',
          message: `a repeating event uses ${banned}, which this display does not expand; `
            + 'it is shown once rather than on a guessed schedule',
          detail: banned,
        },
      };
    }
  }

  const freq = (parts.get('FREQ') ?? '').toUpperCase();
  if (!SUPPORTED_FREQ.has(freq)) {
    return {
      ok: false,
      warning: {
        code: 'unsupported_freq',
        /* SECONDLY/MINUTELY/HOURLY are legal and meaningless on a wall
         * display; an hourly event would render as a wall of identical rows. */
        message: `a repeating event uses FREQ=${freq || '(missing)'}, which this display does not expand`,
        detail: freq || '(missing)',
      },
    };
  }

  const intervalRaw = Number(parts.get('INTERVAL') ?? '1');
  const interval = Number.isInteger(intervalRaw) && intervalRaw > 0 ? intervalRaw : 1;

  const countRaw = parts.get('COUNT');
  const count = countRaw !== undefined && Number.isInteger(Number(countRaw)) && Number(countRaw) > 0
    ? Number(countRaw)
    : null;

  const byDay: {ordinal: number | null; weekday: number}[] = [];
  for (const token of (parts.get('BYDAY') ?? '').split(',')) {
    const t = token.trim().toUpperCase();
    if (!t) continue;
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t);
    if (!m) continue;
    byDay.push({
      ordinal: m[1] ? Number(m[1]) : null,
      weekday: WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]),
    });
  }

  const numbers = (key: string, min: number, max: number): number[] =>
    (parts.get(key) ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max);

  const wkstRaw = (parts.get('WKST') ?? 'MO').toUpperCase();
  const wkstIndex = WEEKDAY_CODES.indexOf(wkstRaw as (typeof WEEKDAY_CODES)[number]);

  return {
    ok: true,
    rule: {
      freq,
      interval,
      count,
      /* UNTIL is parsed by the caller, which has the timezone context. */
      until: null,
      byDay,
      byMonthDay: numbers('BYMONTHDAY', 1, 31),
      byMonth: numbers('BYMONTH', 1, 12),
      weekStart: wkstIndex === -1 ? 1 : wkstIndex,
    },
  };
}

/** Extracts the raw UNTIL token so the caller can parse it with TZID context. */
export function untilToken(text: string): string | null {
  for (const piece of text.split(';')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    if (piece.slice(0, eq).trim().toUpperCase() === 'UNTIL') return piece.slice(eq + 1).trim();
  }
  return null;
}

/* ------------------------------------------------------------- expansion */

/** One materialised occurrence, still carrying every private field. */
export type Occurrence = {
  readonly event: IcsEvent;
  /** When this occurrence starts. Same shape as the series' DTSTART. */
  readonly start: IcsTime;
  readonly end: IcsTime;
  /** Sort key. For an all-day date this is local midnight in the display
   * zone, computed ONLY for ordering - never rendered. */
  readonly sortMs: number;
  /** True when a RECURRENCE-ID override supplied this instance. */
  readonly isOverride: boolean;
};

export type ExpandOptions = {
  /** Window start, inclusive, as an instant. */
  readonly fromMs: number;
  /** Window end, exclusive, as an instant. */
  readonly toMs: number;
  /** Household zone; decides where an all-day date sits on the timeline. */
  readonly displayZone: string;
  readonly warn?: (w: CalendarWarning) => void;
};

/* The sort position of a time value.
 *
 * An all-day DATE has no instant, but a list has to be ordered somehow. Local
 * midnight in the display zone is used for ORDERING ONLY and never leaves this
 * module - `timeToDateString` still reads the stored date string, so the
 * ordering convenience cannot leak back into the rendered day. */
function sortPosition(time: IcsTime, zone: string): number {
  if (time.kind === 'date') {
    const [y, m, d] = time.date.split('-').map(Number);
    return civilToUtcMs({y, m, d, hh: 0, mm: 0, ss: 0}, zone);
  }
  return time.utcMs;
}

function shiftTime(time: IcsTime, civil: Civil, zone: string): IcsTime {
  if (time.kind === 'date') {
    return {
      kind: 'date',
      date: `${String(civil.y).padStart(4, '0')}-${String(civil.m).padStart(2, '0')}-${String(civil.d).padStart(2, '0')}`,
    };
  }
  const effective = time.zone ?? zone;
  return {kind: 'datetime', civil, zone: time.zone, utcMs: civilToUtcMs(civil, effective)};
}

function civilOf(time: IcsTime): Civil {
  if (time.kind === 'date') {
    const [y, m, d] = time.date.split('-').map(Number);
    return {y, m, d, hh: 0, mm: 0, ss: 0};
  }
  return time.civil;
}

/** Duration of the series, preserved on every occurrence. */
function durationMs(event: IcsEvent, zone: string): number {
  return sortPosition(event.end, zone) - sortPosition(event.start, zone);
}

function endFor(start: IcsTime, event: IcsEvent, zone: string): IcsTime {
  if (start.kind === 'date') {
    const days = Math.max(1, Math.round(durationMs(event, zone) / 86_400_000));
    const [y, m, d] = start.date.split('-').map(Number);
    const shifted = addCivilDays({y, m, d, hh: 0, mm: 0, ss: 0}, days);
    return shiftTime(event.end, shifted, zone);
  }
  /* The END is derived by adding the series duration to the OCCURRENCE's
   * civil start, so a 1-hour meeting stays 1 hour across a DST boundary
   * rather than becoming two. */
  const startCivil = start.civil;
  const endCivil = msToCivil(civilMs(startCivil) + durationMs(event, zone));
  return shiftTime(event.end, endCivil, zone);
}

/* Does a civil date satisfy the BY* filters? Used by DAILY/WEEKLY/YEARLY,
 * where the BY* parts narrow a candidate stream rather than generating it. */
function matchesFilters(c: Civil, rule: RRule): boolean {
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(c.m)) return false;

  if (rule.byMonthDay.length > 0) {
    const last = daysInMonth(c.y, c.m);
    const ok = rule.byMonthDay.some((n) => (n > 0 ? n === c.d : last + n + 1 === c.d));
    if (!ok) return false;
  }

  if (rule.byDay.length > 0) {
    const wd = civilWeekday(c);
    /* Ordinals are meaningless for DAILY/WEEKLY and RFC 5545 says to ignore
     * them there, so only the weekday is compared. */
    if (!rule.byDay.some((b) => b.weekday === wd)) return false;
  }
  return true;
}

/** Candidate dates within one MONTHLY/YEARLY period, in order. */
function generateInPeriod(anchor: Civil, rule: RRule, monthScope: boolean): Civil[] {
  const months = monthScope ? [anchor.m] : (rule.byMonth.length > 0 ? [...rule.byMonth] : [anchor.m]);
  const out: Civil[] = [];

  for (const month of months.sort((a, b) => a - b)) {
    const last = daysInMonth(anchor.y, month);

    if (rule.byDay.length > 0) {
      for (const {ordinal, weekday} of rule.byDay) {
        const matching: number[] = [];
        for (let day = 1; day <= last; day++) {
          if (civilWeekday({...anchor, m: month, d: day}) === weekday) matching.push(day);
        }
        if (ordinal === null) {
          for (const day of matching) out.push({...anchor, m: month, d: day});
        } else {
          const day = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
          if (day !== undefined) out.push({...anchor, m: month, d: day});
        }
      }
      if (rule.byMonthDay.length > 0) {
        /* Both present: RFC 5545 intersects them. */
        const allowed = new Set(rule.byMonthDay.map((n) => (n > 0 ? n : last + n + 1)));
        for (let i = out.length - 1; i >= 0; i--) if (!allowed.has(out[i].d)) out.splice(i, 1);
      }
    } else if (rule.byMonthDay.length > 0) {
      for (const n of rule.byMonthDay) {
        const day = n > 0 ? n : last + n + 1;
        if (day >= 1 && day <= last) out.push({...anchor, m: month, d: day});
      }
    } else {
      const day = Math.min(anchor.d, last);
      out.push({...anchor, m: month, d: day});
    }
  }

  const seen = new Set<number>();
  return out
    .filter((c) => {
      const key = civilMs({...c, hh: 0, mm: 0, ss: 0});
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => civilMs(a) - civilMs(b));
}

/* Expands one series into occurrences overlapping [fromMs, toMs).
 *
 * Note the COUNT subtlety, which is easy to get wrong: COUNT counts
 * occurrences from the SERIES START, not occurrences inside the query window.
 * So the walk always begins at DTSTART and counts everything it generates,
 * while only collecting what falls inside the window. Counting from the window
 * would give a birthday "every year, 10 times" an extra decade of instances. */
function expandSeries(
  event: IcsEvent,
  rule: RRule,
  until: IcsTime | null,
  options: ExpandOptions,
): Occurrence[] {
  const {displayZone: zone, fromMs, toMs} = options;
  const exdates = new Set(event.exdates.map(occurrenceKey));
  const untilMs = until ? sortPosition(until, zone) : null;
  const duration = durationMs(event, zone);

  const out: Occurrence[] = [];
  const startCivil = civilOf(event.start);
  let generated = 0;
  let iterations = 0;
  let capped = false;

  const emit = (civil: Civil): 'continue' | 'stop' => {
    const start = shiftTime(event.start, civil, zone);
    const position = sortPosition(start, zone);

    if (untilMs !== null && position > untilMs) return 'stop';
    generated++;
    if (rule.count !== null && generated > rule.count) return 'stop';
    if (generated > MAX_OCCURRENCES) {
      capped = true;
      return 'stop';
    }
    if (exdates.has(occurrenceKey(start))) return 'continue';

    /* Overlap, not containment: an event that began before the window and is
     * still running belongs on the wall. A household looking at "today" wants
     * the all-day school trip that started yesterday. */
    if (position + Math.max(duration, 0) > fromMs && position < toMs) {
      out.push({event, start, end: endFor(start, event, zone), sortMs: position, isOverride: false});
    }
    return position >= toMs ? 'stop' : 'continue';
  };

  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    /* WEEKLY with BYDAY generates several days per week, so the walk is
     * day-by-day with a week-interval filter rather than jumping by interval
     * weeks - which would only ever produce the DTSTART weekday. */
    const weekdays = rule.freq === 'WEEKLY' && rule.byDay.length > 0
      ? new Set(rule.byDay.map((b) => b.weekday))
      : null;

    /* Week alignment uses WKST: with INTERVAL=2 the question "is this week in
     * scope" depends on where the publisher thinks a week begins. */
    const weekIndex = (c: Civil): number => {
      const shift = (civilWeekday(c) - rule.weekStart + 7) % 7;
      return Math.floor((civilMs(c) - shift * 86_400_000) / 604_800_000);
    };
    const baseWeek = weekIndex(startCivil);

    let cursor = startCivil;
    for (;;) {
      if (++iterations > MAX_ITERATIONS) {
        capped = true;
        break;
      }
      let inScope: boolean;
      if (rule.freq === 'DAILY') {
        const days = Math.round((civilMs(cursor) - civilMs(startCivil)) / 86_400_000);
        inScope = days % rule.interval === 0;
      } else {
        inScope = (weekIndex(cursor) - baseWeek) % rule.interval === 0
          && (weekdays === null ? civilWeekday(cursor) === civilWeekday(startCivil)
            : weekdays.has(civilWeekday(cursor)));
      }
      if (inScope && matchesFilters(cursor, rule)) {
        if (emit(cursor) === 'stop') break;
      }
      cursor = addCivilDays(cursor, 1);
    }
  } else {
    const monthly = rule.freq === 'MONTHLY';
    let period = monthly ? startCivil : {...startCivil};
    let stopped = false;

    for (;;) {
      if (++iterations > MAX_ITERATIONS) {
        capped = true;
        break;
      }
      const candidates = generateInPeriod(period, rule, monthly);
      for (const candidate of candidates) {
        /* A MONTHLY/YEARLY rule may generate dates before DTSTART inside the
         * first period (e.g. "first Monday" when DTSTART is the 20th). RFC
         * 5545 excludes anything before DTSTART. */
        if (civilMs(candidate) < civilMs(startCivil)) continue;
        if (emit(candidate) === 'stop') {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      period = monthly
        ? addCivilMonths(period, rule.interval)
        : {...period, y: period.y + rule.interval};
      /* Nothing will ever be in range again. */
      if (civilMs({...period, d: 1, hh: 0, mm: 0, ss: 0}) > civilMs(msToCivil(toMs)) + 400 * 86_400_000) break;
    }
  }

  /* RDATE: explicit extra dates, added after the rule has run. */
  for (const rdate of event.rdates) {
    if (exdates.has(occurrenceKey(rdate))) continue;
    const position = sortPosition(rdate, zone);
    if (position + Math.max(duration, 0) > fromMs && position < toMs) {
      out.push({event, start: rdate, end: endFor(rdate, event, zone), sortMs: position, isOverride: false});
    }
  }

  if (capped) {
    options.warn?.({
      code: 'expansion_capped',
      message: 'a repeating event produced more occurrences than this display will expand',
      detail: event.uid ? 'series' : undefined,
    });
  }
  return out;
}

/* Expands a whole calendar into the occurrences visible in a window.
 *
 * The three-way interaction is the part worth reading:
 *   - a VEVENT with no RRULE and no RECURRENCE-ID is a single event
 *   - a VEVENT with a RECURRENCE-ID is an OVERRIDE: it replaces exactly one
 *     occurrence of the series sharing its UID, and it may move that
 *     occurrence to a different time entirely
 *   - EXDATE removes an occurrence, and beats both
 *
 * Overrides are keyed by UID + occurrence key, and applied by removing the
 * generated occurrence and inserting the override's own start. Matching on
 * UID alone would let a moved instance shadow the wrong one; matching on time
 * alone would collide across calendars.
 */
export function expandCalendar(
  events: readonly IcsEvent[],
  options: ExpandOptions,
): {occurrences: Occurrence[]; warnings: CalendarWarning[]} {
  const warnings: CalendarWarning[] = [];
  const seenWarnings = new Set<string>();
  const warn = (w: CalendarWarning): void => {
    const key = `${w.code}:${w.detail ?? ''}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(w);
    options.warn?.(w);
  };
  const opts: ExpandOptions = {...options, warn};
  const zone = options.displayZone;

  const overrides = new Map<string, IcsEvent>();
  for (const event of events) {
    if (event.recurrenceId) {
      overrides.set(`${event.uid}|${occurrenceKey(event.recurrenceId)}`, event);
    }
  }

  const out: Occurrence[] = [];

  for (const event of events) {
    /* CANCELLED is a tombstone, not an event. Rendering it puts a meeting on
     * the wall that the organiser explicitly called off. */
    if (event.status === 'CANCELLED') continue;
    if (event.recurrenceId) continue; // applied below, against its series

    if (!event.rrule) {
      const position = sortPosition(event.start, zone);
      const duration = Math.max(durationMs(event, zone), 0);
      if (position + duration > options.fromMs && position < options.toMs) {
        out.push({event, start: event.start, end: event.end, sortMs: position, isOverride: false});
      }
      continue;
    }

    const parsed = parseRRule(event.rrule);
    if (!parsed.ok) {
      warn(parsed.warning);
      /* Declined, but not discarded: the series' first instance is still real
       * and still shown. The household loses the repeats, not the event. */
      const position = sortPosition(event.start, zone);
      if (position + Math.max(durationMs(event, zone), 0) > options.fromMs && position < options.toMs) {
        out.push({event, start: event.start, end: event.end, sortMs: position, isOverride: false});
      }
      continue;
    }

    const untilRaw = untilToken(event.rrule);
    let until: IcsTime | null = null;
    if (untilRaw) {
      /* UNTIL is UTC when the value carries a Z, and otherwise matches the
       * DTSTART value type. Both forms appear in the wild. */
      if (/^\d{8}$/.test(untilRaw)) {
        until = {kind: 'date', date: `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}`};
      } else {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(untilRaw);
        if (m) {
          const civil: Civil = {
            y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +m[6],
          };
          const uz = m[7] === 'Z' ? 'UTC' : (event.start.kind === 'datetime' ? event.start.zone ?? zone : zone);
          until = {kind: 'datetime', civil, zone: uz, utcMs: civilToUtcMs(civil, uz)};
        }
      }
    }

    for (const occurrence of expandSeries(event, parsed.rule, until, opts)) {
      const key = `${event.uid}|${occurrenceKey(occurrence.start)}`;
      const override = overrides.get(key);
      if (override) {
        if (override.status === 'CANCELLED') continue;
        const position = sortPosition(override.start, zone);
        out.push({
          event: override,
          start: override.start,
          end: override.end,
          sortMs: position,
          isOverride: true,
        });
        continue;
      }
      out.push(occurrence);
    }
  }

  /* An override may legally move an instance OUTSIDE the generated window -
   * "Tuesday's meeting is next Saturday". Those are added on their own merit
   * so the moved instance still appears where it now is. */
  for (const [key, override] of overrides) {
    if (override.status === 'CANCELLED') continue;
    const position = sortPosition(override.start, zone);
    const inWindow = position + Math.max(durationMs(override, zone), 0) > options.fromMs
      && position < options.toMs;
    if (!inWindow) continue;
    const already = out.some((o) => o.isOverride && `${o.event.uid}|${occurrenceKey(o.event.recurrenceId ?? o.start)}` === key);
    if (already) continue;
    out.push({event: override, start: override.start, end: override.end, sortMs: position, isOverride: true});
  }

  out.sort((a, b) => a.sortMs - b.sortMs
    || (a.event.summary < b.event.summary ? -1 : a.event.summary > b.event.summary ? 1 : 0));
  return {occurrences: out, warnings};
}
