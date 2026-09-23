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
/* Household settings: a sidecar, never a canvas document.
 *
 * The Phase 3 measurement applies unchanged and is the reason this file
 * exists at all: `toShareable()` deliberately ROUND-TRIPS UNKNOWN METADATA so
 * a document written by a newer build survives an older one. Anything put on
 * the document therefore travels in a share export. Settings hold a provider
 * choice, a Home Assistant address and - decisively - THE HOUSEHOLD'S
 * COORDINATES, which are a home address in another form. So they live at
 * CANVAS_DATA_DIR/settings.json, where the document format cannot reach them
 * and an export cannot serialise them.
 *
 * NO SECRET IS IN THIS FILE. The Home Assistant URL is here because a LAN
 * name is not a credential; the token is in credentials.json, 0600, write
 * only. Splitting them means the settings file can be read, backed up and
 * pasted into a bug report without thinking about it.
 *
 * DEFAULTS ARE THE PRODUCT. An absent settings file must mean "every built-in
 * block on, no experiments, keyless weather" - not "nothing works until you
 * configure it". `DEFAULT_SETTINGS` is what an empty data directory means,
 * and the zero-config headline is a property of that constant.
 */

import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  DEFAULT_WEATHER_PROVIDER_ID,
  isWeatherProviderId,
  weatherProviderOrDefault,
  type Location,
  type Units,
} from '../providers/index.ts';
import {
  ALL_BLOCK_TYPES,
  blockDescriptor,
  EXPERIMENTAL_BLOCK_TYPES,
  isKnownBlockType,
} from './blocks.ts';
import {writeAtomic} from './store.ts';

export const SETTINGS_FILE = 'settings.json';

/** Non-credential, per-provider configuration. A URL and an entity id: local
 * names, not bearer tokens. Kept as a flat string map so a new provider
 * option needs no migration. */
export type ProviderOptions = {readonly [key: string]: string};

export type WeatherSettings = {
  readonly providerId: string;
  readonly units: Units;
  /** Keyed by provider id. */
  readonly options: {readonly [providerId: string]: ProviderOptions};
};

export type Settings = {
  readonly version: 1;
  /** Block type -> enabled. A type absent from the map is ENABLED, so a build
   * that adds a block type does not need every household's file rewritten -
   * except for experimental types, which are gated separately and off. */
  readonly blocks: {readonly [type: string]: boolean};
  /** The master switch for every experimental block. Off. */
  readonly experimentalEnabled: boolean;
  readonly weather: WeatherSettings;
  /** The household's place. Null until somebody types one. */
  readonly location: Location | null;
  /** An identifying contact for providers whose terms require one (met.no).
   * Empty means "use the project default", which is the privacy-preserving
   * choice and is why this is not mandatory. */
  readonly contact: string;
  readonly updatedAt: string;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  /* Every built-in on. A household that never wants a calendar says so once;
   * it does not have to switch five things on to get a screen. */
  blocks: Object.fromEntries(ALL_BLOCK_TYPES.map((type) => [
    type,
    !EXPERIMENTAL_BLOCK_TYPES.includes(type),
  ])),
  experimentalEnabled: false,
  weather: {
    providerId: DEFAULT_WEATHER_PROVIDER_ID,
    /* Celsius, because most of the world. Changed in one place on the
     * settings page, and the providers honour it. */
    units: 'metric',
    options: {},
  },
  location: null,
  contact: '',
  updatedAt: new Date(0).toISOString(),
};

/* --------------------------------------------------------------- parsing -- */

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/* A coordinate from outside the program. Out-of-range values are REFUSED
 * rather than clamped: a latitude of 200 is a bug in whatever produced it,
 * and clamping to 90 would put a household at the north pole and call it
 * configured. */
function coordinate(value: unknown, limit: number): number | null {
  const n = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

export function parseLocation(value: unknown): Location | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const latitude = coordinate(record.latitude, 90);
  const longitude = coordinate(record.longitude, 180);
  const name = text(record.name);
  if (latitude === null || longitude === null || name === '') return null;
  return {
    /* Capped, because this string is rendered as a block label on a wall and
     * a 4000-character "place name" is a layout attack. */
    name: name.slice(0, 120),
    latitude,
    longitude,
    ...(text(record.region) === '' ? {} : {region: text(record.region).slice(0, 120)}),
    ...(text(record.countryCode) === '' ? {} : {countryCode: text(record.countryCode).slice(0, 8)}),
    ...(text(record.timeZone) === '' ? {} : {timeZone: text(record.timeZone).slice(0, 64)}),
  };
}

function parseOptions(value: unknown): {readonly [providerId: string]: ProviderOptions} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ProviderOptions> = {};
  for (const [providerId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isWeatherProviderId(providerId)) continue;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const options: Record<string, string> = {};
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      /* Values only; a nested object here would be a shape the settings page
       * cannot render and a provider does not read. Capped for the same
       * reason as the place name. */
      if (typeof entry === 'string') options[key.slice(0, 64)] = entry.trim().slice(0, 512);
    }
    out[providerId] = options;
  }
  return out;
}

/** Parses whatever was on disk or came from a PUT into a complete Settings.
 * NEVER throws and never returns a partial: an unreadable field falls back to
 * its default, because a household with a hand-edited settings file should
 * get a working screen and a corrected file, not a dead one. */
export function parseSettings(value: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const record = (value === null || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : value) as Record<string, unknown>;

  const blocks: Record<string, boolean> = {...base.blocks};
  const rawBlocks = record.blocks;
  if (rawBlocks !== null && typeof rawBlocks === 'object' && !Array.isArray(rawBlocks)) {
    for (const [type, enabled] of Object.entries(rawBlocks as Record<string, unknown>)) {
      /* A type this build does not know about is dropped rather than stored:
       * otherwise a downgrade accumulates switches for blocks that no longer
       * exist and the settings page grows rows nobody can explain. */
      if (isKnownBlockType(type)) blocks[type] = bool(enabled, blocks[type] ?? true);
    }
  }

  const rawWeather = (record.weather === null || typeof record.weather !== 'object' || Array.isArray(record.weather)
    ? {}
    : record.weather) as Record<string, unknown>;

  const providerId = isWeatherProviderId(rawWeather.providerId)
    ? String(rawWeather.providerId)
    /* A provider this build removed falls back to the keyless default rather
     * than blanking the wall. Safe direction to be wrong in. */
    : base.weather.providerId;

  const units: Units = rawWeather.units === 'imperial' ? 'imperial'
    : rawWeather.units === 'metric' ? 'metric'
    : base.weather.units;

  const location = record.location === null
    ? null
    : record.location === undefined ? base.location : parseLocation(record.location);

  return {
    version: 1,
    blocks,
    experimentalEnabled: bool(record.experimentalEnabled, base.experimentalEnabled),
    weather: {
      providerId,
      units,
      options: rawWeather.options === undefined
        ? base.weather.options
        : parseOptions(rawWeather.options),
    },
    location,
    contact: record.contact === undefined ? base.contact : text(record.contact).slice(0, 200),
    updatedAt: base.updatedAt,
  };
}

/* ---------------------------------------------------------------- reading -- */

/** Whether a block type renders and appears in a picker.
 *
 * TWO GATES, AND BOTH MUST PASS for an experimental type: the master
 * experimental switch AND the type's own switch. A household that turns
 * experiments on does not thereby turn on every experiment ever shipped. */
export function blockEnabled(settings: Settings, type: string): boolean {
  const descriptor = blockDescriptor(type);
  if (descriptor === null) return false;
  if (descriptor.experimental && !settings.experimentalEnabled) return false;
  return settings.blocks[type] ?? !descriptor.experimental;
}

/** Exactly the types a picker may offer. The picker is not a separate list
 * with its own rules: it is this function, so a disabled type cannot be
 * absent from the wall and present in the menu. */
export function enabledBlockTypes(settings: Settings): readonly string[] {
  return ALL_BLOCK_TYPES.filter((type) => blockEnabled(settings, type));
}

/** The options the selected provider gets, with the household's own values
 * layered over nothing - there are no defaults to inherit, because a wrong
 * default URL is worse than an empty field. */
export function providerOptions(settings: Settings, providerId: string): ProviderOptions {
  return settings.weather.options[providerId] ?? {};
}

/** Settings as the SETTINGS PAGE and /healthz may see them. Identical to the
 * stored shape because nothing in it is secret - which is the property the
 * split between this file and credentials.json exists to create, and is
 * asserted in the tests rather than assumed. */
export function describeSettings(settings: Settings): Record<string, string> {
  const provider = weatherProviderOrDefault(settings.weather.providerId);
  return {
    weatherProvider: `${provider.label} (${provider.id})`,
    units: settings.weather.units,
    /* THE NAME, NEVER THE COORDINATES. This string goes to /healthz and the
     * startup banner, which are read out loud and pasted into bug reports. */
    location: settings.location === null ? '(not set)' : settings.location.name,
    experimental: settings.experimentalEnabled ? 'enabled' : 'off',
    blocks: enabledBlockTypes(settings).join(', ') || '(none enabled)',
  };
}

/* ------------------------------------------------------------------ store -- */

export type SettingsStoreOptions = {
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

export class SettingsStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  #ready: Promise<void> | null = null;
  #cache: Settings = DEFAULT_SETTINGS;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: SettingsStoreOptions = {}) {
    this.#dir = dataDir;
    this.#path = join(dataDir, SETTINGS_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  get path(): string {
    return this.#path;
  }

  async init(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    await mkdir(this.#dir, {recursive: true});
    let text_: string;
    try {
      text_ = await readFile(this.#path, 'utf8');
    } catch {
      /* Absent is the normal first-boot state and means the defaults. The
       * file is NOT written here: a read must not create one, or a read-only
       * data volume turns into a startup failure for no reason. */
      return;
    }
    try {
      this.#cache = parseSettings(JSON.parse(text_));
    } catch {
      this.#log('[canvas] ignoring an unreadable settings file; using defaults');
    }
  }

  /** SYNCHRONOUS, and deliberately so. The render path reads settings on
   * every request, and the same rule that keeps `dataFor()` synchronous
   * applies: a render that can await is a render that can do I/O. Call
   * `init()` once at startup; after that this is a plain field read. */
  get current(): Settings {
    return this.#cache;
  }

  async read(): Promise<Settings> {
    await this.init();
    return this.#cache;
  }

  /** Replaces the whole settings document, parsed and defaulted. */
  async write(value: unknown): Promise<Settings> {
    await this.init();
    return this.#serialise(async () => {
      const next: Settings = {
        ...parseSettings(value, this.#cache),
        updatedAt: this.#now().toISOString(),
      };
      await writeAtomic(this.#path, JSON.stringify(next, null, 2) + '\n');
      this.#cache = next;
      return next;
    });
  }

  /** A partial edit, merged over what is stored. The settings page posts one
   * section at a time, and a PUT that silently reset the other two would be
   * a data-loss bug that only shows up on a wall. */
  async patch(value: unknown): Promise<Settings> {
    await this.init();
    return this.#serialise(async () => {
      const next: Settings = {
        ...parseSettings(value, this.#cache),
        updatedAt: this.#now().toISOString(),
      };
      await writeAtomic(this.#path, JSON.stringify(next, null, 2) + '\n');
      this.#cache = next;
      return next;
    });
  }

  #serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
