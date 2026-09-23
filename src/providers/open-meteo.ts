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
/* Open-Meteo: the default, and the reason this phase exists.
 *
 * Measured against the live service before anything here was written:
 *
 *   GET /v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code
 *   -> 200, no key, no account, no header
 *
 * That measurement is what makes "a household gets real weather with zero
 * configuration" a true statement rather than a goal. There is no credential
 * in this file because there is no credential to have.
 *
 * WHY `current` AND NOT `current_weather`. The older `current_weather=true`
 * parameter returns a fixed field set in fixed units and gives no
 * `current_units` back, so an imperial household would get celsius silently.
 * `current=temperature_2m,weather_code` honours `temperature_unit` and reports
 * the unit it actually used, which is the value rendered next to the number.
 * A wall that says 17 °C when it means 17 °F is the one weather bug nobody
 * forgives.
 */

import type {WeatherReading} from '../render/data.ts';
import {conditionFromWmo, unitFor} from './conditions.ts';
import {
  ProviderError,
  type ForecastDay,
  type Location,
  type ProviderFetch,
  type WeatherProvider,
  type WeatherRequest,
} from './types.ts';

export const OPEN_METEO_ID = 'open-meteo';
export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';

/* Credited by name, because a number on a wall says where it came from - and
 * because it is the courteous thing to do for a service that asks for no key,
 * no account and no payment. */
const ATTRIBUTION = 'Open-Meteo';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* The service reports the unit it used, per field. Trusted over the unit we
 * asked for, because the two disagreeing is exactly the case where guessing
 * is wrong. The key is named by the caller: `current_units` keys the
 * instantaneous field and `daily_units` keys the maximum, and a helper that
 * assumed one would silently fall back for the other. */
function unitFrom(
  units: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const reported = units?.[key];
  return typeof reported === 'string' && reported.trim() !== '' ? reported.trim() : fallback;
}

/* Night is decided from the service's own `is_day` flag when it sends one,
 * because the alternative - comparing the household's clock to a sunrise we
 * would have to fetch separately - is a second request to answer a question
 * the first request already answered. */
function isNight(current: Record<string, unknown>): boolean {
  const flag = current.is_day;
  return flag === 0 || flag === false;
}

async function readJson(
  fetchImpl: ProviderFetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, {headers, signal: AbortSignal.timeout(timeoutMs)});
  } catch {
    /* The cause is deliberately not inspected. Node puts the URL into the
     * message of most network errors, and while THIS provider's URL carries
     * no credential, the habit is what keeps the one that does safe. */
    throw new ProviderError('unreachable', 'Open-Meteo could not be reached. Check this machine’s internet connection.');
  }
  if (!res.ok) {
    throw new ProviderError(
      'unreachable',
      `Open-Meteo answered ${res.status}. It needs no account, so this is usually a temporary outage.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError('unusable', 'Open-Meteo sent a reply Canvas could not read.');
  }
}

/** Place name -> coordinates, keyless. Used once, when a household types a
 * place into settings; the coordinates are then stored and this is not called
 * again. Returns several candidates because "Springfield" is a genuine
 * ambiguity a person must resolve, not one a server should guess at. */
export async function geocode(
  name: string,
  options: {fetch?: ProviderFetch; timeoutMs?: number; count?: number} = {},
): Promise<readonly Location[]> {
  const query = name.trim();
  if (query === '') return [];
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ProviderFetch);
  const count = Math.min(Math.max(1, options.count ?? 5), 10);
  const url = `${OPEN_METEO_GEOCODER}?name=${encodeURIComponent(query)}&count=${count}&format=json`;
  const payload = (await readJson(fetchImpl, url, options.timeoutMs ?? 8000)) as {
    results?: unknown;
  };
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const out: Location[] = [];
  for (const entry of results) {
    const record = entry as Record<string, unknown>;
    const latitude = num(record.latitude);
    const longitude = num(record.longitude);
    const label = typeof record.name === 'string' ? record.name.trim() : '';
    if (latitude === null || longitude === null || label === '') continue;
    out.push({
      name: label,
      latitude,
      longitude,
      ...(typeof record.admin1 === 'string' && record.admin1 !== '' ? {region: record.admin1} : {}),
      ...(typeof record.country_code === 'string' ? {countryCode: record.country_code} : {}),
      ...(typeof record.timezone === 'string' ? {timeZone: record.timezone} : {}),
    });
  }
  return out;
}

/* Coordinates are rounded to four decimal places on the way out - about 11
 * metres, which is more precision than any weather model has and rather less
 * than a house number. The exact value a geocoder returned for a household is
 * a home address; the value sent to a provider need not be. */
function coord(value: number): string {
  return value.toFixed(4);
}

function requireLocation(request: WeatherRequest): Location {
  if (request.location === null) {
    throw new ProviderError(
      'unconfigured',
      'No location is set yet. Type a town or city on the settings page and Canvas will look up its coordinates.',
    );
  }
  return request.location;
}

export const openMeteo: WeatherProvider = {
  id: OPEN_METEO_ID,
  label: 'Open-Meteo',
  summary: 'Free public forecasts. No account, no key, nothing to sign up for.',
  credential: {kind: 'none'},
  needsLocation: true,
  advanced: false,
  help: {
    whatItIs:
      'Open-Meteo is a free weather service that needs no account at all. Canvas '
      + 'asks it for the current temperature at the place you set below, and nothing else. '
      + 'It is what Canvas uses unless you choose otherwise.',
    howToMakeOne: [],
    ifItLeaks:
      'There is nothing to leak: no key, no token, no account. The only thing Canvas '
      + 'sends is a pair of coordinates, rounded to about 11 metres.',
    ifYouWouldRatherNot:
      'If you would rather not send your coordinates to a public service at all, choose '
      + 'Home Assistant below and read your own sensors, or turn the weather Block off '
      + 'under Blocks.',
  },

  async read(request: WeatherRequest): Promise<WeatherReading> {
    const location = requireLocation(request);
    const url = `${OPEN_METEO_ENDPOINT}?latitude=${coord(location.latitude)}`
      + `&longitude=${coord(location.longitude)}`
      + '&current=temperature_2m,weather_code,is_day'
      + `&temperature_unit=${request.units === 'imperial' ? 'fahrenheit' : 'celsius'}`;

    const payload = (await readJson(request.fetch, url, request.timeoutMs)) as {
      current?: Record<string, unknown>;
      current_units?: Record<string, unknown>;
    };
    const current = payload?.current;
    if (current === undefined || current === null || typeof current !== 'object') {
      throw new ProviderError('unusable', 'Open-Meteo replied without a current reading.');
    }

    return {
      state: conditionFromWmo(current.weather_code, isNight(current)),
      temperature: num(current.temperature_2m),
      unit: unitFrom(payload.current_units, 'temperature_2m', unitFor(request.units)),
      place: location.name,
      attribution: {source: ATTRIBUTION, sourceUrl: 'https://open-meteo.com/'},
    };
  },

  async forecast(request: WeatherRequest, days: number): Promise<readonly ForecastDay[]> {
    const location = requireLocation(request);
    const wanted = Math.min(Math.max(1, Math.trunc(days)), 7);
    const url = `${OPEN_METEO_ENDPOINT}?latitude=${coord(location.latitude)}`
      + `&longitude=${coord(location.longitude)}`
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
      + `&forecast_days=${wanted}`
      + `&temperature_unit=${request.units === 'imperial' ? 'fahrenheit' : 'celsius'}`;

    const payload = (await readJson(request.fetch, url, request.timeoutMs)) as {
      daily?: Record<string, unknown>;
      daily_units?: Record<string, unknown>;
    };
    const daily = payload?.daily as {
      time?: unknown;
      temperature_2m_max?: unknown;
      temperature_2m_min?: unknown;
      weather_code?: unknown;
    } | undefined;
    const times = Array.isArray(daily?.time) ? daily.time : [];
    if (times.length === 0) throw new ProviderError('unusable', 'Open-Meteo replied without an outlook.');

    const highs = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max : [];
    const lows = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min : [];
    const codes = Array.isArray(daily?.weather_code) ? daily.weather_code : [];
    const unit = unitFrom(payload.daily_units, 'temperature_2m_max', unitFor(request.units));

    return times.slice(0, wanted).map((time, index): ForecastDay => ({
      date: String(time),
      high: num(highs[index]),
      low: num(lows[index]),
      /* Never night: a daily summary covers both halves of a day, so the
       * night variant of a clear sky would be wrong for half of it. */
      state: conditionFromWmo(codes[index], false),
      unit,
    }));
  },
};
