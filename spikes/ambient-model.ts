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
/* CommonHome Canvas — ambient screen SPIKE: pure logic.
 *
 * Split out of ambient.ts so it can be tested without a browser. ambient.ts
 * performs DOM work and starts timers at import time; anything that encodes a
 * PRODUCT RULE lives here instead, where it can be asserted directly.
 *
 * The rules that matter:
 *   - the focal slot holds exactly one element, chosen by precedence
 *   - Home Assistant condition slugs never reach a family wall raw
 *   - a stale snapshot is disclosed, never presented as current
 *   - every rendered value can name where it came from
 */

import {QUOTES, type Quote} from './quotes.ts';

export type {Quote};

export type Weather = {
  state: string;
  temperature: number | null;
  unit: string;
  attribution: string;
};

export type CalendarEvent = {summary: string; start: string; allDay: boolean};

export type Photo = {
  url: string;
  color: string | null;
  blurHash: string | null;
  photographer: string;
  photographerUrl: string;
  source: string;
  sourceUrl: string;
};

export type Snapshot = {
  weather: Weather | null;
  events: CalendarEvent[];
  peopleHome: string[];
  photo: Photo | null;
  generatedAt: string;
  degraded: string[];
};

/* Home Assistant weather states are machine slugs (partlycloudy,
 * lightning-rainy, exceptional). Rendering them raw puts developer identifiers
 * on a family wall. Mapped explicitly rather than by regex, because the slugs
 * are a closed set and "partlycloudy" has no separator to split on. */
const CONDITIONS: Record<string, string> = {
  'clear-night': 'Clear', cloudy: 'Cloudy', fog: 'Fog', hail: 'Hail',
  lightning: 'Thunderstorms', 'lightning-rainy': 'Thunderstorms',
  partlycloudy: 'Partly cloudy', pouring: 'Heavy rain', rainy: 'Rain',
  snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny',
  windy: 'Windy', 'windy-variant': 'Windy', exceptional: 'Severe weather',
};

export function conditionText(state: string): string {
  const mapped = CONDITIONS[state];
  if (mapped) return mapped;
  /* Unknown slug: still never show a raw identifier. Separators become spaces
   * and the first letter is capitalised, so a future HA condition degrades to
   * readable English rather than leaking a developer string. */
  const spaced = String(state ?? '').replace(/[-_]/g, ' ').trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function greeting(now: Date, names: string[]): string {
  const h = now.getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning'
    : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
  if (names.length === 0) return part;
  if (names.length === 1) return `${part}, ${names[0]}`;
  if (names.length === 2) return `${part}, ${names[0]} and ${names[1]}`;
  return `${part}, ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function eventTime(event: CalendarEvent, locale?: string): string {
  if (event.allDay) return 'All day';
  const d = new Date(event.start);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(locale, {hour: 'numeric', minute: '2-digit'});
}

/* The focal slot is a layout CONTRACT, not a stack. Candidates compete for one
 * below-centre slot and exactly one wins; they are never shown together.
 *
 * Precedence reflects what a household glancing at a wall needs to know next:
 * a commitment beats ambient conditions. Past events are excluded - a display
 * showing this morning's dentist appointment at 5pm is worse than showing
 * nothing, because it looks current. */
export function focal(
  snapshot: Snapshot,
  now: Date,
  locale?: string,
): {label: string; value: string} | null {
  const upcoming = snapshot.events
    .filter((e) => {
      if (e.allDay) return true;
      const t = new Date(e.start).getTime();
      return !Number.isNaN(t) && t >= now.getTime();
    })
    .sort((a, b) => (a.allDay ? 0 : new Date(a.start).getTime()) -
                    (b.allDay ? 0 : new Date(b.start).getTime()));

  if (upcoming.length > 0) {
    const next = upcoming[0];
    const when = eventTime(next, locale);
    return {label: when ? `Next · ${when}` : 'Next', value: next.summary};
  }

  /* No weather fallback. Weather renders once, top-right, with its credit;
   * repeating it centre-stage made the screen text-heavy and told the viewer
   * nothing the corner had not. An empty focal slot is the calm outcome. */
  return null;
}

/* ------------------------------------------------------------------ quote */

/* Quote of the day, chosen deterministically from the local date.
 *
 * Deterministic rather than random for two reasons. A wall display re-renders
 * often - polls, restarts, power cycles - and a quote that changes on every
 * refresh reads as churn, not inspiration. And every display in the house
 * showing the SAME quote on the same day makes it a small shared artifact
 * rather than per-screen noise.
 *
 * Uses the LOCAL calendar date, so the quote changes at the household's
 * midnight, not UTC's. */
export function quoteOfDay(now: Date, quotes: readonly Quote[] = QUOTES): Quote | null {
  if (quotes.length === 0) return null;
  const daysSinceEpoch = Math.floor(
    (now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000,
  );
  const order = orderOf(quotes);
  const slot = ((daysSinceEpoch % order.length) + order.length) % order.length;
  return quotes[order[slot]];
}

/* Two quotes by the same person should not land on consecutive days.
 *
 * Walking the array in storage order made that happen routinely: the library
 * is written in thematic groups, so neighbouring entries often share an
 * author. A 100-entry library had 29 adjacent same-author pairs - including
 * Marcus Aurelius at 17 and 18, which is the case that got reported.
 *
 * A bigger library does NOT fix this on its own. Adjacency is a property of
 * the ORDER, not the size: 400 quotes walked in storage order still shows the
 * same author twice running wherever two of theirs sit side by side. So the
 * ordering is computed rather than assumed.
 *
 * Deterministic, not shuffled. Every display in the house must show the same
 * quote on the same day (that is the point of quoteOfDay), and a random
 * shuffle would need seeding and storing. A pure function of the library gives
 * the same order everywhere, forever, with nothing persisted. */

/* Hedged attributions name the same person as their bare form: 'Attributed to
 * Eleanor Roosevelt' must not be treated as a different author from 'Eleanor
 * Roosevelt', or the spacing silently fails for exactly the disputed quotes
 * where we were most careful. */
export function authorKey(author: string): string {
  return author
    .replace(/^(?:traditional|proverb)\s*;\s*/i, '')
    .replace(/^(?:often\s+)?attributed\s+to\s+/i, '')
    .replace(/^(?:widely\s+)?misattributed\s+to\s+/i, '')
    .trim()
    .toLowerCase();
}

/* Greedy max-remaining-first, the standard way to rearrange a multiset so no
 * two neighbours match: at each slot take the author with the most quotes
 * left, excluding whoever filled the previous slot. Taking the largest pile
 * first is what stops it painting itself into a corner - a dominant author
 * left to the end has nowhere to go but adjacent to itself.
 *
 * Perfect spacing is impossible if one author holds more than half the
 * library; the quote-library task caps any author at 4, so that is headroom,
 * not a promise. When it IS impossible the function still returns a total
 * order rather than throwing - a wall display must render something. */
export function spacedOrder(quotes: readonly Quote[]): number[] {
  const n = quotes.length;
  if (n <= 2) return quotes.map((_, i) => i);

  const byAuthor = new Map<string, number[]>();
  quotes.forEach((q, i) => {
    const k = authorKey(q.author);
    const bucket = byAuthor.get(k);
    if (bucket) bucket.push(i);
    else byAuthor.set(k, [i]);
  });

  /* Sort buckets by key so the result depends only on the library contents,
   * never on Map insertion order or engine iteration quirks. */
  const buckets = [...byAuthor.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const out: number[] = [];
  let previous: string | null = null;
  for (let slot = 0; slot < n; slot++) {
    let pick: (typeof buckets)[number] | null = null;
    for (const candidate of buckets) {
      if (candidate[1].length === 0) continue;
      if (candidate[0] === previous) continue;
      if (pick === null || candidate[1].length > pick[1].length) pick = candidate;
    }
    /* Only reachable when every remaining quote shares the previous author. */
    if (pick === null) pick = buckets.find((b) => b[1].length > 0)!;
    out.push(pick[1].shift()!);
    previous = pick[0];
  }

  /* The sequence wraps: after the last day it returns to the first. Without
   * this the library boundary is the one place the whole exercise leaks. */
  if (authorKey(quotes[out[0]].author) === authorKey(quotes[out[n - 1]].author)) {
    for (let i = 1; i < n - 1; i++) {
      const a = authorKey(quotes[out[i]].author);
      const before = authorKey(quotes[out[i - 1]].author);
      const after = authorKey(quotes[out[i + 1]].author);
      const tail = authorKey(quotes[out[n - 1]].author);
      const tailBefore = authorKey(quotes[out[n - 2]].author);
      const head = authorKey(quotes[out[0]].author);
      if (a !== tail && a !== tailBefore && tail !== before && tail !== after && a !== head) {
        const t = out[i];
        out[i] = out[n - 1];
        out[n - 1] = t;
        break;
      }
    }
  }
  return out;
}

/* Cached per library so a wall display that re-renders on every poll does not
 * recompute the ordering each time. Keyed on the array identity and never
 * mutated after construction, so callers still see a pure function: the same
 * library always yields the same order. */
const orderCache = new WeakMap<object, number[]>();
function orderOf(quotes: readonly Quote[]): number[] {
  const cached = orderCache.get(quotes as unknown as object);
  if (cached) return cached;
  const order = spacedOrder(quotes);
  orderCache.set(quotes as unknown as object, order);
  return order;
}

/* ------------------------------------------------------------ attribution */

/* Attribution is a first-class element, not fine print.
 *
 * Two reasons it is modelled rather than hard-coded into markup. First,
 * obligation: met.no's terms require crediting the forecast, and Unsplash
 * requires naming the photographer and the source. Second, product doctrine -
 * doc 49 says a household should always be able to see where a number came
 * from. A display that states the weather without saying who forecast it is
 * asking to be trusted without showing its work.
 *
 * Each credit is bound to the thing it describes and rendered next to it, so
 * the relationship is visible rather than implied by a footnote. */
export type Credit = {
  /** What this credit belongs to: the data it describes. */
  of: 'weather' | 'calendar' | 'presence' | 'photo';
  /** Human-readable source name, e.g. "met.no". */
  source: string;
  /** Optional person to name, e.g. an Unsplash photographer. */
  author?: string;
  /** Optional link for the author, carrying required UTM parameters. */
  authorUrl?: string;
  /** Optional link for the source, carrying required UTM parameters. */
  sourceUrl?: string;
};

/* met.no's attribution string arrives as a full sentence:
 * "Weather forecast from met.no, delivered by the Norwegian Meteorological
 * Institute." Rendered verbatim it is a paragraph in a corner. Shortened to
 * the institution actually being credited, which is what the licence asks
 * for, while the full string remains available for a details view. */
export function shortenAttribution(full: string): string {
  const text = String(full ?? '').trim();
  if (!text) return '';
  /* Stop at a comma or a sentence-ending period, but NOT at a period inside a
   * domain: the source being credited here is literally "met.no", and a naive
   * [^,.]+ truncates it to "met". A period only ends the clause when followed
   * by whitespace or the end of the string. */
  const from = text.match(/from\s+(.+?)(?:,|\.(?:\s|$)|$)/i);
  if (from) return from[1].trim();
  return text.replace(/\.$/, '');
}

export function weatherCredit(weather: Weather | null): Credit | null {
  if (!weather) return null;
  const source = shortenAttribution(weather.attribution);
  return source ? {of: 'weather', source} : null;
}

export function photoCredit(photo: Photo | null): Credit | null {
  if (!photo) return null;
  if (!photo.photographer || !photo.source) return null;
  return {
    of: 'photo',
    source: photo.source,
    sourceUrl: photo.sourceUrl,
    author: photo.photographer,
    authorUrl: photo.photographerUrl,
  };
}

/* Unsplash's API guidelines require the form "Photo by <name> on Unsplash"
 * with both names linked. On a television nothing is clickable, so the text
 * credit still renders in full and the links travel with the model for any
 * surface that can use them. Dropping the credit because a TV cannot be
 * clicked would not satisfy the requirement. */
export function creditText(credit: Credit | null): string {
  if (!credit) return '';
  if (credit.of === 'photo' && credit.author) {
    return `Photo by ${credit.author} on ${credit.source}`;
  }
  return credit.source;
}

/* Degradation is stated, never faked. Doc 38 commits to a never-blank
 * invariant, but "never blank" must not become "silently wrong": a screen
 * rendering a cached snapshot says so once it is meaningfully old. */
export function healthText(
  snapshot: Snapshot | null,
  now: Date,
  staleAfterMinutes = 2,
): string {
  if (!snapshot) return 'Waiting for data';
  if (snapshot.degraded.length === 0) return '';
  const generated = new Date(snapshot.generatedAt).getTime();
  if (Number.isNaN(generated)) return `Partial: ${snapshot.degraded.join(', ')}`;
  const age = Math.round((now.getTime() - generated) / 60000);
  return age > staleAfterMinutes
    ? `Showing last known good · ${age} min old`
    : `Partial: ${snapshot.degraded.join(', ')}`;
}
