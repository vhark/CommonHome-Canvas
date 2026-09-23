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
/* The share-safety boundary. Field-level, and the only place it is decided.
 *
 * THE RULE (calendar-as-canvas.md §2, non-negotiable):
 *
 *   | Field                  | Private canvas | Shared canvas     |
 *   | times                  | yes            | yes               |
 *   | title / summary        | yes            | opt-in, default NO|
 *   | description            | yes            | NEVER             |
 *   | location               | yes            | NEVER             |
 *   | attendees              | yes            | NEVER             |
 *   | calendar name & colour | yes            | yes               |
 *
 * WHY THIS IS NOT A RENDER-TIME CONCERN. The evidence is from real household
 * data: a bin-collection calendar - the most mundane calendar imaginable -
 * carried, in each event's DESCRIPTION, a full street address with postcode,
 * the hauler's phone number, and a family member's given name. If the bin
 * calendar carries that, the medical and school calendars carry more.
 *
 * So "shared" here means the field is ABSENT FROM THE OBJECT, not present and
 * unrendered. A field that reaches the browser has leaked, whatever the CSS
 * says - it is in view-source, in the JSON response, in the browser cache and
 * in anything that archives the page.
 *
 * HOW ABSENCE IS GUARANTEED, structurally rather than by discipline:
 * the shared shape is BUILT BY CONSTRUCTION from a fixed set of keys. It is
 * never the private object with fields deleted, because `delete` on a spread
 * copy is exactly the pattern that silently regresses when someone later adds
 * a field to the private type. Adding a field to IcsEvent cannot leak it into
 * a share, because nothing in `shapeShared` would ever copy it.
 *
 * THE SOURCE URL. It is a bearer credential wearing the costume of a link -
 * Google's "secret address" grants permanent read of an entire calendar and
 * some embed the account email in the path. It is not a parameter to any
 * function here and appears in no type in this module, so there is no
 * shaped value it could travel in.
 */

import {timeToDateString, type CalendarWarning, type IcsTime} from './parse.ts';
import {type Occurrence} from './recurrence.ts';
import {utcMsToCivil} from './time.ts';

/** How much detail a canvas is permitted to publish. */
export type ShareLevel = 'private' | 'shared';

export type ShapeOptions = {
  readonly level: ShareLevel;
  /** Only consulted when level is 'shared'. Default false, deliberately. */
  readonly showTitles?: boolean;
  /** Household zone; decides which day a timed event falls on. */
  readonly displayZone: string;
  /** Replaces a withheld title. "Busy" is the honest word for it. */
  readonly busyLabel?: string;
  /** Hard cap on how many occurrences are shaped. */
  readonly limit?: number;
};

/* The shaped event. Every field here is safe for the level that produced it.
 *
 * `description`, `location` and `attendees` are OPTIONAL at the type level and
 * are only ever assigned on the private path, so TypeScript will not let a
 * consumer assume they exist and a shared payload genuinely lacks the keys. */
export type ShapedEvent = {
  /** Opaque, stable per occurrence. Never the UID: a UID can carry an email
   * address, and several providers generate it from the organiser's. */
  readonly id: string;
  /** `YYYY-MM-DD` in the display zone. All-day events keep their own date. */
  readonly date: string;
  /** `HH:MM` 24h, or null for an all-day event. */
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly allDay: boolean;
  /** Coarse band, per the legibility research: precise timelines do not read
   * at three metres, but "morning" does. */
  readonly band: 'all-day' | 'morning' | 'afternoon' | 'evening';
  /** Absent entirely when a share withholds titles. */
  readonly title?: string;
  /** Present ONLY on a private shaping. */
  readonly description?: string;
  /** Present ONLY on a private shaping. */
  readonly location?: string;
  /** Present ONLY on a private shaping. */
  readonly attendees?: readonly string[];
  readonly tentative: boolean;
  readonly busy: boolean;
};

export type ShapedCalendar = {
  readonly name: string | null;
  readonly events: readonly ShapedEvent[];
  readonly level: ShareLevel;
  readonly generatedAt: string;
  /** Display-safe: warnings never contain event content or a URL. */
  readonly warnings: readonly CalendarWarning[];
  readonly degraded: readonly string[];
};

/* Keys that must never appear in a shared payload. Exported so the leak test
 * asserts against the same list the implementation is written against, rather
 * than a copy that could drift. */
export const NEVER_SHARED_KEYS = ['description', 'location', 'attendees', 'organizer', 'uid', 'url', 'sourceUrl'] as const;

function timeOf(time: IcsTime, zone: string): string | null {
  if (time.kind === 'date') return null;
  const c = utcMsToCivil(time.utcMs, zone);
  return `${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
}

/* Bands rather than a timeline. From the legibility research: a wall display
 * read at three metres communicates "this afternoon" far better than a
 * to-the-minute position, and a band survives a glance where a timeline needs
 * study. Boundaries chosen to match how a household talks, not the clock. */
export function bandFor(startTime: string | null): ShapedEvent['band'] {
  if (startTime === null) return 'all-day';
  const hour = Number(startTime.slice(0, 2));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/* A stable, opaque id.
 *
 * NOT the UID. Providers routinely build a UID from the organiser's email
 * address, so publishing it would leak an address through a field nobody
 * thinks of as content. This is a non-cryptographic hash of UID plus
 * occurrence start: stable across refreshes (so a browser can key a list on
 * it) and reversible by nobody. */
function occurrenceId(uid: string, start: IcsTime): string {
  const seed = `${uid}|${start.kind === 'date' ? start.date : start.utcMs}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12);
}

/* The private shaping: everything the household may see on its own wall.
 *
 * Still a SHAPE and not the raw event: the UID and the raw iCalendar
 * structures stay server-side even here, because a private canvas is still a
 * browser payload and there is no reason for a page to hold a provider's
 * internal identifiers. */
function shapePrivate(occurrence: Occurrence, zone: string): ShapedEvent {
  const {event, start, end} = occurrence;
  const startTime = timeOf(start, zone);
  return {
    id: occurrenceId(event.uid, start),
    date: timeToDateString(start, zone),
    startTime,
    endTime: timeOf(end, zone),
    allDay: start.kind === 'date',
    band: bandFor(startTime),
    title: event.summary || 'Busy',
    description: event.description,
    location: event.location,
    attendees: event.attendees,
    tentative: event.status === 'TENTATIVE',
    busy: !event.transparent,
  };
}

/* The shared shaping.
 *
 * Constructed key by key. There is no spread of the private object anywhere
 * in this function, and that is deliberate: it is what makes the guarantee
 * structural. A future field added to IcsEvent cannot appear here by
 * accident, because appearing here requires someone to write it down. */
function shapeShared(occurrence: Occurrence, zone: string, showTitles: boolean, busyLabel: string): ShapedEvent {
  const {event, start, end} = occurrence;
  const startTime = timeOf(start, zone);

  const shaped: ShapedEvent = {
    id: occurrenceId(event.uid, start),
    date: timeToDateString(start, zone),
    startTime,
    endTime: timeOf(end, zone),
    allDay: start.kind === 'date',
    band: bandFor(startTime),
    tentative: event.status === 'TENTATIVE',
    busy: !event.transparent,
  };

  /* Titles are opt-in and default off. A grandparent seeing "Thursday 4pm -
   * something" is the safe default; upgrading to titles is a deliberate act
   * by somebody who thought about it. The key is ABSENT when withheld, not
   * set to the busy label, so nothing downstream can tell a withheld title
   * from an untitled event and then "helpfully" show the raw one. */
  if (showTitles) {
    return {...shaped, title: event.summary || busyLabel};
  }
  return shaped;
}

export function shapeCalendar(
  occurrences: readonly Occurrence[],
  options: ShapeOptions & {
    readonly name?: string | null;
    readonly warnings?: readonly CalendarWarning[];
    readonly degraded?: readonly string[];
    readonly now?: Date;
  },
): ShapedCalendar {
  const zone = options.displayZone;
  const limit = options.limit ?? 200;
  const busyLabel = options.busyLabel ?? 'Busy';
  const showTitles = options.level === 'private' ? true : options.showTitles === true;

  const events = occurrences.slice(0, limit).map((o) =>
    options.level === 'private'
      ? shapePrivate(o, zone)
      : shapeShared(o, zone, showTitles, busyLabel),
  );

  return {
    /* The calendar's own NAME is share-safe per the table, but a publisher
     * may have named it after a person or an address. Trimmed to a sane
     * length; not withheld, because "Bins" on a shared wall is the point. */
    name: (options.name ?? null) && String(options.name).slice(0, 60),
    events,
    level: options.level,
    generatedAt: (options.now ?? new Date()).toISOString(),
    warnings: options.warnings ?? [],
    degraded: options.degraded ?? [],
  };
}

/* A belt-and-braces audit, for tests and for anyone wiring a new route.
 *
 * The structural guarantee above is the real defence; this exists because the
 * cost of a leak here is a household's address on a public link, and a second
 * check that operates on the SERIALISED form catches the one thing the type
 * system cannot: a field that is present but hidden - non-enumerable, on a
 * prototype, or smuggled through a toJSON. Serialising is what the browser
 * actually receives, so it is what gets audited. */
export function auditShared(payload: unknown, forbidden: readonly string[] = NEVER_SHARED_KEYS): string[] {
  const json = JSON.stringify(payload) ?? '';
  const found: string[] = [];
  for (const key of forbidden) {
    if (new RegExp(`"${key}"\\s*:`).test(json)) found.push(key);
  }
  return found;
}
