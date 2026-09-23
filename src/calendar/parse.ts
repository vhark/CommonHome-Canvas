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
/* iCalendar (RFC 5545) to events.
 *
 * WHY THIS IS HAND-WRITTEN rather than `ical.js` as the phase plan suggested:
 *
 * The plan proposed taking ical.js as a devDependency "bundled at build time"
 * so that `"dependencies": {}` stays empty. That was tested rather than
 * assumed, and it does not work here, for a structural reason:
 *
 *   The Dockerfile's runtime stage copies `src/server` AS SOURCE and ships no
 *   node_modules at all. Node 22+ runs the TypeScript directly via type
 *   stripping. There is no server bundle for a devDependency to be bundled
 *   into. `build-ambient.mjs` bundles the BROWSER entry point, and the browser
 *   is exactly where this code must not run: the ICS URL is a credential and
 *   field-level share safety has to be enforced before anything crosses to a
 *   page. So parsing is server-side by requirement, and server-side is
 *   precisely where no dependency can be resolved.
 *
 *   Making it work would mean bundling the server too - replacing readable
 *   source in the image with a minified artifact, and adding a build step to
 *   a runtime whose selling point is that its supply chain is inspectable in
 *   an afternoon. That trade is not worth a recurrence expander.
 *
 * So: a focused parser, and a recurrence expander (see recurrence.ts) that
 * covers what household calendars contain and DECLINES the rest explicitly,
 * with a named warning, rather than implementing it badly and silently
 * showing the household a wrong date.
 *
 * PRIVACY NOTE: this module parses. It does not decide what is shared. Every
 * field a VEVENT carries - including DESCRIPTION and LOCATION, which in real
 * household data carry street addresses and phone numbers - is parsed into
 * the private model here and REMOVED by shape.ts before anything is
 * serialised for a shared canvas. Parsing everything and shaping once is
 * safer than filtering in several places and forgetting one.
 */

import {
  civilDateString,
  civilToUtcMs,
  hostTimeZone,
  isValidTimeZone,
  utcMsToCivil,
  type Civil,
} from './time.ts';

/* --------------------------------------------------------------- warnings */

/* Warnings are DATA, not console output. A wall display cannot show a stack
 * trace and nobody reads a container log, so an unsupported rule surfaces as
 * a structured value the snapshot can carry and a settings page can show. */
export type CalendarWarningCode =
  | 'unsupported_rrule_part'
  | 'unsupported_freq'
  | 'unsupported_tzid'
  | 'invalid_date'
  | 'missing_dtstart'
  | 'expansion_capped';

export type CalendarWarning = {
  readonly code: CalendarWarningCode;
  /** Human-readable, and safe to display: never contains a URL or a secret. */
  readonly message: string;
  /** The offending detail, e.g. `BYSETPOS`. Never event content. */
  readonly detail?: string;
};

/* ------------------------------------------------------------ value types */

/** An iCalendar temporal value. A DATE is never an instant - see time.ts. */
export type IcsTime =
  | {
      readonly kind: 'date';
      /** `YYYY-MM-DD`. The civil date, with no zone and no midnight implied. */
      readonly date: string;
    }
  | {
      readonly kind: 'datetime';
      /** Wall-clock fields as written in the feed. */
      readonly civil: Civil;
      /** IANA zone, or null for a floating time (RFC 5545 s3.3.5 form one). */
      readonly zone: string | null;
      /** Absolute instant, resolved using `zone` or the display zone. */
      readonly utcMs: number;
    };

export type IcsEvent = {
  readonly uid: string;
  readonly summary: string;
  /** Household-private. Removed by shape.ts for a shared canvas. */
  readonly description: string;
  /** Household-private. Removed by shape.ts for a shared canvas. */
  readonly location: string;
  /** Household-private. Removed by shape.ts for a shared canvas. */
  readonly attendees: readonly string[];
  readonly organizer: string;
  readonly status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  /** TRANSP:TRANSPARENT - present on the calendar but not occupying time. */
  readonly transparent: boolean;
  readonly start: IcsTime;
  readonly end: IcsTime;
  readonly allDay: boolean;
  readonly rrule: string | null;
  readonly exdates: readonly IcsTime[];
  readonly rdates: readonly IcsTime[];
  /** Set on an override instance: which occurrence of the series it replaces. */
  readonly recurrenceId: IcsTime | null;
  readonly sequence: number;
};

export type ParsedCalendar = {
  /** X-WR-CALNAME, when the publisher set one. */
  readonly name: string | null;
  readonly events: readonly IcsEvent[];
  readonly warnings: readonly CalendarWarning[];
};

/* ------------------------------------------------------------ line reader */

export type IcsLine = {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
};

/* RFC 5545 s3.1: a line longer than 75 octets is folded, and a continuation
 * begins with a single space or tab which is NOT part of the value. Feeds fold
 * with CRLF, but plenty emit bare LF, and a file that has been through a text
 * editor may have either - so all three line endings are accepted.
 *
 * Getting this wrong truncates long SUMMARY and RRULE values, which fails in
 * the least obvious way possible: the calendar renders, with one event
 * mysteriously named differently or recurring forever. */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

/* Parameter values may be DQUOTE-wrapped, and a quoted value may legally
 * contain `:` and `;` - which is exactly why this is a scanner and not a
 * `split(':')`. `ATTENDEE;CN="Smith, John":mailto:...` breaks every naive
 * split, and it is common. */
export function parseLine(line: string): IcsLine | null {
  let i = 0;
  const n = line.length;

  while (i < n && line[i] !== ':' && line[i] !== ';') i++;
  if (i >= n) return null;
  const name = line.slice(0, i).toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    let k = i;
    while (k < n && line[k] !== '=' && line[k] !== ';' && line[k] !== ':') k++;
    const key = line.slice(i, k).toUpperCase();
    i = k;
    let value = '';
    if (line[i] === '=') {
      i++;
      const pieces: string[] = [];
      for (;;) {
        if (line[i] === '"') {
          i++;
          const close = line.indexOf('"', i);
          const end = close === -1 ? n : close;
          pieces.push(line.slice(i, end));
          i = end + 1;
        } else {
          let j = i;
          while (j < n && line[j] !== ',' && line[j] !== ';' && line[j] !== ':') j++;
          pieces.push(line.slice(i, j));
          i = j;
        }
        if (line[i] === ',') {
          i++;
          pieces.push(',');
          continue;
        }
        break;
      }
      value = pieces.join('');
    }
    if (key) params[key] = value;
  }

  if (line[i] !== ':') return null;
  return {name, params, value: line.slice(i + 1)};
}

/* RFC 5545 s3.3.11 TEXT escaping. `\n` is a real newline; a literal comma or
 * semicolon in a SUMMARY arrives escaped and must be unescaped or every event
 * title with a comma renders a stray backslash on the wall. */
export function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === undefined) out += '\\';
    else out += next;
  }
  return out;
}

/* ------------------------------------------------------- component parser */

export type IcsComponent = {
  readonly type: string;
  readonly props: readonly IcsLine[];
  readonly children: readonly IcsComponent[];
};

/* A BEGIN/END stack rather than a flat scan, because VALARM sits inside
 * VEVENT and a flat scan happily reads the alarm's TRIGGER as if it were an
 * event property. Nesting is cheap to honour and wrong to ignore. */
export function parseComponents(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: {type: string; props: IcsLine[]; children: IcsComponent[]}[] = [];

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === 'BEGIN') {
      stack.push({type: line.value.trim().toUpperCase(), props: [], children: []});
      continue;
    }
    if (line.name === 'END') {
      const done = stack.pop();
      if (!done) continue;
      const node: IcsComponent = {type: done.type, props: done.props, children: done.children};
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1].props.push(line);
  }
  /* An unterminated component (a truncated download) still yields whatever
   * was complete, because a partially-fetched calendar showing most of the
   * week beats a wall display showing an error. */
  while (stack.length > 0) {
    const done = stack.pop()!;
    const node: IcsComponent = {type: done.type, props: done.props, children: done.children};
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
  }
  return roots;
}

function prop(component: IcsComponent, name: string): IcsLine | undefined {
  return component.props.find((p) => p.name === name);
}

function allProps(component: IcsComponent, name: string): IcsLine[] {
  return component.props.filter((p) => p.name === name);
}

/* ------------------------------------------------------------ time values */

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

export type TimeContext = {
  /** Zone used for floating times and for any TZID we cannot resolve. */
  readonly displayZone: string;
  /** VTIMEZONE fallback offsets, keyed by TZID, in minutes east of UTC. */
  readonly tzFallback?: ReadonlyMap<string, number>;
  readonly warn?: (w: CalendarWarning) => void;
};

/* One value of a DATE / DATE-TIME property.
 *
 * The `VALUE=DATE` branch is the all-day bug, handled once, here. It returns a
 * civil date STRING and no instant, so it is structurally impossible for a
 * caller to accidentally render it in the wrong zone: there is no timestamp to
 * get wrong. Everything downstream - grouping, "is this today", the agenda
 * block - branches on `kind`, not on a Date. */
export function parseTimeValue(
  value: string,
  params: Readonly<Record<string, string>>,
  ctx: TimeContext,
): IcsTime | null {
  const text = value.trim();

  const asDate = DATE_RE.exec(text);
  if (asDate && (params.VALUE === 'DATE' || text.length === 8)) {
    return {kind: 'date', date: `${asDate[1]}-${asDate[2]}-${asDate[3]}`};
  }

  const dt = DATETIME_RE.exec(text);
  if (!dt) {
    ctx.warn?.({code: 'invalid_date', message: 'a date value could not be read', detail: text.slice(0, 20)});
    return null;
  }

  const civil: Civil = {
    y: Number(dt[1]),
    m: Number(dt[2]),
    d: Number(dt[3]),
    hh: Number(dt[4]),
    mm: Number(dt[5]),
    ss: Number(dt[6]),
  };

  /* Form two: a trailing Z is UTC, and a TZID alongside it is illegal and
   * ignored - the Z wins, because it is unambiguous. */
  if (dt[7] === 'Z') {
    return {kind: 'datetime', civil, zone: 'UTC', utcMs: civilToUtcMs(civil, 'UTC')};
  }

  const tzid = params.TZID?.trim();
  if (tzid) {
    if (isValidTimeZone(tzid)) {
      return {kind: 'datetime', civil, zone: tzid, utcMs: civilToUtcMs(civil, tzid)};
    }
    /* DECLINED, explicitly: non-IANA TZIDs. Microsoft historically published
     * "Eastern Standard Time" and some tools invent local names. Rather than
     * ship a guessing table that is wrong for half the year, the VTIMEZONE's
     * own STANDARD offset is used, the event is still shown, and the household
     * is told the zone was not understood. Every mainstream provider - Google,
     * iCloud, Outlook, Fastmail, Nextcloud - emits IANA names, so this path is
     * a fallback and not the normal case. */
    const fallbackMinutes = ctx.tzFallback?.get(tzid);
    ctx.warn?.({
      code: 'unsupported_tzid',
      message: 'calendar uses a timezone name this display does not recognise',
      detail: tzid,
    });
    if (fallbackMinutes !== undefined) {
      const utcMs = Date.UTC(civil.y, civil.m - 1, civil.d, civil.hh, civil.mm, civil.ss)
        - fallbackMinutes * 60_000;
      return {kind: 'datetime', civil, zone: null, utcMs};
    }
    return {kind: 'datetime', civil, zone: null, utcMs: civilToUtcMs(civil, ctx.displayZone)};
  }

  /* Form one: floating. RFC 5545 says it is whatever local time the observer
   * is in, which for a wall display is the household's zone. */
  return {kind: 'datetime', civil, zone: null, utcMs: civilToUtcMs(civil, ctx.displayZone)};
}

function parseTimeList(
  line: IcsLine,
  ctx: TimeContext,
): IcsTime[] {
  const out: IcsTime[] = [];
  for (const piece of line.value.split(',')) {
    if (!piece.trim()) continue;
    const t = parseTimeValue(piece, line.params, ctx);
    if (t) out.push(t);
  }
  return out;
}

/* RFC 5545 s3.3.6 DURATION, used by feeds that omit DTEND (Apple does this
 * routinely). Weeks are exclusive of everything else in the grammar. */
const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDurationMs(value: string): number | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0);
  const hours = Number(m[4] ?? 0);
  const minutes = Number(m[5] ?? 0);
  const seconds = Number(m[6] ?? 0);
  if (m[2] === undefined && m[3] === undefined && m[4] === undefined
      && m[5] === undefined && m[6] === undefined) return null;
  return sign * (
    weeks * 604_800_000 + days * 86_400_000
    + hours * 3_600_000 + minutes * 60_000 + seconds * 1000
  );
}

/* ---------------------------------------------------- VTIMEZONE fallbacks */

/* Only the crude part of VTIMEZONE is read: the STANDARD observance's
 * TZOFFSETTO, used when a TZID is not an IANA name. Fully interpreting
 * VTIMEZONE means evaluating the observance RRULEs to decide which offset
 * applies on a given date, which is the timezone-database problem in
 * miniature. Intl already has that database and gets it right for every real
 * TZID, so re-implementing it to serve a fallback would be effort spent on
 * the least common path. Stated plainly rather than left as a mystery. */
function timezoneFallbacks(roots: readonly IcsComponent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of roots) {
    for (const child of root.children) {
      if (child.type !== 'VTIMEZONE') continue;
      const tzid = prop(child, 'TZID')?.value.trim();
      if (!tzid) continue;
      const standard = child.children.find((c) => c.type === 'STANDARD') ?? child.children[0];
      const offset = standard ? prop(standard, 'TZOFFSETTO')?.value.trim() : undefined;
      if (!offset) continue;
      const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(offset);
      if (!m) continue;
      const minutes = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '-' ? -1 : 1);
      out.set(tzid, minutes);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- VEVENT */

function collectVevents(components: readonly IcsComponent[]): IcsComponent[] {
  const out: IcsComponent[] = [];
  const walk = (c: IcsComponent): void => {
    if (c.type === 'VEVENT') out.push(c);
    /* VEVENTs never nest, so do not descend into one - that is how a VALARM's
     * properties end up attributed to the event. */
    else for (const child of c.children) walk(child);
  };
  for (const c of components) walk(c);
  return out;
}

function statusOf(raw: string | undefined): IcsEvent['status'] {
  const s = (raw ?? '').trim().toUpperCase();
  return s === 'CANCELLED' || s === 'TENTATIVE' ? s : 'CONFIRMED';
}

/** The end of an event, from DTEND, or DTSTART+DURATION, or the RFC default. */
function endOf(component: IcsComponent, start: IcsTime, ctx: TimeContext): IcsTime {
  const dtend = prop(component, 'DTEND');
  if (dtend) {
    const parsed = parseTimeValue(dtend.value, dtend.params, ctx);
    if (parsed) return parsed;
  }

  const duration = prop(component, 'DURATION');
  const ms = duration ? parseDurationMs(duration.value) : null;
  if (ms !== null) {
    if (start.kind === 'date') {
      const days = Math.max(1, Math.round(ms / 86_400_000));
      const d = new Date(`${start.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return {kind: 'date', date: d.toISOString().slice(0, 10)};
    }
    const utcMs = start.utcMs + ms;
    return {
      kind: 'datetime',
      civil: start.civil,
      zone: start.zone,
      utcMs,
    };
  }

  /* RFC 5545 s3.6.1: with neither DTEND nor DURATION, a DATE start lasts one
   * day and a DATE-TIME start is instantaneous. */
  if (start.kind === 'date') {
    const d = new Date(`${start.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return {kind: 'date', date: d.toISOString().slice(0, 10)};
  }
  return start;
}

export type ParseOptions = {
  /** Household zone, for floating times. Defaults to the host's zone. */
  readonly displayZone?: string;
};

export function parseICalendar(text: string, options: ParseOptions = {}): ParsedCalendar {
  const warnings: CalendarWarning[] = [];
  const seen = new Set<string>();
  const warn = (w: CalendarWarning): void => {
    /* Deduplicated: a 134-event feed with one unsupported rule would otherwise
     * produce 134 identical warnings and bury anything else. */
    const key = `${w.code}:${w.detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(w);
  };

  const roots = parseComponents(text);
  const ctx: TimeContext = {
    displayZone: options.displayZone && isValidTimeZone(options.displayZone)
      ? options.displayZone
      : hostTimeZone(),
    tzFallback: timezoneFallbacks(roots),
    warn,
  };

  let name: string | null = null;
  for (const root of roots) {
    const n = prop(root, 'X-WR-CALNAME');
    if (n) name = unescapeText(n.value).trim() || null;
  }

  const events: IcsEvent[] = [];
  for (const component of collectVevents(roots)) {
    const dtstart = prop(component, 'DTSTART');
    if (!dtstart) {
      warn({code: 'missing_dtstart', message: 'an event without a start time was skipped'});
      continue;
    }
    const start = parseTimeValue(dtstart.value, dtstart.params, ctx);
    if (!start) continue;

    const recurrenceLine = prop(component, 'RECURRENCE-ID');
    const attendees = allProps(component, 'ATTENDEE').map((a) => {
      const cn = a.params.CN;
      return (cn && cn.trim()) || a.value.replace(/^mailto:/i, '').trim();
    });

    events.push({
      uid: prop(component, 'UID')?.value.trim() || '',
      summary: unescapeText(prop(component, 'SUMMARY')?.value ?? '').trim(),
      description: unescapeText(prop(component, 'DESCRIPTION')?.value ?? '').trim(),
      location: unescapeText(prop(component, 'LOCATION')?.value ?? '').trim(),
      attendees,
      organizer: (prop(component, 'ORGANIZER')?.params.CN
        ?? prop(component, 'ORGANIZER')?.value.replace(/^mailto:/i, '')
        ?? '').trim(),
      status: statusOf(prop(component, 'STATUS')?.value),
      transparent: (prop(component, 'TRANSP')?.value ?? '').trim().toUpperCase() === 'TRANSPARENT',
      start,
      end: endOf(component, start, ctx),
      allDay: start.kind === 'date',
      rrule: prop(component, 'RRULE')?.value.trim() || null,
      exdates: allProps(component, 'EXDATE').flatMap((l) => parseTimeList(l, ctx)),
      rdates: allProps(component, 'RDATE').flatMap((l) => parseTimeList(l, ctx)),
      recurrenceId: recurrenceLine
        ? parseTimeValue(recurrenceLine.value, recurrenceLine.params, ctx)
        : null,
      sequence: Number(prop(component, 'SEQUENCE')?.value ?? 0) || 0,
    });
  }

  return {name, events, warnings};
}

/* A stable key for matching an EXDATE or a RECURRENCE-ID to the occurrence it
 * refers to.
 *
 * Matching on the instant alone is wrong for all-day events (there is no
 * instant) and matching on the civil string alone is wrong across zones. So
 * each kind gets the identity that is actually meaningful for it, and the two
 * can never collide because the prefixes differ. */
export function occurrenceKey(time: IcsTime): string {
  if (time.kind === 'date') return `D:${time.date}`;
  return `T:${time.utcMs}`;
}

/* The civil date an event falls on, in the display zone.
 *
 * The `date` branch returns the stored string UNTOUCHED. That is the whole
 * all-day fix in one line: an all-day event's date is never routed through an
 * instant, so no zone conversion can move it. */
export function timeToDateString(time: IcsTime, zone: string): string {
  if (time.kind === 'date') return time.date;
  return civilDateString(utcMsToCivil(time.utcMs, zone));
}
