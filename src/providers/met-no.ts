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
/* met.no (the Norwegian Meteorological Institute): the second keyless option.
 *
 * Measured before anything here was written:
 *
 *   GET /weatherapi/locationforecast/2.0/compact?lat=..&lon=..
 *   -> 200, with an identifying User-Agent
 *
 * THE USER-AGENT IS A TERMS-OF-SERVICE OBLIGATION, NOT AN OPTIMISATION. met.no
 * publish that requests must identify the application and give them a way to
 * make contact; unidentified traffic is blocked. So the header is built here,
 * from a constant application name plus whatever contact string the household
 * configured, and a request is NEVER issued without it.
 *
 * The contact string is deliberately OPTIONAL and defaults to the project's
 * own URL rather than to an email address: requiring a household to publish a
 * personal email address to a third party before their wall shows a
 * temperature would be a worse default than sending no personal data at all.
 * A household that wants to be reachable can set one.
 *
 * WHY CELSIUS IS CONVERTED HERE. met.no reports `air_temperature` in celsius
 * with no unit parameter to ask otherwise. An imperial household therefore
 * gets the conversion at this edge, where the source unit is known for
 * certain, rather than downstream where it would be guessed.
 */

import type {WeatherReading} from '../render/data.ts';
import {conditionFromSymbol, convertTemperature, unitFor} from './conditions.ts';
import {
  ProviderError,
  type Location,
  type ProviderFetch,
  type WeatherProvider,
  type WeatherRequest,
} from './types.ts';

export const MET_NO_ID = 'met-no';
export const MET_NO_ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

/* Their licence asks for this exact credit wherever the data is shown. It is
 * rendered beneath the number by the weather Block, like every other source. */
const ATTRIBUTION = 'MET Norway';

/* The application half of the User-Agent. A real product name, because "an
 * unidentified script" is precisely what their rule exists to exclude. */
export const MET_NO_APP = 'CommonHomeCanvas';

/** The contact half, used when a household has not set one. A project URL
 * rather than a person's address: a household should not have to publish an
 * email to a third party to see a temperature. */
export const MET_NO_DEFAULT_CONTACT = 'https://github.com/commonhome/canvas';

/* Built, never interpolated blindly: a newline in a configured contact string
 * would be header injection, so anything outside a conservative set is
 * dropped rather than escaped. */
export function metNoUserAgent(contact: string): string {
  const cleaned = contact.replace(/[^\x21-\x7e ]+/g, '').trim();
  const suffix = cleaned === '' ? MET_NO_DEFAULT_CONTACT : cleaned;
  return `${MET_NO_APP}/1.0 ${suffix}`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coord(value: number): string {
  /* met.no explicitly ask that coordinates be truncated to four decimals, so
   * that their cache is usable. Doing what a free service asks is also how it
   * stays free. */
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

async function readJson(
  fetchImpl: ProviderFetch,
  url: string,
  timeoutMs: number,
  contact: string,
): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, {
      /* Never omitted. An unidentified request is one their terms forbid. */
      headers: {'User-Agent': metNoUserAgent(contact), Accept: 'application/json'},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError('unreachable', 'MET Norway could not be reached. Check this machine’s internet connection.');
  }
  if (res.status === 403) {
    /* Their documented answer to an unidentified or blocked client, and the
     * one failure here with an action attached to it. */
    throw new ProviderError(
      'unusable',
      'MET Norway refused the request. Their terms require an identifying contact; '
      + 'set one under Location and contact on this page.',
    );
  }
  if (!res.ok) {
    throw new ProviderError(
      'unreachable',
      `MET Norway answered ${res.status}. It needs no account, so this is usually a temporary outage.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError('unusable', 'MET Norway sent a reply Canvas could not read.');
  }
}

export const metNo: WeatherProvider = {
  id: MET_NO_ID,
  label: 'MET Norway',
  summary: 'Free public forecasts from the Norwegian Meteorological Institute. No account needed.',
  credential: {kind: 'none'},
  needsLocation: true,
  advanced: false,
  help: {
    whatItIs:
      'MET Norway is a national weather service that publishes its forecasts freely. '
      + 'It needs no account and no key. It does ask that software using it identifies '
      + 'itself and gives them a way to get in touch, which Canvas does.',
    howToMakeOne: [],
    ifItLeaks:
      'There is no key to leak. Canvas sends a pair of coordinates and, if you set one, '
      + 'the contact address you typed — so do not put an address here you would not '
      + 'give to a weather service.',
    ifYouWouldRatherNot:
      'Open-Meteo above works the same way and asks for no contact address at all. '
      + 'Home Assistant reads your own sensors and sends nothing outside your house.',
  },

  async read(request: WeatherRequest): Promise<WeatherReading> {
    const location = requireLocation(request);
    const url = `${MET_NO_ENDPOINT}?lat=${coord(location.latitude)}&lon=${coord(location.longitude)}`;
    const payload = (await readJson(request.fetch, url, request.timeoutMs, request.contact)) as {
      properties?: {timeseries?: unknown};
    };

    const series = Array.isArray(payload?.properties?.timeseries)
      ? payload.properties.timeseries
      : [];
    const first = series[0] as {data?: Record<string, unknown>} | undefined;
    const data = first?.data;
    if (data === undefined) {
      throw new ProviderError('unusable', 'MET Norway replied without a current reading.');
    }

    const details = (data.instant as {details?: Record<string, unknown>} | undefined)?.details;
    const celsius = num(details?.air_temperature);
    /* The symbol lives on the FORECAST for the next hour, not on the instant -
     * an instantaneous reading has a temperature and a humidity but no notion
     * of "rain". Falling back through the six-hour summary keeps a condition
     * on screen at the end of the series, where the one-hour block stops
     * being published. */
    const symbol =
      (data.next_1_hours as {summary?: {symbol_code?: unknown}} | undefined)?.summary?.symbol_code
      ?? (data.next_6_hours as {summary?: {symbol_code?: unknown}} | undefined)?.summary?.symbol_code
      ?? (data.next_12_hours as {summary?: {symbol_code?: unknown}} | undefined)?.summary?.symbol_code;

    return {
      state: conditionFromSymbol(symbol),
      temperature: convertTemperature(celsius, 'metric', request.units),
      unit: unitFor(request.units),
      place: location.name,
      attribution: {source: ATTRIBUTION, sourceUrl: 'https://www.met.no/'},
    };
  },
};
