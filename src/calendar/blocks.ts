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
/* Calendar block layouts: pure presentation logic, no DOM.
 *
 * House style, per spikes/ambient-model.ts: anything that encodes a PRODUCT
 * RULE lives in a pure module where it can be asserted directly, and the
 * rendering code stays dumb. These functions take shaped events and return
 * view models; they touch no globals, start no timers and read no clock they
 * were not handed.
 *
 * THREE SHAPES, and no month grid. The research is explicit about why: at
 * three metres each cell of a month grid gets about a thirty-fifth of the
 * screen, and it answers a question nobody standing in a kitchen is asking.
 * "What is next" and "what is today" are the questions; these three shapes
 * answer them at three different sizes.
 *
 *   agenda      - next N events, grouped by day. The default.
 *   day-columns - 3 to 5 days side by side, with an oversized TODAY.
 *   up-next     - a single cell: the next one or two items.
 *
 * LEGIBILITY RULES, encoded rather than left to CSS:
 *   - a person is identified by fixed POSITION and colour, never colour alone;
 *     colour-only identity fails for the colour-blind and fails at distance
 *   - coarse time bands rather than precise timelines
 *   - stable layout: a fixed number of day columns whether or not they have
 *     events, because glanceability depends on the furniture not moving
 */

import type {ShapedEvent} from './shape.ts';
import {addCivilDays, civilDateString, utcMsToCivil} from './time.ts';

export type DayGroup = {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** 'Today', 'Tomorrow', or a weekday name. Computed, never stored. */
  readonly label: string;
  readonly isToday: boolean;
  readonly isTomorrow: boolean;
  readonly isWeekend: boolean;
  readonly events: readonly ShapedEvent[];
};

export type LayoutOptions = {
  readonly now: Date;
  readonly displayZone: string;
  readonly locale?: string;
};

/** The household's current civil date, which is the only "today" that matters. */
export function todayIn(now: Date, zone: string): string {
  return civilDateString(utcMsToCivil(now.getTime(), zone));
}

function civilFromDateString(date: string): {y: number; m: number; d: number; hh: number; mm: number; ss: number} {
  const [y, m, d] = date.split('-').map(Number);
  return {y, m, d, hh: 0, mm: 0, ss: 0};
}

/** Offset in whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function dayOffset(from: string, to: string): number {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/* Day labels. 'Today' and 'Tomorrow' are worth the special case: they are how
 * a household refers to those days, and on a wall they save the reader a step
 * that a date does not. Beyond that a weekday name reads faster than a number,
 * and the date is shown alongside by the renderer rather than instead. */
export function dayLabel(date: string, options: LayoutOptions): string {
  const today = todayIn(options.now, options.displayZone);
  const offset = dayOffset(today, date);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  const c = civilFromDateString(date);
  const utc = Date.UTC(c.y, c.m - 1, c.d);
  /* Formatted in UTC against a UTC-constructed date, so the label can never
   * disagree with the date string it is labelling. Using the display zone here
   * would reintroduce exactly the off-by-one-day bug this codebase is careful
   * about everywhere else. */
  return new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(utc));
}

function isWeekend(date: string): boolean {
  const c = civilFromDateString(date);
  const wd = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  return wd === 0 || wd === 6;
}

/* Sorting within a day: all-day events first, then by start time.
 *
 * All-day first because it is context for the day rather than a point in it -
 * "school holiday" frames every timed event beneath it. This is also the order
 * every mainstream calendar uses, and a wall display is the wrong place to be
 * novel about ordering. */
export function compareWithinDay(a: ShapedEvent, b: ShapedEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const at = a.startTime ?? '';
  const bt = b.startTime ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  const atitle = a.title ?? '';
  const btitle = b.title ?? '';
  return atitle < btitle ? -1 : atitle > btitle ? 1 : 0;
}

export function groupByDay(
  events: readonly ShapedEvent[],
  options: LayoutOptions,
): DayGroup[] {
  const today = todayIn(options.now, options.displayZone);
  const byDate = new Map<string, ShapedEvent[]>();
  for (const event of events) {
    const bucket = byDate.get(event.date);
    if (bucket) bucket.push(event);
    else byDate.set(event.date, [event]);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, list]) => ({
      date,
      label: dayLabel(date, options),
      isToday: date === today,
      isTomorrow: dayOffset(today, date) === 1,
      isWeekend: isWeekend(date),
      events: [...list].sort(compareWithinDay),
    }));
}

/* ------------------------------------------------------------------ agenda */

export type AgendaModel = {
  readonly kind: 'agenda';
  readonly days: readonly DayGroup[];
  /** How many events were dropped by the limit, for a "+3 more" affordance. */
  readonly overflow: number;
  readonly empty: boolean;
  /** Shown when there is nothing: never an empty rectangle on a wall. */
  readonly emptyMessage: string;
};

export type AgendaOptions = LayoutOptions & {
  /** How many events to show. Comes from the block's declared size. */
  readonly limit?: number;
  /** How many days ahead to consider. */
  readonly days?: number;
};

/* The agenda block: the default, and the right one for a wall.
 *
 * Past events are excluded, with one deliberate exception: an event still in
 * progress stays. A display showing this morning's dentist appointment at 5pm
 * is worse than showing nothing because it looks current - but hiding the
 * meeting you are currently in is its own kind of wrong. */
export function agenda(
  events: readonly ShapedEvent[],
  options: AgendaOptions,
): AgendaModel {
  const limit = options.limit ?? 8;
  const horizon = options.days ?? 14;
  const today = todayIn(options.now, options.displayZone);
  const nowCivil = utcMsToCivil(options.now.getTime(), options.displayZone);
  const nowTime = `${String(nowCivil.hh).padStart(2, '0')}:${String(nowCivil.mm).padStart(2, '0')}`;
  const lastDate = civilDateString(addCivilDays(civilFromDateString(today), horizon));

  const eligible = events.filter((e) => {
    if (e.date < today || e.date > lastDate) return false;
    if (e.date > today) return true;
    /* Today: keep all-day events and anything not yet finished. */
    if (e.allDay) return true;
    return (e.endTime ?? e.startTime ?? '23:59') >= nowTime;
  });

  const sorted = [...eligible].sort((a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : compareWithinDay(a, b)));
  const shown = sorted.slice(0, limit);

  return {
    kind: 'agenda',
    days: groupByDay(shown, options),
    overflow: Math.max(0, sorted.length - shown.length),
    empty: shown.length === 0,
    /* Phrased as a fact about the calendar rather than an error, because an
     * empty week is good news and should not read as a broken integration. */
    emptyMessage: 'Nothing scheduled',
  };
}

/* ------------------------------------------------------------ day columns */

export type DayColumn = DayGroup & {
  /** The oversized panel. Exactly one column carries it. */
  readonly emphasis: boolean;
  /** Fixed position, 0-based. The anchor for stable person placement. */
  readonly position: number;
};

export type DayColumnsModel = {
  readonly kind: 'day-columns';
  readonly columns: readonly DayColumn[];
  readonly empty: boolean;
  readonly emptyMessage: string;
};

export type DayColumnsOptions = LayoutOptions & {
  /** 3 to 5. Clamped rather than rejected: a block size must always render. */
  readonly days?: number;
  /** Cap per column so one busy day cannot push the others off the screen. */
  readonly perDay?: number;
};

/* Day columns with an oversized TODAY panel - the researched answer for a
 * wall, and the reason there is no month grid.
 *
 * EVERY column in range is emitted even when it holds no events. A column
 * that appears and disappears with its contents makes the layout jump, and
 * glanceability depends on the furniture not moving: after a week the
 * household knows Thursday is third from the left and stops reading headings.
 */
export function dayColumns(
  events: readonly ShapedEvent[],
  options: DayColumnsOptions,
): DayColumnsModel {
  const span = Math.min(5, Math.max(3, options.days ?? 4));
  const perDay = options.perDay ?? 6;
  const today = todayIn(options.now, options.displayZone);

  const grouped = new Map(groupByDay(events, options).map((g) => [g.date, g]));
  const columns: DayColumn[] = [];

  for (let i = 0; i < span; i++) {
    const date = civilDateString(addCivilDays(civilFromDateString(today), i));
    const group = grouped.get(date);
    columns.push({
      date,
      label: dayLabel(date, options),
      isToday: i === 0,
      isTomorrow: i === 1,
      isWeekend: isWeekend(date),
      events: (group?.events ?? []).slice(0, perDay),
      /* TODAY is the emphasis, always. Not "the busiest day" and not "the next
       * day with something on it": a moving emphasis is a moving layout. */
      emphasis: i === 0,
      position: i,
    });
  }

  return {
    kind: 'day-columns',
    columns,
    empty: columns.every((c) => c.events.length === 0),
    emptyMessage: 'Nothing scheduled',
  };
}

/* ---------------------------------------------------------------- up next */

export type UpNextModel = {
  readonly kind: 'up-next';
  readonly primary: (ShapedEvent & {readonly when: string}) | null;
  readonly secondary: (ShapedEvent & {readonly when: string}) | null;
  readonly empty: boolean;
  readonly emptyMessage: string;
};

export type UpNextOptions = LayoutOptions & {
  /** 1 or 2. A single cell has room for no more. */
  readonly count?: 1 | 2;
};

/* Relative phrasing, because a single cell has no room for context and "in
 * 20 min" is what the reader actually wants from a glance on the way out of
 * the door. Falls back to a day name once relative time stops being useful -
 * "in 2 days" is a worse sentence than "Thursday". */
export function relativeWhen(event: ShapedEvent, options: LayoutOptions): string {
  const today = todayIn(options.now, options.displayZone);
  const offset = dayOffset(today, event.date);

  if (event.allDay) {
    if (offset === 0) return 'Today';
    if (offset === 1) return 'Tomorrow';
    return dayLabel(event.date, options);
  }

  const nowCivil = utcMsToCivil(options.now.getTime(), options.displayZone);
  if (offset === 0 && event.startTime) {
    const minutes = (Number(event.startTime.slice(0, 2)) * 60 + Number(event.startTime.slice(3, 5)))
      - (nowCivil.hh * 60 + nowCivil.mm);
    if (minutes <= 0) return 'Now';
    if (minutes < 60) return `in ${minutes} min`;
    if (minutes < 240) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? `in ${hours} hr` : `in ${hours} hr ${rest} min`;
    }
    return event.startTime;
  }
  if (offset === 1) return `Tomorrow ${event.startTime ?? ''}`.trim();
  return `${dayLabel(event.date, options)} ${event.startTime ?? ''}`.trim();
}

/* The single-cell block. Deliberately the smallest amount of calendar that is
 * still useful: what is next, and optionally what is after that. */
export function upNext(
  events: readonly ShapedEvent[],
  options: UpNextOptions,
): UpNextModel {
  const model = agenda(events, {...options, limit: 2, days: 30});
  const flat = model.days.flatMap((d) => d.events);
  const count = options.count ?? 2;

  const decorate = (e: ShapedEvent | undefined): (ShapedEvent & {when: string}) | null =>
    e ? {...e, when: relativeWhen(e, options)} : null;

  return {
    kind: 'up-next',
    primary: decorate(flat[0]),
    secondary: count === 2 ? decorate(flat[1]) : null,
    empty: flat.length === 0,
    emptyMessage: 'Nothing scheduled',
  };
}

/* ----------------------------------------------------- person attribution */

/* A person's visual identity: fixed POSITION first, colour second.
 *
 * The research is unambiguous that colour-only identity fails twice over - for
 * the ~8% of men with a colour vision deficiency, and for everyone at three
 * metres where hue discrimination degrades. So a person gets a stable slot
 * index (which a renderer turns into a fixed row, column or lane) AND a
 * colour AND initials. Any one of the three alone is enough to identify them.
 *
 * The slot is derived from the name so it is stable across restarts without
 * anything being persisted - the same property `quoteOfDay` relies on. */
export function personSlot(name: string, slots: number): number {
  if (slots <= 0) return 0;
  /* An unnamed person always takes slot 0 rather than a hash of the empty
   * string, so "no name yet" is a predictable position rather than an
   * arbitrary one that shuffles when the name is filled in. */
  if (!name) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h % slots;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
