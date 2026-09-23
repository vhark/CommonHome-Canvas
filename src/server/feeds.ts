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
/* ONE REFRESH LOOP PER SOURCE, SHARED BY EVERY RENDER.
 *
 * THIS MODULE EXISTS TO PREVENT ONE SPECIFIC BUG. The renderer takes a
 * `Feed<T>` per source; the naive way to fill it is to fetch on the render
 * path. Six screens polling `/d/<token>/view` every sixty seconds would then
 * hit Home Assistant and the photo provider SIX TIMES A MINUTE, FOREVER - a
 * rate-limit ban for the household, and a renderer that is no longer pure,
 * which is the property the single-renderer proof rests on.
 *
 * So fetching is driven by a TIMER, never by a request. `dataFor()` is
 * synchronous, returns whatever the last refresh produced, and cannot await
 * anything. The number of provider requests is a function of wall-clock time
 * and the configured intervals alone; it does not move when a seventh screen
 * is hung in the hallway.
 *
 * NOTHING IS FETCHED HERE. `SnapshotSource` already does weather and
 * photography with timeouts and last-known-good; `CalendarFetcher` already
 * does ICS with conditional requests and last-known-good. This module owns the
 * SCHEDULE and the SHAPE, and calls those two.
 *
 * SHARE LEVEL IS DECIDED AT THE SOURCE, NOT AT THE RENDER. Every calendar is
 * shaped TWICE on each refresh - once private, once shared - and the route
 * picks which set it is handed. Re-shaping per request would mean the raw
 * events were in reach of the shared path, which is exactly the leak the field
 * rules exist to prevent. Shaping twice costs one extra pass over an already
 * parsed calendar and no extra network request at all: the second `load()`
 * lands inside the fetcher's own cache window.
 *
 * ON DEGRADATION, AND ONE DELIBERATE READING OF THE RULE. `Feed<T>` has two
 * states - a value, or a reason - and no third "a value, but stale" state. So
 * a source that fails AFTER a success keeps serving its last good value (a
 * wall showing a twenty-minute-old temperature is right; a dimmed rectangle
 * where the temperature was is not), and the failure is recorded in
 * `describeFeeds()` for the startup banner and /healthz rather than on the
 * wall. A source that has NEVER succeeded - including at cold start, before
 * the first refresh completes - is `{ok: false}` with a plain reason, so the
 * block renders dimmed and says so instead of erroring the page.
 */

import {
  attributionFrom,
  degraded,
  ready,
  DEFAULT_SOURCE_ID,
  type CalendarFeed,
  type Feed,
  type PhotoImage,
  type RenderData,
  type WeatherReading,
} from '../render/data.ts';
import type {ShareLevel} from '../calendar/shape.ts';
import {CalendarFetcher, type CalendarSource} from './calendar.ts';
import type {CanvasConfig} from './config.ts';
import {SnapshotSource, type Snapshot} from './snapshot.ts';
import type {WeatherResult} from './weather-source.ts';

/** What a render is handed: the private set and the shared set, already
 * shaped. Held as two finished values so a request only ever SELECTS. */
export type FeedData = {
  readonly private: RenderData;
  readonly shared: RenderData;
};

const EMPTY: FeedData = {private: {}, shared: {}};

/* Weather is fetched in minutes; the photograph is fetched in hours.
 *
 * Both come from `SnapshotSource.snapshot()`, which is called on the WEATHER
 * cadence - but SnapshotSource holds its own multi-hour photo cache and
 * re-serves the same image URL without an API request, so the photo provider
 * sees hours between hits while the temperature stays current. That is why
 * there is one snapshot timer rather than two: the split already exists, one
 * layer down, and duplicating it here would mean two places to get it wrong.
 *
 * Five minutes rather than one: a household weather entity does not change
 * usefully inside five minutes, and a wall display is read at a glance. */
export const WEATHER_REFRESH_MS = 5 * 60 * 1000;

/** Floor on any configured interval. The same reasoning as the calendar
 * refresh floor in config.ts: a fast poll against someone else's service is
 * how a household gets blocked, so it is enforced and not suggested. */
export const MIN_REFRESH_MS = 60 * 1000;

/** Cold start, and every state before a first success. Said in words a
 * household can act on, and carrying no provider text - an upstream error
 * string can contain a URL, and a calendar URL is a bearer credential. */
export const COLD_REASON = 'Waiting for the first update';

/** After a failure with nothing good to fall back on. */
export const FAILED_REASON = 'This source could not be reached';

type SourceState = {
  /** Kind, for the health description only. */
  readonly kind: 'snapshot' | 'calendar' | 'weather';
  readonly label: string;
  readonly intervalMs: number;
  /** Refreshes attempted since start. */
  fetches: number;
  /** null until the first success. */
  lastGoodAt: number | null;
  lastError: string | null;
};

/** A weather provider, already wired to settings and credentials. Injectable
 * so a test drives it without a network, and OPTIONAL so every caller built
 * before this existed keeps the behaviour it had.
 *
 * `outlook()` is the experimental Block's text, fetched on the SAME refresh
 * tick as the reading rather than on its own loop: they come from one
 * provider, and two loops against one service is exactly how a household
 * doubles its request count for no benefit. Optional, because a reader that
 * cannot produce one is the normal case. */
export type WeatherReader = {
  read(): Promise<WeatherResult>;
  outlook?(): Promise<string>;
};

export type FeedCacheOptions = {
  readonly config: CanvasConfig;
  /* Injectable so a test can count fetches and fail on demand without a
   * network. Defaults to the real ones, which is what the server uses. */
  readonly snapshotSource?: {snapshot(): Promise<Snapshot>};
  /* THE CHANGE THIS PHASE IS ABOUT.
   *
   * When a weather reader is supplied it OWNS the `default` weather feed -
   * unconditionally, with no reference to `config.homeAssistant`. That single
   * line is what turns a Home Assistant token from a prerequisite for a
   * temperature into one option among three, because the keyless provider is
   * the default and needs nothing configured at all.
   *
   * It takes precedence over the snapshot's weather when both exist: the
   * snapshot path remains, unmodified, for photography and for the callers
   * that predate the registry. */
  readonly weatherSource?: WeatherReader;
  readonly calendarFetcher?: CalendarFetcher;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
};

export class FeedCache {
  readonly #config: CanvasConfig;
  readonly #snapshot: {snapshot(): Promise<Snapshot>} | null;
  readonly #weather: WeatherReader | null;
  readonly #calendars: CalendarFetcher | null;
  readonly #sources: readonly CalendarSource[];
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #state = new Map<string, SourceState>();
  readonly #timers: NodeJS.Timeout[] = [];

  /* THE ONE MUTABLE FIELD, and it is replaced wholesale rather than edited.
   *
   * A refresh builds a complete new FeedData and assigns it in a single
   * statement, so a render that reads it concurrently sees either the whole
   * previous set or the whole next one - never a half-updated table where the
   * weather is new and the photograph is not. Node is single-threaded, so this
   * is a readability property rather than a memory-model one, but it is the
   * reason `dataFor` can be trusted to be a plain read. */
  #data: FeedData = EMPTY;
  #started = false;
  /* Filled by the weather refresh when the reader offers an outlook, read
   * synchronously by the render path exactly like `#data`. Not part of
   * `RenderData`, because `src/render/**` is not modified by this phase and
   * an experiment must not widen the renderer's contract. */
  #experimental: {readonly [kind: string]: string} = {};

  constructor(options: FeedCacheOptions) {
    const {config} = options;
    this.#config = config;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
    this.#sources = config.calendars.map((c) => c as CalendarSource);

    /* An integration nobody configured gets NO feed entry at all, which is
     * different from an entry that failed. With no entry the block falls back
     * to whatever the document itself carries - an authored temperature, a
     * pasted photo URL - and a household with no integrations still gets a
     * complete canvas. That is the property the whole product is sold on. */
    const wantsSnapshot =
      options.snapshotSource !== undefined
      || Boolean(config.homeAssistant?.weatherEntity)
      || config.photos !== null;
    this.#snapshot = wantsSnapshot
      ? (options.snapshotSource ?? new SnapshotSource(config))
      : null;

    /* THE INVERSION, IN ONE ASSIGNMENT. A weather reader exists because the
     * server built one; it does not exist because somebody set an entity id.
     * Everything else in this constructor is unchanged. */
    this.#weather = options.weatherSource ?? null;

    this.#calendars = this.#sources.length === 0
      ? null
      : (options.calendarFetcher ?? new CalendarFetcher({displayZone: config.timeZone}));

    if (this.#weather !== null) {
      this.#state.set('weather', {
        kind: 'weather',
        label: 'weather',
        intervalMs: WEATHER_REFRESH_MS,
        fetches: 0,
        lastGoodAt: null,
        lastError: null,
      });
    }
    if (this.#snapshot !== null) {
      this.#state.set('snapshot', {
        kind: 'snapshot',
        /* Named for what it still owns. When a weather reader is present the
         * snapshot's weather is not used, and claiming otherwise in the
         * startup banner would send an operator to the wrong integration. */
        label: this.#weather === null ? 'weather and photography' : 'photography',
        intervalMs: WEATHER_REFRESH_MS,
        fetches: 0,
        lastGoodAt: null,
        lastError: null,
      });
    }
    for (const source of this.#sources) {
      this.#state.set(`calendar:${source.id}`, {
        kind: 'calendar',
        label: source.label,
        intervalMs: Math.max(MIN_REFRESH_MS, source.refreshMs ?? 900_000),
        fetches: 0,
        lastGoodAt: null,
        lastError: null,
      });
    }

    /* Cold start is a FIRST-CLASS STATE, populated in the constructor so it is
     * true from the instant the server can answer a request - not a window
     * between construction and the first refresh during which `dataFor`
     * returns an empty bag and the blocks say "no source configured", which
     * would be a different and false statement. */
    this.#data = this.#cold();
  }

  /* --------------------------------------------------------- the schedule -- */

  /** Kicks one refresh per source immediately and then on its own interval.
   * Idempotent: calling it twice does not double the timers, because a second
   * set of timers is exactly how a household ends up rate limited by its own
   * server restarting a route. */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    if (this.#weather !== null) {
      void this.#refreshWeather();
      this.#timers.push(this.#every(WEATHER_REFRESH_MS, () => this.#refreshWeather()));
    }
    if (this.#snapshot !== null) {
      void this.#refreshSnapshot();
      this.#timers.push(this.#every(WEATHER_REFRESH_MS, () => this.#refreshSnapshot()));
    }
    for (const source of this.#sources) {
      void this.#refreshCalendar(source);
      const interval = Math.max(MIN_REFRESH_MS, source.refreshMs ?? 900_000);
      this.#timers.push(this.#every(interval, () => this.#refreshCalendar(source)));
    }
  }

  /** Stops every timer. Called on shutdown, and by tests, so a refresh loop
   * cannot outlive the server that owns it. */
  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#started = false;
  }

  /** One full pass over every source, awaited. Used at startup when a first
   * paint should not be cold, and by tests that need determinism instead of a
   * timer. Does NOT start the loops - `start()` does that. */
  async refreshNow(): Promise<void> {
    const work: Promise<void>[] = [];
    if (this.#weather !== null) work.push(this.#refreshWeather());
    if (this.#snapshot !== null) work.push(this.#refreshSnapshot());
    for (const source of this.#sources) work.push(this.#refreshCalendar(source));
    await Promise.all(work);
  }

  #every(ms: number, run: () => Promise<void>): NodeJS.Timeout {
    const timer = setInterval(() => {
      void run();
    }, ms);
    /* unref so a refresh loop never holds the process open. A container that
     * will not exit on SIGTERM because a fifteen-minute timer is pending gets
     * SIGKILLed, which reads as a crash in every orchestrator's logs. */
    timer.unref?.();
    return timer;
  }

  /* ------------------------------------------------------------ the reads -- */

  /** THE RENDER PATH. Synchronous, allocation-light, and incapable of I/O:
   * there is no await in this function and nothing it calls can fetch. */
  dataFor(shareLevel: ShareLevel): RenderData {
    return shareLevel === 'shared' ? this.#data.shared : this.#data.private;
  }

  /** Both sets, for a caller that wants to inspect rather than render. */
  get data(): FeedData {
    return this.#data;
  }

  /** Text for experimental Blocks, keyed by experiment kind. Synchronous, a
   * plain read, and empty until a refresh produces something - the same
   * contract as `dataFor`. */
  get experimentalText(): {readonly [kind: string]: string} {
    return this.#experimental;
  }

  /** What is configured and how it is doing, WITHOUT a single credential: no
   * URL, no token, no entity id, no upstream message. Shaped for the startup
   * banner and /healthz, which are read by whoever is debugging a dark
   * screen. */
  describeFeeds(): Record<string, string> {
    if (this.#state.size === 0) return {feeds: '(none configured)'};
    const out: Record<string, string> = {};
    for (const [key, state] of this.#state) {
      const age = state.lastGoodAt === null
        ? 'never succeeded'
        : `last good ${Math.round((this.#now() - state.lastGoodAt) / 1000)}s ago`;
      out[key] = `${state.label}: every ${Math.round(state.intervalMs / 1000)}s, `
        + `${state.fetches} refresh(es), ${age}`
        + (state.lastError === null ? '' : `, last problem: ${state.lastError}`);
    }
    return out;
  }

  /** Refreshes performed per source since start. The fetch-count proof reads
   * this, so that the assertion is about the thing that actually talks to a
   * provider rather than about a mock's bookkeeping. */
  fetchCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, state] of this.#state) out[key] = state.fetches;
    return out;
  }

  /* ---------------------------------------------------------- the refresh -- */

  #cold(): FeedData {
    const weather: Record<string, Feed<WeatherReading>> = {};
    const photos: Record<string, Feed<PhotoImage>> = {};
    const calendars: Record<string, Feed<CalendarFeed>> = {};

    if (this.#weather !== null) weather[DEFAULT_SOURCE_ID] = degraded(COLD_REASON);
    if (this.#snapshot !== null) {
      if (this.#weather === null && this.#config.homeAssistant?.weatherEntity) {
        weather[DEFAULT_SOURCE_ID] = degraded(COLD_REASON);
      }
      if (this.#config.photos !== null) photos[DEFAULT_SOURCE_ID] = degraded(COLD_REASON);
    }
    for (const source of this.#sources) calendars[source.id] = degraded(COLD_REASON);
    if (this.#sources.length > 0) calendars[DEFAULT_SOURCE_ID] = degraded(COLD_REASON);

    const table: RenderData = {weather, photos, calendars};
    /* Identical at both levels: there is nothing in a reason string that could
     * differ between a household and a visitor. */
    return {private: table, shared: table};
  }

  /* A refresh REPLACES the two tables rather than mutating them, and every
   * entry it does not know about is carried across unchanged - so a calendar
   * refresh cannot blank the weather and a weather refresh cannot blank a
   * calendar. Per-source independence, expressed as data flow. */
  #commit(mutate: (next: {
    weather: Record<string, Feed<WeatherReading>>;
    photos: Record<string, Feed<PhotoImage>>;
    privateCalendars: Record<string, Feed<CalendarFeed>>;
    sharedCalendars: Record<string, Feed<CalendarFeed>>;
  }) => void): void {
    const next = {
      weather: {...this.#data.private.weather},
      photos: {...this.#data.private.photos},
      privateCalendars: {...this.#data.private.calendars},
      sharedCalendars: {...this.#data.shared.calendars},
    };
    mutate(next);
    this.#data = {
      private: {
        weather: next.weather,
        photos: next.photos,
        calendars: next.privateCalendars,
      },
      /* Weather and photography carry no per-viewer detail - a temperature and
       * a stock photograph are the same fact for a household and for a visitor
       * - so the SAME objects are shared between the two tables. Only the
       * calendars differ, and they differ because they were shaped
       * differently, not because they are filtered later. */
      shared: {
        weather: next.weather,
        photos: next.photos,
        calendars: next.sharedCalendars,
      },
    };
  }

  /* THE PROVIDER-REGISTRY REFRESH. One reading, from whichever provider the
   * household selected, with no reference to any integration's configuration.
   *
   * The error is caught and REPLACED, never inspected: `WeatherSource`
   * already narrows every failure to a household-safe `ProviderError`, and
   * even that message is not stored here - `describeFeeds()` output reaches
   * the startup banner and /healthz, and the discipline in this module has
   * always been that a feed's health description carries no provider text at
   * all. The error's CODE is enough to tell an operator which of "nothing is
   * configured", "the credential was refused" and "the network is down" they
   * are looking at. */
  async #refreshWeather(): Promise<void> {
    const source = this.#weather;
    const state = this.#state.get('weather');
    if (source === null || state === undefined) return;
    state.fetches += 1;

    let result: WeatherResult;
    try {
      result = await source.read();
    } catch (cause) {
      const code = (cause as {code?: unknown})?.code;
      state.lastError = typeof code === 'string' ? code : 'unreachable';
      this.#commit((next) => {
        next.weather[DEFAULT_SOURCE_ID] = this.#hold(next.weather[DEFAULT_SOURCE_ID]);
      });
      this.#log('[canvas] a weather refresh failed; serving the last known good value');
      return;
    }

    this.#commit((next) => {
      /* Mapped straight into the existing WeatherReading - which is the whole
       * claim of the provider registry: src/render/** is untouched. */
      next.weather[DEFAULT_SOURCE_ID] = ready<WeatherReading>(result.reading);
    });
    state.lastGoodAt = this.#now();
    state.lastError = null;

    /* The outlook rides the SAME tick. A failure here is not a weather
     * failure: the temperature is already committed above, and an experiment
     * that could not load must never downgrade the Block that works. */
    if (source.outlook !== undefined) {
      try {
        this.#experimental = {...this.#experimental, forecast: await source.outlook()};
      } catch {
        /* Left as whatever it was; the Block says it has no data yet. */
      }
    }
  }

  async #refreshSnapshot(): Promise<void> {
    const source = this.#snapshot;
    const state = this.#state.get('snapshot');
    if (source === null || state === undefined) return;
    state.fetches += 1;

    /* When a weather reader owns the weather feed, the snapshot must not
     * write to it at all - not even to hold a last-known-good value - or a
     * Home Assistant outage would downgrade a feed that Open-Meteo is
     * currently serving perfectly well. */
    const ownsWeather = this.#weather === null && Boolean(this.#config.homeAssistant?.weatherEntity);

    let snap: Snapshot;
    try {
      snap = await source.snapshot();
    } catch {
      /* The error object is not inspected, let alone logged: Node puts a URL
       * into the message of most network errors and the photo request carries
       * an access key in a header that some clients echo back. */
      state.lastError = 'unreachable';
      this.#keepOrFail(ownsWeather ? ['weather', 'photo'] : ['photo']);
      return;
    }

    const failed = new Set(snap.degraded);
    this.#commit((next) => {
      if (ownsWeather) {
        if (snap.weather !== null && !failed.has('weather')) {
          next.weather[DEFAULT_SOURCE_ID] = ready<WeatherReading>({
            state: snap.weather.state,
            temperature: snap.weather.temperature,
            unit: snap.weather.unit,
            /* The provider's attribution sentence, shortened to the
             * institution actually being credited. Rule 2 in blocks.ts: a
             * number on a wall says where it came from. */
            attribution: attributionFrom(snap.weather.attribution),
          });
        } else {
          next.weather[DEFAULT_SOURCE_ID] = this.#hold(next.weather[DEFAULT_SOURCE_ID]);
        }
      }
      if (this.#config.photos !== null) {
        if (snap.photo !== null && !failed.has('photo')) {
          next.photos[DEFAULT_SOURCE_ID] = ready<PhotoImage>({
            url: snap.photo.url,
            /* An empty alt is CORRECT for a decorative ambient photograph: a
             * screen reader announcing a stock landscape on every poll is
             * noise, and there is no household-authored description here. */
            alt: '',
            color: snap.photo.color,
            attribution: attributionFrom({
              source: snap.photo.source,
              author: snap.photo.photographer,
              sourceUrl: snap.photo.sourceUrl,
              authorUrl: snap.photo.photographerUrl,
            }),
          });
        } else {
          next.photos[DEFAULT_SOURCE_ID] = this.#hold(next.photos[DEFAULT_SOURCE_ID]);
        }
      }
    });

    const anyGood =
      (ownsWeather && snap.weather !== null && !failed.has('weather'))
      || (snap.photo !== null && !failed.has('photo'));
    if (anyGood) {
      state.lastGoodAt = this.#now();
      state.lastError = failed.size === 0 ? null : [...failed].join(', ');
    } else if (failed.size > 0) {
      state.lastError = [...failed].join(', ');
    }
  }

  async #refreshCalendar(source: CalendarSource): Promise<void> {
    const fetcher = this.#calendars;
    const state = this.#state.get(`calendar:${source.id}`);
    if (fetcher === null || state === undefined) return;
    state.fetches += 1;

    /* SHAPED TWICE, AT THE SOURCE. The private shaping is only actually
     * private when the household declared the source private: a source marked
     * shared is shaped shared for BOTH tables, which is the same
     * stricter-of-the-two rule handleCalendarRequest applies, written once
     * more where the values are built. */
    const privateLevel: ShareLevel = source.level === 'shared' ? 'shared' : 'private';

    let privateShaped;
    let sharedShaped;
    try {
      privateShaped = await fetcher.load({...source, level: privateLevel});
      /* The second load is a CACHE READ, not a second request: the fetcher
       * serves a body younger than the source's own refresh window without
       * asking the provider. Two shapings, one network hit. */
      sharedShaped = await fetcher.load({...source, level: 'shared'});
    } catch {
      state.lastError = 'unreachable';
      this.#keepOrFail([], [source.id]);
      return;
    }

    const empty = privateShaped.events.length === 0 && privateShaped.degraded.length > 0;
    if (empty) {
      /* A shaped calendar with no events AND a degraded marker is a failed
       * fetch that the fetcher already turned into an empty shape. Treat it as
       * a failure so last-known-good survives, rather than overwriting a good
       * day's events with an empty list. */
      state.lastError = privateShaped.degraded.join(', ');
      this.#keepOrFail([], [source.id]);
      return;
    }

    const isFirst = this.#sources[0]?.id === source.id;
    this.#commit((next) => {
      const priv = ready<CalendarFeed>({
        name: privateShaped.name,
        events: privateShaped.events,
        level: privateShaped.level,
      });
      const shared = ready<CalendarFeed>({
        name: sharedShaped.name,
        events: sharedShaped.events,
        level: sharedShaped.level,
      });
      next.privateCalendars[source.id] = priv;
      next.sharedCalendars[source.id] = shared;
      /* The first configured calendar also answers to `default`, so a
       * portable document that names no source still renders on a household
       * that has one. A document never names a URL or an entity id; `default`
       * is the most portable reference there is. */
      if (isFirst) {
        next.privateCalendars[DEFAULT_SOURCE_ID] = priv;
        next.sharedCalendars[DEFAULT_SOURCE_ID] = shared;
      }
    });

    state.lastGoodAt = this.#now();
    state.lastError = privateShaped.degraded.length === 0 ? null : privateShaped.degraded.join(', ');
  }

  /* LAST-KNOWN-GOOD, OR A REASON. A feed that has a value keeps it; a feed
   * that never had one says so. This is the only place a feed is allowed to
   * change from ok to not-ok, and it cannot: `#hold` only downgrades a feed
   * that was already degraded. */
  #hold<T>(current: Feed<T> | undefined): Feed<T> {
    if (current !== undefined && current.ok) return current;
    return degraded<T>(FAILED_REASON);
  }

  #keepOrFail(kinds: readonly string[], calendarIds: readonly string[] = []): void {
    this.#commit((next) => {
      if (kinds.includes('weather')
        && this.#weather === null
        && this.#config.homeAssistant?.weatherEntity) {
        next.weather[DEFAULT_SOURCE_ID] = this.#hold(next.weather[DEFAULT_SOURCE_ID]);
      }
      if (kinds.includes('photo') && this.#config.photos !== null) {
        next.photos[DEFAULT_SOURCE_ID] = this.#hold(next.photos[DEFAULT_SOURCE_ID]);
      }
      for (const id of calendarIds) {
        next.privateCalendars[id] = this.#hold(next.privateCalendars[id]);
        next.sharedCalendars[id] = this.#hold(next.sharedCalendars[id]);
        if (this.#sources[0]?.id === id) {
          next.privateCalendars[DEFAULT_SOURCE_ID] = this.#hold(next.privateCalendars[DEFAULT_SOURCE_ID]);
          next.sharedCalendars[DEFAULT_SOURCE_ID] = this.#hold(next.sharedCalendars[DEFAULT_SOURCE_ID]);
        }
      }
    });
    this.#log('[canvas] a feed refresh failed; serving the last known good value');
  }
}
