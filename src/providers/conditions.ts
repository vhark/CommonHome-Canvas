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
/* Provider condition tokens, mapped onto the vocabulary the renderer already
 * speaks.
 *
 * `conditionText` in src/render/data.ts turns a token into an English word,
 * and its table is the Home Assistant vocabulary because that is what existed
 * first. Rather than widen the renderer - which this phase exists to prove is
 * unnecessary - each provider translates ITS OWN tokens into that vocabulary
 * here, at the edge, where the provider's documentation is the thing being
 * read.
 *
 * Unknown codes fall through to a lower-cased token rather than to "unknown":
 * `conditionText` already turns `freezing-rain` into "Freezing rain", so a
 * household seeing an unmapped code still learns something true.
 */

/* WMO 4677 present-weather codes, which is what Open-Meteo's `weather_code`
 * is. Grouped rather than enumerated exhaustively: the distinction between
 * "slight" and "moderate" drizzle does not survive being read from across a
 * kitchen, and inventing five words for rain would make the wall noisier
 * without making it more informative. */
const WMO: Record<number, string> = {
  0: 'sunny',
  1: 'sunny',
  2: 'partlycloudy',
  3: 'cloudy',
  45: 'fog',
  48: 'fog',
  51: 'rainy',
  53: 'rainy',
  55: 'rainy',
  56: 'snowy-rainy',
  57: 'snowy-rainy',
  61: 'rainy',
  63: 'rainy',
  65: 'pouring',
  66: 'snowy-rainy',
  67: 'snowy-rainy',
  71: 'snowy',
  73: 'snowy',
  75: 'snowy',
  77: 'snowy',
  80: 'rainy',
  81: 'rainy',
  82: 'pouring',
  85: 'snowy',
  86: 'snowy',
  95: 'lightning',
  96: 'lightning-rainy',
  99: 'lightning-rainy',
};

/* Code 1 is "mainly clear" and code 0 is "clear sky". Both render as "Sunny"
 * above, which is wrong at night in a way a household notices immediately -
 * so the caller passes whether it is dark and clear becomes `clear-night`,
 * which the renderer already knows as "Clear". */
export function conditionFromWmo(code: unknown, isNight = false): string {
  const n = typeof code === 'number' && Number.isFinite(code) ? Math.trunc(code) : NaN;
  if (!Number.isFinite(n)) return '';
  const token = WMO[n];
  if (token === undefined) return `wmo-${n}`;
  if (isNight && token === 'sunny') return 'clear-night';
  return token;
}

/* met.no symbol codes are `<condition>_<day|night|polartwilight>`, and the
 * condition half carries an intensity prefix (`light`, `heavy`) and an
 * optional `_and_thunder` suffix. The suffix is checked FIRST, because
 * `heavyrainandthunder` is a thunderstorm before it is rain and a household
 * that sees "Heavy rain" when there is lightning outside has been told the
 * less useful of two true things. */
export function conditionFromSymbol(symbol: unknown): string {
  const raw = String(symbol ?? '').trim().toLowerCase();
  if (raw === '') return '';
  const base = raw.replace(/_(day|night|polartwilight)$/, '');
  const night = raw.endsWith('_night');

  if (base.includes('thunder')) {
    return base.includes('rain') || base.includes('sleet') || base.includes('snow')
      ? 'lightning-rainy'
      : 'lightning';
  }
  if (base.includes('sleet')) return 'snowy-rainy';
  if (base.includes('snow')) return 'snowy';
  if (base.includes('heavyrain')) return 'pouring';
  if (base.includes('rain')) return 'rainy';
  if (base === 'fog') return 'fog';
  if (base === 'cloudy') return 'cloudy';
  if (base === 'partlycloudy') return 'partlycloudy';
  /* `fair` is met.no's "mostly clear with some cloud". Rendering it as
   * "Partly cloudy" over-reports the cloud; rendering it as clear is the
   * closer of the two available words. */
  if (base === 'clearsky' || base === 'fair') return night ? 'clear-night' : 'sunny';
  return base;
}

/* Degree symbols, spelled once. The renderer emits `unit` verbatim after a
 * non-breaking space, so this is the only place the shape of a unit is
 * decided. */
export const CELSIUS = '\u00b0C';
export const FAHRENHEIT = '\u00b0F';

export function unitFor(units: 'metric' | 'imperial'): string {
  return units === 'imperial' ? FAHRENHEIT : CELSIUS;
}

/** Celsius to Fahrenheit, for a provider that only speaks one of them.
 * met.no reports celsius and has no unit parameter, so an imperial household
 * gets the conversion here rather than a wrong number on a wall. */
export function toFahrenheit(celsius: number): number {
  return celsius * 9 / 5 + 32;
}

export function convertTemperature(
  value: number | null,
  from: 'metric' | 'imperial',
  to: 'metric' | 'imperial',
): number | null {
  if (value === null) return null;
  if (from === to) return value;
  return from === 'metric' ? toFahrenheit(value) : (value - 32) * 5 / 9;
}
