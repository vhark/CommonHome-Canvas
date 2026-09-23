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
/* What the renderer is allowed to know.
 *
 * THE RENDERER NEVER FETCHES. It is a pure function of a document plus this
 * bag of already-shaped data, which is what makes the identical function
 * usable on three surfaces and testable without a network. Credentials (Home
 * Assistant, the photo provider, a calendar share URL) live in the server
 * modules that do the fetching and never reach here.
 *
 * TWO LOAD-BEARING SHAPES:
 *
 * 1. `Feed<T>` is either ready or degraded, PER SOURCE. A failed weather fetch
 *    arrives here as `{ok: false}` for that one feed and the page still
 *    renders, with one dimmed block saying so. There is no representation in
 *    this file for "the page failed", because that outcome does not exist.
 *
 * 2. Calendar events arrive as ShapedEvent - the output of shape.ts - and
 *    never as raw iCalendar. The renderer cannot un-shape an event, so the
 *    share-level guarantee cannot be undone downstream of the shaping. The
 *    renderer then re-enforces it anyway at emit time (see blocks.ts), because
 *    this is the layer where output becomes visible to a visitor.
 */

import type {ShapedEvent, ShareLevel} from '../calendar/shape.ts';

/** One data source, resolved or not. `reason` is a short display-safe label,
 * never a provider message: an upstream error string can carry a URL, and a
 * calendar URL is a bearer credential. */
export type Feed<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly reason: string};

export function ready<T>(value: T): Feed<T> {
  return {ok: true, value};
}

export function degraded<T>(reason = 'unavailable'): Feed<T> {
  return {ok: false, reason};
}

/* Attribution as a first-class modelled element, not a styling choice.
 *
 * A photo block without its credit and a weather block without its source are
 * INCORRECT OUTPUT - the licences of the upstream providers require the credit,
 * and the household's own rule is that a number on the wall should say where it
 * came from. So the credit travels with the datum in one record, and the block
 * renderer emits it beneath the thing it describes. */
export type Attribution = {
  /** Human-readable source name, e.g. a provider's own name. */
  readonly source: string;
  /** A person to name, e.g. a photographer. */
  readonly author?: string;
  readonly sourceUrl?: string;
  readonly authorUrl?: string;
};

export type WeatherReading = {
  /** Provider condition token, e.g. `partlycloudy`. Mapped to words below. */
  readonly state: string;
  readonly temperature: number | null;
  readonly unit: string;
  readonly place?: string;
  readonly attribution: Attribution | null;
};

export type PhotoImage = {
  readonly url: string;
  readonly alt?: string;
  readonly caption?: string;
  /** Fallback ground colour while the image paints, or if it never does. */
  readonly color?: string | null;
  readonly attribution: Attribution | null;
};

export type CalendarFeed = {
  readonly name: string | null;
  readonly events: readonly ShapedEvent[];
  /** The level the events were SHAPED at. Not a request for a level. */
  readonly level: ShareLevel;
  readonly attribution?: Attribution | null;
};

/* Keyed by the opaque id a block names. A block never names a URL or an entity
 * id: `{"type":"weather","source":"porch"}` is a reference the server resolves,
 * so a document is portable between households and carries no credential. */
export type RenderData = {
  readonly weather?: {readonly [id: string]: Feed<WeatherReading>};
  readonly photos?: {readonly [id: string]: Feed<PhotoImage>};
  readonly calendars?: {readonly [id: string]: Feed<CalendarFeed>};
};

export const DEFAULT_SOURCE_ID = 'default';

export function feedFor<T>(
  table: {readonly [id: string]: Feed<T>} | undefined,
  id: unknown,
): Feed<T> | null {
  const key = typeof id === 'string' && id !== '' ? id : DEFAULT_SOURCE_ID;
  const feed = table?.[key];
  return feed ?? null;
}

/* A provider's attribution string often arrives as a whole sentence. Rendered
 * verbatim it is a paragraph in a corner of a photograph, so it is shortened to
 * the institution actually being credited - which is what the licences ask for.
 *
 * The period rule is the subtle part: a period only ends the clause when it is
 * followed by whitespace or the end of the string, because the source being
 * credited is frequently a bare domain and a naive `[^,.]+` truncates a domain
 * at its dot. */
export function shortenAttribution(full: unknown): string {
  const text = String(full ?? '').trim();
  if (text === '') return '';
  const from = /from\s+(.+?)(?:,|\.(?:\s|$)|$)/i.exec(text);
  if (from !== null) return from[1]!.trim();
  return text.replace(/\.$/, '');
}

/** Builds an Attribution from a loose record, or null when there is nothing to
 * credit. Nothing to credit is different from a credit we failed to render: a
 * household's own typed note has no source, and inventing one would be worse
 * than omitting it. */
export function attributionFrom(value: unknown): Attribution | null {
  if (typeof value === 'string') {
    const source = shortenAttribution(value);
    return source === '' ? null : {source};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = shortenAttribution(record.source ?? record.attribution ?? '');
  const author = typeof record.author === 'string' ? record.author.trim()
    : typeof record.photographer === 'string' ? record.photographer.trim()
    : '';
  if (source === '' && author === '') return null;
  const out: Attribution = {
    source: source === '' ? 'Unknown source' : source,
    ...(author === '' ? {} : {author}),
    ...(typeof record.sourceUrl === 'string' ? {sourceUrl: record.sourceUrl} : {}),
    ...(typeof record.authorUrl === 'string' ? {authorUrl: record.authorUrl}
      : typeof record.photographerUrl === 'string' ? {authorUrl: record.photographerUrl}
      : {}),
  };
  return out;
}

/* The sentence a credit renders as. A photo credit names the photographer AND
 * the platform, in that order, because that is the form the photo provider's
 * guidelines require and a television cannot be clicked - dropping the credit
 * because the links are unusable would not satisfy the requirement. */
export function creditText(credit: Attribution | null): string {
  if (credit === null) return '';
  if (credit.author !== undefined && credit.author !== '') {
    return `${credit.author} · ${credit.source}`;
  }
  return credit.source;
}

/* Condition words, because a provider token is not English and a wall display
 * is read by whoever walks past. Unknown tokens fall through to a cleaned-up
 * form of the token itself rather than to "unknown": a household that can see
 * `freezing-rain` learns something; one that sees "unknown" learns that the
 * screen is broken, which is a different and false statement. */
const CONDITIONS: Record<string, string> = {
  'clear-night': 'Clear',
  cloudy: 'Cloudy',
  exceptional: 'Exceptional',
  fog: 'Fog',
  hail: 'Hail',
  lightning: 'Thunder',
  'lightning-rainy': 'Thundery showers',
  partlycloudy: 'Partly cloudy',
  pouring: 'Heavy rain',
  rainy: 'Rain',
  snowy: 'Snow',
  'snowy-rainy': 'Sleet',
  sunny: 'Sunny',
  windy: 'Windy',
  'windy-variant': 'Windy',
};

export function conditionText(state: unknown): string {
  const token = String(state ?? '').trim().toLowerCase();
  if (token === '') return '';
  const known = CONDITIONS[token];
  if (known !== undefined) return known;
  const words = token.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
