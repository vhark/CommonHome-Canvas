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
/* The ambient snapshot: the only data the display process sends to a browser.
 *
 * SECURITY POSTURE (the reason this exists server-side at all):
 * A living-room screen is shared with the whole household and any visitor, so
 * neither the Home Assistant token nor the photo access key may be reachable
 * from the page. This module holds both, calls the APIs itself, and returns
 * ONLY the shaped fields the composition renders. No token, no entity ids, no
 * raw upstream payloads cross to the browser.
 *
 * The snapshot is read-only by construction: it issues GETs and exposes no way
 * to call a service, so a compromised display cannot actuate anything.
 *
 * GRACEFUL DEGRADATION is the other load-bearing property. Each source fails
 * independently: one dead provider records itself in `degraded` and the rest
 * of the screen still renders. A household screen that blanks because a
 * weather API timed out is worse than one that quietly drops the temperature.
 */

import type {CanvasConfig} from './config.ts';

export type Photo = {
  url: string;
  color: string | null;
  blurHash: string | null;
  photographer: string;
  photographerUrl: string;
  source: string;
  sourceUrl: string;
};

export type Weather = {
  state: string;
  temperature: number | null;
  unit: string;
  attribution: string;
};

export type CalendarEvent = {
  summary: string;
  start: string;
  allDay: boolean;
};

export type Snapshot = {
  weather: Weather | null;
  events: CalendarEvent[];
  peopleHome: string[];
  photo: Photo | null;
  generatedAt: string;
  degraded: string[];
};

/* Injectable so tests can exercise degradation without a network. Defaults to
 * the platform fetch; nothing in this module reaches for a dependency. */
export type FetchLike = (
  input: string,
  init?: {headers?: Record<string, string>; signal?: AbortSignal},
) => Promise<{ok: boolean; status: number; json(): Promise<unknown>}>;

const HA_TIMEOUT_MS = 8000;
const PHOTO_TIMEOUT_MS = 10000;

/* Photo rotation is cached for hours, not fetched per snapshot.
 *
 * The free photo tier allows 50 requests an hour and the snapshot endpoint is
 * polled every two minutes; fetching a photo each time would exhaust the quota
 * in about ninety minutes. A wall photo that changes a few times a day is also
 * simply calmer than one that changes while someone is looking at it.
 * Re-serving the same image URL costs no API request. */
const PHOTO_TTL_MS = 3 * 60 * 60 * 1000;

/* Per-instance rather than module-global so tests are order-independent and a
 * second server in the same process does not inherit another's cache. */
export class SnapshotSource {
  readonly #config: CanvasConfig;
  readonly #fetch: FetchLike;
  #photoCache: {photo: Photo; at: number} | null = null;

  constructor(config: CanvasConfig, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async #ha(path: string): Promise<any> {
    const ha = this.#config.homeAssistant;
    if (!ha) throw new Error('home assistant not configured');
    const res = await this.#fetch(`${ha.url}/api/${path}`, {
      headers: {Authorization: `Bearer ${ha.token}`, 'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(HA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HA ${path} -> ${res.status}`);
    return res.json();
  }

  async #photo(): Promise<Photo | null> {
    const photos = this.#config.photos;
    if (!photos) return null;
    const cached = this.#photoCache;
    if (cached && Date.now() - cached.at < PHOTO_TTL_MS) return cached.photo;

    const url = 'https://api.unsplash.com/photos/random'
      + `?topics=${encodeURIComponent(photos.topicId)}`
      /* content_filter=high is requested because this screen hangs in a room
       * with children. */
      + '&orientation=landscape&content_filter=high';
    const res = await this.#fetch(url, {
      headers: {Authorization: `Client-ID ${photos.accessKey}`},
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`photos -> ${res.status}`);
    const d = (await res.json()) as any;

    /* The provider's API guidelines REQUIRE triggering the download endpoint
     * each time a photo is used as a background. It is not a download - it is
     * how photographers are credited with a use. Fire-and-forget so a slow
     * response never delays the screen, but never skipped. */
    const dl = d?.links?.download_location;
    if (dl) {
      void Promise.resolve(
        this.#fetch(String(dl), {
          headers: {Authorization: `Client-ID ${photos.accessKey}`},
          signal: AbortSignal.timeout(HA_TIMEOUT_MS),
        }),
      ).catch(() => { /* credit ping is best-effort; the display must not block */ });
    }

    /* Sized server-side via the provider's imgix parameters. The ixid in
     * urls.raw is preserved, as the guidelines require. */
    const sized = `${String(d?.urls?.raw ?? '')}&w=1920&h=1080&fit=crop&crop=entropy&auto=format&q=80`;
    const utm = `?utm_source=${encodeURIComponent(photos.appName)}&utm_medium=referral`;

    const photo: Photo = {
      url: sized,
      color: d?.color ?? null,
      blurHash: d?.blur_hash ?? null,
      photographer: String(d?.user?.name ?? 'Unknown'),
      photographerUrl: `${d?.user?.links?.html ?? 'https://unsplash.com'}${utm}`,
      source: 'Unsplash',
      sourceUrl: `https://unsplash.com/${utm}`,
    };
    this.#photoCache = {photo, at: Date.now()};
    return photo;
  }

  async snapshot(): Promise<Snapshot> {
    const degraded: string[] = [];
    const ha = this.#config.homeAssistant;

    /* An unset entity is not a failure - it means this household did not
     * configure weather. Skipping explicitly avoids a pointless request and a
     * degraded-source entry that would read as a broken integration. */
    let weather: Weather | null = null;
    if (ha?.weatherEntity) {
      try {
        const s = (await this.#ha(`states/${ha.weatherEntity}`)) as any;
        weather = {
          state: String(s?.state ?? 'unknown'),
          temperature: typeof s?.attributes?.temperature === 'number'
            ? s.attributes.temperature : null,
          unit: String(s?.attributes?.temperature_unit ?? ''),
          attribution: String(s?.attributes?.attribution ?? ''),
        };
      } catch {
        degraded.push('weather');
      }
    }

    let events: CalendarEvent[] = [];
    if (ha?.calendarEntity) {
      try {
        const now = new Date();
        const end = new Date(now.getTime() + 36 * 3600 * 1000);
        const raw = await this.#ha(
          `calendars/${ha.calendarEntity}?start=${now.toISOString()}&end=${end.toISOString()}`,
        );
        events = (Array.isArray(raw) ? raw : [])
          .slice(0, 8)
          .map((e: any): CalendarEvent => ({
            /* Only these three fields leave the server. Descriptions and
             * locations are household-private and have no business on a wall
             * display that visitors can read. */
            summary: String(e?.summary ?? 'Busy').slice(0, 120),
            start: String(e?.start?.dateTime ?? e?.start?.date ?? ''),
            allDay: Boolean(e?.start?.date && !e?.start?.dateTime),
          }))
          .filter((e) => e.start);
      } catch {
        degraded.push('calendar');
      }
    }

    const peopleHome: string[] = [];
    for (const id of ha?.personEntities ?? []) {
      try {
        const s = (await this.#ha(`states/${id}`)) as any;
        if (s?.state === 'home') {
          peopleHome.push(String(s?.attributes?.friendly_name ?? id.split('.')[1] ?? id));
        }
      } catch {
        if (!degraded.includes('presence')) degraded.push('presence');
      }
    }

    let photo: Photo | null = null;
    try {
      photo = await this.#photo();
    } catch {
      /* A missing photo is a visual downgrade, not an outage: the composition
       * falls back to the flat canvas colour and everything else renders. */
      degraded.push('photo');
      photo = this.#photoCache?.photo ?? null;
    }

    return {
      weather,
      events,
      peopleHome,
      photo,
      generatedAt: new Date().toISOString(),
      degraded,
    };
  }
}

/* The shape returned on total failure. Preserved so a client keeps rendering
 * its last known good snapshot instead of blanking on a parse error. */
export function emptySnapshot(degraded: string[] = ['all']): Snapshot {
  return {
    weather: null,
    events: [],
    peopleHome: [],
    photo: null,
    generatedAt: new Date().toISOString(),
    degraded,
  };
}
