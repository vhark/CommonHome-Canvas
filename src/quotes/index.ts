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
/* The quote of the day, and the ordering that makes it bearable.
 *
 * PORTED OUT OF spikes/ambient-model.ts, which is disposable. This logic is
 * load-bearing - it decides what a household reads on its wall every morning -
 * and load-bearing code does not live in a directory the project intends to
 * delete. The spike's own copy stays where it is; nothing here imports it, and
 * nothing there imports this.
 *
 * TWO PROPERTIES, BOTH DELIBERATE:
 *
 * 1. DETERMINISTIC FROM THE LOCAL DATE. Every screen in the house shows the
 *    same quote on the same day, with nothing persisted and no coordination -
 *    it is a pure function of (library, civil date). A random pick would need
 *    a seed, a store, and a way for six screens to agree; this needs none.
 *
 * 2. NO AUTHOR TWO DAYS RUNNING. The library is written in thematic groups, so
 *    walking it in storage order put the same author on consecutive days
 *    routinely. Adjacency is a property of the ORDER, not of the size, so a
 *    bigger library does not fix it - the order is computed instead.
 *
 * The civil date is resolved through the RENDER's time zone rather than the
 * process's, because a container's zone is an accident of its image and the
 * whole product already routes every other date through one configured zone.
 */

import {QUOTES, type Quote} from './library.ts';

export {QUOTES, type Quote};

/* Hedged attributions name the same person as their bare form: 'Attributed to
 * Eleanor Roosevelt' must not be treated as a different author from 'Eleanor
 * Roosevelt', or the spacing silently fails for exactly the disputed quotes
 * where we were most careful. */
export function authorKey(author: string): string {
  return String(author ?? '')
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
 * library. When it IS impossible the function still returns a total order
 * rather than throwing: a wall display must render something.
 *
 * Deterministic, not shuffled. The buckets are sorted by key so the result
 * depends only on the library contents, never on Map insertion order or an
 * engine's iteration quirks. */
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

  /* The sequence WRAPS: after the last day it returns to the first. Without
   * this the library boundary is the one place the whole exercise leaks, and
   * it leaks once a year in a way nobody will connect to this function. */
  if (authorKey(quotes[out[0]]!.author) === authorKey(quotes[out[n - 1]]!.author)) {
    for (let i = 1; i < n - 1; i++) {
      const a = authorKey(quotes[out[i]]!.author);
      const before = authorKey(quotes[out[i - 1]]!.author);
      const after = authorKey(quotes[out[i + 1]]!.author);
      const tail = authorKey(quotes[out[n - 1]]!.author);
      const tailBefore = authorKey(quotes[out[n - 2]]!.author);
      const head = authorKey(quotes[out[0]]!.author);
      if (a !== tail && a !== tailBefore && tail !== before && tail !== after && a !== head) {
        const t = out[i]!;
        out[i] = out[n - 1]!;
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

export function orderOf(quotes: readonly Quote[]): number[] {
  const cached = orderCache.get(quotes as unknown as object);
  if (cached) return cached;
  const order = spacedOrder(quotes);
  orderCache.set(quotes as unknown as object, order);
  return order;
}

/* The civil day number in a named zone: whole days since 1970-01-01 as that
 * zone reckons them.
 *
 * Via Intl rather than `getTimezoneOffset`, which reports the HOST's offset
 * and would make a container in UTC disagree with the household it serves
 * about when midnight is. An unusable zone falls back to UTC rather than
 * throwing - a wall display must still show a quote. */
export function civilDayNumber(now: Date, timeZone: string): number {
  let iso: string;
  try {
    iso = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/** The day's quote, or null for an empty library. Same date, same answer, on
 * every screen in the house and on every render of the same minute. */
export function quoteOfDay(
  now: Date,
  timeZone = 'UTC',
  quotes: readonly Quote[] = QUOTES,
): Quote | null {
  if (quotes.length === 0) return null;
  const order = orderOf(quotes);
  const day = civilDayNumber(now, timeZone);
  const slot = ((day % order.length) + order.length) % order.length;
  return quotes[order[slot]!] ?? null;
}

/** The quote as a Text block's body: the words, then the author on their own
 * paragraph. renderText splits on blank lines, so this becomes two paragraphs
 * with no markup of ours and no escaping bypass. */
export function quoteBody(quote: Quote | null): string {
  if (quote === null) return '';
  return `\u201c${quote.text}\u201d\n\n\u2014 ${quote.author}`;
}

/** How many adjacent pairs of the computed order share an author, counting
 * the wrap from the last day back to the first. Exported because it is the
 * measurement the spacing rule is asserted on, and a test that recomputes it
 * separately would be asserting against its own copy of the rule. */
export function adjacentAuthorPairs(
  quotes: readonly Quote[],
  order: readonly number[] = orderOf(quotes),
): number {
  if (order.length < 2) return 0;
  let pairs = 0;
  for (let i = 0; i < order.length; i++) {
    const a = authorKey(quotes[order[i]!]!.author);
    const b = authorKey(quotes[order[(i + 1) % order.length]!]!.author);
    if (a === b) pairs += 1;
  }
  return pairs;
}
