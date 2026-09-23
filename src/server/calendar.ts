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
/* Server-side ICS fetch. One source type, every provider.
 *
 * WHY THIS IS A SERVER MODULE AND NOT A BROWSER FETCH - two independent
 * reasons, either of which alone would be sufficient:
 *
 *   1. THE SOURCE URL IS A CREDENTIAL. Google's "secret address", Apple's
 *      private link and Nextcloud's share token all embed an unguessable token
 *      in the URL, and possession grants permanent, unrevoked-until-rotated
 *      read of the whole calendar. Some embed the account's email in the path.
 *      It is a bearer credential wearing the costume of a link, so it obeys
 *      the same rule as the Home Assistant token: it lives in this process,
 *      is never serialised into a snapshot, never appears in an export, never
 *      reaches a log and is never echoed back into a settings form.
 *
 *   2. FIELD-LEVEL SHARE SAFETY must be enforced before anything crosses to a
 *      page. A browser fetching the ICS directly would hold every DESCRIPTION
 *      in the calendar - street addresses, phone numbers - whatever the
 *      rendering code then chose to draw.
 *
 * DISCIPLINE REUSED, NOT REINVENTED. This follows snapshot.ts exactly:
 * an injectable fetch, an explicit timeout, last-known-good on failure, and
 * graceful degradation that records itself in `degraded` rather than blanking
 * the screen. A calendar that fails to refresh shows yesterday's events.
 *
 * CONDITIONAL REQUESTS ARE MANDATORY, not an optimisation. A wall display
 * polls on a timer forever; re-downloading an unchanged feed every minute is
 * rude to the provider and is how a household gets rate limited or blocked.
 * ETag and Last-Modified are stored per source and replayed as
 * If-None-Match / If-Modified-Since, and a 304 costs nothing on either side.
 */

import {parseICalendar, type CalendarWarning, type ParsedCalendar} from '../calendar/parse.ts';
import {expandCalendar, type Occurrence} from '../calendar/recurrence.ts';
import {shapeCalendar, type ShapedCalendar, type ShareLevel} from '../calendar/shape.ts';
import {hostTimeZone} from '../calendar/time.ts';

/* Matches snapshot.ts's FetchLike, widened to carry the fields a conditional
 * request needs. Injectable so tests exercise 304s, timeouts and failures
 * without a network. */
export type FetchLike = (
  input: string,
  init?: {headers?: Record<string, string>; signal?: AbortSignal; redirect?: string},
) => Promise<{
  ok: boolean;
  status: number;
  headers: {get(name: string): string | null};
  text(): Promise<string>;
}>;

const FETCH_TIMEOUT_MS = 12_000;

/* A calendar feed is text. A 10 MB response is either not a calendar or a feed
 * nobody should be putting on a kitchen wall, and reading it unbounded into a
 * display server's memory is how a remote host causes an OOM on the device. */
const MAX_BYTES = 8 * 1024 * 1024;

/** How stale a cached body may be before a refresh is attempted. */
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

export type CalendarSource = {
  /** Stable, opaque, safe to expose. NOT derived from the URL. */
  readonly id: string;
  /** Display name for the calendar. Household-chosen. */
  readonly label: string;
  /** THE CREDENTIAL. Never leaves this process. */
  readonly url: string;
  /** What a share of this calendar may reveal. */
  readonly level: ShareLevel;
  /** Opt-in titles on a shared canvas. Default false. */
  readonly showTitles?: boolean;
  readonly refreshMs?: number;
};

export type CalendarFetchResult = {
  readonly parsed: ParsedCalendar | null;
  /** True when the response was a 304 and the cached body was reused. */
  readonly fromCache: boolean;
  /** Set when this refresh failed and last-known-good is being served. */
  readonly stale: boolean;
  readonly warnings: readonly CalendarWarning[];
  readonly degraded: readonly string[];
  /** When the body currently in hand was actually downloaded. */
  readonly fetchedAt: number | null;
};

type CacheEntry = {
  body: string;
  parsed: ParsedCalendar;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
};

/* Errors are redacted at the throw site, not at the log site.
 *
 * Node's fetch puts the full URL into the message of most network errors, and
 * an unguessable calendar token in a container log is a permanent leak - logs
 * get shipped, pasted into issues and archived. So the URL is stripped here,
 * once, and what escapes this module can only name a HOST. */
export function redactUrls(text: string): string {
  return String(text)
    .replace(/\b(?:https?|webcal):\/\/\S+/gi, '[calendar url redacted]');
}

/** A short, stable, non-reversible label for a source, safe for logs. */
export function sourceFingerprint(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

/* Accepts what a household will actually paste.
 *
 * `webcal://` is the scheme Apple and Outlook hand out from their share
 * dialogs and it is not a real protocol - it is https with a different name,
 * and every calendar client rewrites it. Rejecting it would make the most
 * common paste fail for no reason the household could diagnose. */
export function normaliseSourceUrl(raw: string): {ok: true; url: string} | {ok: false; reason: string} {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return {ok: false, reason: 'no calendar address was given'};

  let candidate = trimmed;
  if (/^webcal:\/\//i.test(candidate)) candidate = 'https://' + candidate.slice('webcal://'.length);

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    /* The reason deliberately does not quote the input: it may BE the
     * credential, and an error message is the classic way one ends up in a
     * log or on a settings page. */
    return {ok: false, reason: 'that does not look like a calendar address'};
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {ok: false, reason: 'a calendar address must be https'};
  }
  /* http is permitted only for loopback, where a household may legitimately
   * be testing against something local; over a network it would put a bearer
   * credential on the wire in the clear. */
  if (parsed.protocol === 'http:'
      && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    return {ok: false, reason: 'a calendar address must be https'};
  }
  return {ok: true, url: parsed.toString()};
}

/* Per-instance rather than module-global, matching SnapshotSource: tests stay
 * order-independent and a second server in the same process does not inherit
 * another's cache. */
export class CalendarFetcher {
  readonly #fetch: FetchLike;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #displayZone: string;
  #now: () => number;

  constructor(options: {
    fetchImpl?: FetchLike;
    displayZone?: string | null;
    now?: () => number;
  } = {}) {
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#displayZone = options.displayZone || hostTimeZone();
    this.#now = options.now ?? (() => Date.now());
  }

  get displayZone(): string {
    return this.#displayZone;
  }

  /** Forgets a cached body, e.g. when a household changes the URL. */
  forget(id: string): void {
    this.#cache.delete(id);
  }

  async fetchSource(source: CalendarSource): Promise<CalendarFetchResult> {
    const cached = this.#cache.get(source.id) ?? null;
    const refreshMs = source.refreshMs ?? DEFAULT_REFRESH_MS;

    /* Serving a recent body without asking is the politest conditional
     * request of all: none. */
    if (cached && this.#now() - cached.fetchedAt < refreshMs) {
      return {
        parsed: cached.parsed,
        fromCache: true,
        stale: false,
        warnings: cached.parsed.warnings,
        degraded: [],
        fetchedAt: cached.fetchedAt,
      };
    }

    const normalised = normaliseSourceUrl(source.url);
    if (!normalised.ok) {
      return this.#degrade(cached, 'calendar');
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
        /* Identifies the client without identifying the household. Providers
         * block blank and browser-spoofed agents, and a real name is what
         * lets one of them contact the project rather than silently block it. */
        'User-Agent': 'CommonHomeCanvas/1.0 (+https://github.com/commonhome/canvas)',
      };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

      const res = await this.#fetch(normalised.url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        /* Follows redirects - `?export` endpoints and webcal rewrites both
         * redirect routinely - but the URL is never echoed anywhere, so a
         * redirect cannot become a disclosure. */
        redirect: 'follow',
      });

      /* The whole point of the conditional request. Nothing was transferred
       * and the cached parse is reused without re-parsing. */
      if (res.status === 304 && cached) {
        cached.fetchedAt = this.#now();
        return {
          parsed: cached.parsed,
          fromCache: true,
          stale: false,
          warnings: cached.parsed.warnings,
          degraded: [],
          fetchedAt: cached.fetchedAt,
        };
      }

      if (!res.ok) {
        /* The status is kept; the URL is not. A 404 tells the household the
         * link is wrong, which is useful and safe. */
        return this.#degrade(cached, 'calendar');
      }

      const body = await res.text();
      if (body.length > MAX_BYTES) return this.#degrade(cached, 'calendar');
      /* A provider serving an HTML error page with a 200 is common enough to
       * check for: without this the parser returns zero events and the
       * household sees an empty calendar rather than a problem. */
      if (!/BEGIN:VCALENDAR/i.test(body)) return this.#degrade(cached, 'calendar');

      const parsed = parseICalendar(body, {displayZone: this.#displayZone});
      const entry: CacheEntry = {
        body,
        parsed,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        fetchedAt: this.#now(),
      };
      this.#cache.set(source.id, entry);

      return {
        parsed,
        fromCache: false,
        stale: false,
        warnings: parsed.warnings,
        degraded: [],
        fetchedAt: entry.fetchedAt,
      };
    } catch {
      /* Deliberately swallows the error object rather than inspecting it: Node
       * puts the URL in network error messages, and the only safe thing to do
       * with a value that may contain a credential is not to touch it. */
      return this.#degrade(cached, 'calendar');
    }
  }

  #degrade(cached: CacheEntry | null, label: string): CalendarFetchResult {
    /* Last-known-good. A wall display showing yesterday's events, marked
     * stale, is strictly better than one showing an error - the household
     * still learns when the bins go out. */
    if (cached) {
      return {
        parsed: cached.parsed,
        fromCache: true,
        stale: true,
        warnings: cached.parsed.warnings,
        degraded: [label],
        fetchedAt: cached.fetchedAt,
      };
    }
    return {
      parsed: null,
      fromCache: false,
      stale: true,
      warnings: [],
      degraded: [label],
      fetchedAt: null,
    };
  }

  /* Fetch, expand and shape in one call: the shape a route handler wants.
   *
   * The ORDER is the security property. Shaping happens last and is the only
   * thing that produces a browser-bound value, so there is no path from a raw
   * VEVENT to a response that does not pass through shape.ts. */
  async load(
    source: CalendarSource,
    options: {
      readonly windowDays?: number;
      readonly now?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<ShapedCalendar> {
    const now = options.now ?? new Date(this.#now());
    const windowDays = options.windowDays ?? 30;
    const result = await this.fetchSource(source);

    if (!result.parsed) {
      return shapeCalendar([], {
        level: source.level,
        showTitles: source.showTitles,
        displayZone: this.#displayZone,
        name: source.label,
        warnings: result.warnings,
        degraded: result.degraded,
        now,
      });
    }

    const fromMs = now.getTime() - 24 * 3600 * 1000;
    const toMs = now.getTime() + windowDays * 24 * 3600 * 1000;
    const {occurrences, warnings} = expandCalendar(result.parsed.events, {
      fromMs,
      toMs,
      displayZone: this.#displayZone,
    });

    return shapeCalendar(occurrences, {
      level: source.level,
      showTitles: source.showTitles,
      displayZone: this.#displayZone,
      limit: options.limit,
      /* The household's own label wins over the publisher's X-WR-CALNAME,
       * which is often a generated string or an email address. */
      name: source.label || result.parsed.name,
      warnings: [...warnings, ...result.warnings],
      degraded: [...result.degraded, ...(result.stale ? ['calendar-stale'] : [])],
      now,
    });
  }
}

/* Describes a configured source WITHOUT revealing its address, for a health
 * endpoint or a settings page. The same discipline as describeConfig: saying a
 * URL is set is useful, saying what it is is how credentials end up in logs.
 *
 * Note there is no `url` key and no way to obtain one from this type - a
 * settings form must show a blank field and an "address saved" note rather
 * than round-tripping the value, because a page that renders the URL back
 * puts it in browser history and in any screenshot of the settings screen. */
export function describeSource(source: CalendarSource): Record<string, string> {
  let host = '(unreadable)';
  const normalised = normaliseSourceUrl(source.url);
  if (normalised.ok) {
    try {
      host = new URL(normalised.url).host;
    } catch {
      host = '(unreadable)';
    }
  }
  return {
    id: source.id,
    label: source.label,
    /* The HOST only. It says "this is a Google calendar", which is what a
     * household needs to debug a broken feed, and carries no token. */
    provider: host,
    fingerprint: sourceFingerprint(source.url),
    level: source.level,
    titles: source.level === 'shared' ? (source.showTitles ? 'shown' : 'withheld') : 'shown',
    address: 'set (never displayed)',
  };
}
