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
/* The calendar route handler, defined HERE rather than in server.ts.
 *
 * server.ts is owned by another workstream, so this module exposes a handler
 * with a narrow, self-contained signature that server.ts can call in three
 * lines. The wiring required is documented at the bottom of this file.
 *
 * WHY THE HANDLER LIVES WITH THE SHAPING: the route is where a mistake would
 * be invisible. Putting it next to shape.ts means the person editing the
 * share rules and the person editing the response body are reading the same
 * file, and the leak test covers both.
 */

import type {CalendarFetcher, CalendarSource} from './calendar.ts';
import type {ShapedCalendar} from '../calendar/shape.ts';
import {auditShared, NEVER_SHARED_KEYS} from '../calendar/shape.ts';

export type CalendarRouteResult = {
  readonly status: number;
  readonly body: unknown;
  /** Always no-store: a calendar response is per-viewer and time-sensitive. */
  readonly headers: Readonly<Record<string, string>>;
};

/* An empty but well-formed payload, so a display that has never had a
 * successful fetch renders its empty state rather than a parse error. Mirrors
 * `emptySnapshot` in snapshot.ts deliberately. */
export function emptyCalendar(level: 'private' | 'shared', degraded: string[] = ['calendar']): ShapedCalendar {
  return {
    name: null,
    events: [],
    level,
    generatedAt: new Date().toISOString(),
    warnings: [],
    degraded,
  };
}

/* Serves one configured calendar source.
 *
 * `sources` is a lookup rather than a list, because the id in the URL must
 * never be the URL: a route that accepted a calendar address as a query
 * parameter would turn the display server into an open proxy AND put the
 * credential in a browser's address bar, its history and the access log.
 * The browser names a source it is allowed to see; the server knows where
 * that points.
 */
export async function handleCalendarRequest(
  fetcher: CalendarFetcher,
  sources: ReadonlyMap<string, CalendarSource>,
  options: {
    readonly sourceId: string;
    /* The level the REQUEST is entitled to, decided by the route (/s/ is
     * shared, an authenticated session is private). Never taken from the
     * client: a shared viewer asking for 'private' must not receive it. */
    readonly level: 'private' | 'shared';
    readonly windowDays?: number;
    readonly limit?: number;
    readonly now?: Date;
  },
): Promise<CalendarRouteResult> {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  const source = sources.get(options.sourceId);
  /* A uniform 404 for both "no such source" and "not yours", so probing the
   * route cannot enumerate which calendars exist. */
  if (!source) {
    return {status: 404, body: {error: 'not found'}, headers};
  }

  /* The effective level is the STRICTER of the source's and the request's.
   * A private source reached through a share link is shaped as shared; a
   * shared source reached by an admin is still only shaped as shared, which
   * is the safe direction to be wrong in. */
  const level = options.level === 'shared' || source.level === 'shared' ? 'shared' : 'private';

  let payload: ShapedCalendar;
  try {
    payload = await fetcher.load({...source, level}, {
      windowDays: options.windowDays,
      limit: options.limit,
      now: options.now,
    });
  } catch {
    /* Never rethrow toward the client: an error object may carry the source
     * URL in its message, and an unhandled rejection in a route is how a
     * credential reaches a stack trace in a log. */
    return {status: 503, body: emptyCalendar(level, ['calendar']), headers};
  }

  /* THE LAST LINE OF DEFENCE. The shaping layer already guarantees this by
   * construction; auditing the serialised payload here costs microseconds and
   * converts any future regression from "a household's address is published"
   * into "the calendar block is empty and something is in the log". Given
   * what leaks, failing closed is the right trade. */
  if (level === 'shared') {
    const leaked = auditShared(payload, NEVER_SHARED_KEYS);
    if (leaked.length > 0) {
      return {
        status: 500,
        body: emptyCalendar('shared', ['calendar-blocked']),
        headers,
      };
    }
  }

  return {status: 200, body: payload, headers};
}

/* ===========================================================================
 * WIRING REQUIRED IN src/server/server.ts  (not edited here by design)
 * ===========================================================================
 *
 * 1. Imports, alongside the existing snapshot import:
 *
 *      import {CalendarFetcher, type CalendarSource} from './calendar.ts';
 *      import {handleCalendarRequest} from './calendar-route.ts';
 *
 * 2. In ServerOptions, two optional fields so the server still boots with no
 *    calendar configured (every integration is optional):
 *
 *      readonly calendarFetcher?: CalendarFetcher;
 *      readonly calendarSources?: ReadonlyMap<string, CalendarSource>;
 *
 * 3. Inside createCanvasServer, next to `const source = ...`:
 *
 *      const calendarFetcher = options.calendarFetcher
 *        ?? new CalendarFetcher({displayZone: config.timeZone});
 *      const calendarSources = options.calendarSources ?? new Map();
 *
 * 4. A route, placed with the other JSON routes and BEFORE the static
 *    handler. Note the level is derived from the PATH, never from a query
 *    parameter the client controls:
 *
 *      if (urlPath.startsWith('/__calendar/')) {
 *        const sourceId = decodeURIComponent(urlPath.slice('/__calendar/'.length));
 *        const result = await handleCalendarRequest(calendarFetcher, calendarSources, {
 *          sourceId,
 *          // Until share tokens land in Phase 4, every request is shared -
 *          // the safe default. When /s/<token> exists, that route passes
 *          // 'shared' and an authenticated admin route passes 'private'.
 *          level: 'shared',
 *        });
 *        res.statusCode = result.status;
 *        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
 *        return res.end(JSON.stringify(result.body));
 *      }
 *
 * 5. NOTHING in describeConfig or /healthz may print a source URL. If a
 *    calendar summary is wanted there, use `describeSource` from calendar.ts,
 *    which reports the provider host and a fingerprint and has no url key.
 *
 * Configuration is deliberately NOT added to config.ts here, since that file
 * is owned elsewhere this phase. When it is added, the shape that fits the
 * existing conventions is:
 *
 *      CANVAS_CALENDAR_SOURCES = id|Label|https://...ics , id2|Label2|https://...
 *
 * read with the existing `list()` helper, with the URL never echoed by
 * describeConfig. An unset value must leave calendarSources empty and the
 * server booting normally.
 * ======================================================================== */
