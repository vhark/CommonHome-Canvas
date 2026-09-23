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
/* THE SEAM: settings + credentials + registry -> one WeatherReading.
 *
 * This is the only place in the server that assembles a `WeatherRequest`, and
 * it is where the two rules that matter most are enforced in one place rather
 * than at every call site.
 *
 * RULE 1: A PROVIDER IS ONLY EVER HANDED ITS OWN CREDENTIAL. The credential
 * id comes from the provider's own declaration, so selecting Open-Meteo
 * cannot hand it a Home Assistant token, and an unused integration's secret
 * is never read at all.
 *
 * RULE 2: A FAILURE IS A SENTENCE, NEVER A CAUSE OBJECT. `ProviderError`
 * messages are written for a household and contain no credential, no URL and
 * no upstream body. Anything that is not a ProviderError is replaced
 * wholesale, because an arbitrary thrown value is exactly where a URL gets
 * into a string.
 *
 * ENVIRONMENT CONFIGURATION STILL WORKS, AND STILL WINS. When the settings
 * file names no Home Assistant address, the one from `CanvasConfig` is used -
 * so a container configured entirely by environment variables behaves as it
 * did before this phase, without anyone visiting a settings page.
 */

import type {WeatherReading} from '../render/data.ts';
import {
  HOME_ASSISTANT_CREDENTIAL,
  HOME_ASSISTANT_ENTITY_OPTION,
  HOME_ASSISTANT_ID,
  HOME_ASSISTANT_URL_OPTION,
  ProviderError,
  weatherProviderOrDefault,
  type ForecastDay,
  type ProviderFetch,
  type WeatherProvider,
  type WeatherRequest,
} from '../providers/index.ts';
import type {CanvasConfig} from './config.ts';
import type {CredentialStore} from './credentials.ts';
import {providerOptions, type Settings} from './settings.ts';

/* Long enough for a home connection behind a slow uplink, short enough that a
 * refresh cannot pile up behind a hung provider: the interval is five
 * minutes, so a ten-second ceiling can never overlap the next tick. */
export const WEATHER_TIMEOUT_MS = 10_000;

export type WeatherSourceOptions = {
  readonly config: CanvasConfig;
  readonly settings: {readonly current: Settings};
  readonly credentials: CredentialStore;
  readonly fetch?: ProviderFetch;
  readonly timeoutMs?: number;
};

/** A reading plus which provider produced it - the test endpoint reports the
 * provider by name, because "Connected" from an unnamed source proves less
 * than "Connected — 14 °C in Boulder, from Open-Meteo". */
export type WeatherResult = {
  readonly provider: WeatherProvider;
  readonly reading: WeatherReading;
};

export class WeatherSource {
  readonly #config: CanvasConfig;
  readonly #settings: {readonly current: Settings};
  readonly #credentials: CredentialStore;
  readonly #fetch: ProviderFetch;
  readonly #timeoutMs: number;

  constructor(options: WeatherSourceOptions) {
    this.#config = options.config;
    this.#settings = options.settings;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as ProviderFetch);
    this.#timeoutMs = options.timeoutMs ?? WEATHER_TIMEOUT_MS;
  }

  /** The provider the household selected, or the keyless default. */
  provider(): WeatherProvider {
    return weatherProviderOrDefault(this.#settings.current.weather.providerId);
  }

  /* Builds the request for one provider. Note what is NOT here: process.env,
   * a file read, or any credential other than the one this provider declares. */
  async #request(provider: WeatherProvider): Promise<WeatherRequest> {
    const settings = this.#settings.current;
    const options: Record<string, string> = {...providerOptions(settings, provider.id)};

    if (provider.id === HOME_ASSISTANT_ID) {
      /* The environment's Home Assistant configuration is the fallback, so a
       * container that has always been configured by env keeps working with
       * an empty settings file. A value typed on the settings page wins for
       * the URL and the entity - they are not credentials, and the page is
       * where a person expects to change them. The TOKEN is the other way
       * round and is resolved below, where the environment wins. */
      if ((options[HOME_ASSISTANT_URL_OPTION] ?? '') === '') {
        options[HOME_ASSISTANT_URL_OPTION] = this.#config.homeAssistant?.url ?? '';
      }
      if ((options[HOME_ASSISTANT_ENTITY_OPTION] ?? '') === '') {
        options[HOME_ASSISTANT_ENTITY_OPTION] = this.#config.homeAssistant?.weatherEntity ?? '';
      }
    }

    let credential: string | null = null;
    if (provider.credential.kind === 'required') {
      /* ONLY the id this provider declares. The store applies
       * environment-wins precedence; nothing here re-decides it. */
      credential = (await this.#credentials.resolve(provider.credential.credentialId)).value;
    }

    return {
      location: settings.location,
      units: settings.weather.units,
      fetch: this.#fetch,
      credential,
      options,
      contact: settings.contact,
      timeoutMs: this.#timeoutMs,
    };
  }

  /** One reading from the selected provider. Throws ProviderError and
   * nothing else - see rule 2. */
  async read(): Promise<WeatherResult> {
    const provider = this.provider();
    const request = await this.#request(provider);
    try {
      return {provider, reading: await provider.read(request)};
    } catch (cause) {
      throw normalise(cause, provider);
    }
  }

  /** The experimental outlook, or a ProviderError explaining why this
   * provider has none. */
  async forecast(days = 3): Promise<{provider: WeatherProvider; days: readonly ForecastDay[]}> {
    const provider = this.provider();
    if (provider.forecast === undefined) {
      throw new ProviderError(
        'unusable',
        `${provider.label} reports the conditions right now and has no multi-day outlook. `
        + 'Choose Open-Meteo under Integrations if you want one.',
      );
    }
    const request = await this.#request(provider);
    try {
      return {provider, days: await provider.forecast(request, days)};
    } catch (cause) {
      throw normalise(cause, provider);
    }
  }

  /** Reads a SPECIFIC provider, for the test endpoint - so "Test" tests the
   * row the person pressed rather than whatever is currently selected. */
  async test(provider: WeatherProvider): Promise<WeatherResult> {
    const request = await this.#request(provider);
    try {
      return {provider, reading: await provider.read(request)};
    } catch (cause) {
      throw normalise(cause, provider);
    }
  }

  /** The experimental outlook as a single block of text, ready for a text
   * Block's body. Shaped here rather than in the renderer for the same reason
   * the quote is: the date-to-words decision lives on the server side of the
   * seam, and `src/render/**` stays untouched. */
  async outlook(days = 3): Promise<string> {
    const {days: forecast} = await this.forecast(days);
    const zone = this.#settings.current.location?.timeZone;
    return forecast.map((day) => {
      const when = dayName(day.date, zone);
      const high = day.high === null ? '—' : `${Math.round(day.high)}`;
      const low = day.low === null ? '—' : `${Math.round(day.low)}`;
      const unit = day.unit === '' ? '' : `\u00a0${day.unit}`;
      return `${when}: ${high}${unit} / ${low}${unit}`;
    }).join('\n');
  }
}

/* The weekday, in the household's own zone when the geocoder reported one.
 * A date string rendered without a zone silently uses the container's, which
 * is an accident of an image rather than a household fact. */
function dayName(iso: string, timeZone: string | undefined): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      ...(timeZone === undefined ? {} : {timeZone}),
    }).format(parsed);
  } catch {
    /* An invalid zone from a geocoder must not break a Block. */
    return new Intl.DateTimeFormat('en-GB', {weekday: 'short'}).format(parsed);
  }
}

/* Anything that is not already a household-safe sentence becomes one. The
 * original is DISCARDED rather than appended: a thrown value from a fetch
 * implementation carries the request URL, and for Home Assistant that URL is
 * a LAN address. */
function normalise(cause: unknown, provider: WeatherProvider): ProviderError {
  if (cause instanceof ProviderError) return cause;
  return new ProviderError(
    'unreachable',
    `${provider.label} could not be reached, and the reason was not one Canvas recognises.`,
  );
}

/** The sentence a test endpoint returns on success. The whole point of the
 * endpoint: a green tick proves a handshake, a temperature proves the thing
 * that will be on the wall. */
export function connectedSentence(result: WeatherResult): string {
  const {reading, provider} = result;
  const where = reading.place !== undefined && reading.place !== ''
    ? ` in ${reading.place}`
    : '';
  if (reading.temperature === null) {
    return `Connected to ${provider.label}, but it reported no temperature${where}.`;
  }
  const unit = reading.unit === '' ? '' : `\u00a0${reading.unit}`;
  return `Connected — ${Math.round(reading.temperature)}${unit}${where}, from ${provider.label}.`;
}
