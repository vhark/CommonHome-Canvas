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
/* The weather provider registry.
 *
 * THE ORDER OF THIS LIST IS A PRODUCT DECISION. Open-Meteo is first because
 * it is the default and the one nobody has to configure; Home Assistant is
 * last and marked advanced because it is the best answer for a minority and
 * a dead end for everyone else. A settings page that leads with the option
 * requiring a token teaches a household that Canvas requires a token.
 *
 * THE DEFAULT IS A CONSTANT, NOT A FALLBACK. `DEFAULT_WEATHER_PROVIDER_ID`
 * is what an empty settings file means, which is what makes "empty data
 * directory, no environment, real temperature" a property of the product
 * rather than of a lucky code path.
 */

import {homeAssistant, HOME_ASSISTANT_ID} from './home-assistant.ts';
import {metNo, MET_NO_ID} from './met-no.ts';
import {openMeteo, OPEN_METEO_ID} from './open-meteo.ts';
import type {CredentialRequirement, WeatherProvider} from './types.ts';

export const WEATHER_PROVIDERS: readonly WeatherProvider[] = [openMeteo, metNo, homeAssistant];

/** What a household gets having configured nothing. */
export const DEFAULT_WEATHER_PROVIDER_ID = OPEN_METEO_ID;

export function weatherProvider(id: unknown): WeatherProvider | null {
  if (typeof id !== 'string') return null;
  return WEATHER_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** The selected provider, or the default. A settings file naming a provider
 * this build removed must not blank the wall: it falls back to the keyless
 * default, which is the safe direction to be wrong in. */
export function weatherProviderOrDefault(id: unknown): WeatherProvider {
  return weatherProvider(id) ?? openMeteo;
}

export function isWeatherProviderId(value: unknown): boolean {
  return weatherProvider(value) !== null;
}

/** Every credential id any provider declares. The credential store validates
 * against this, so a PUT for an id no provider uses is refused rather than
 * silently stored forever in a file nobody reads. */
export function declaredCredentialIds(): readonly string[] {
  const out: string[] = [];
  for (const provider of WEATHER_PROVIDERS) {
    if (provider.credential.kind === 'required') out.push(provider.credential.credentialId);
  }
  return out;
}

export function credentialRequirementFor(id: unknown): CredentialRequirement | null {
  return weatherProvider(id)?.credential ?? null;
}

export {conditionFromSymbol, conditionFromWmo, unitFor} from './conditions.ts';
export {geocode, openMeteo, OPEN_METEO_ID} from './open-meteo.ts';
export {metNo, metNoUserAgent, MET_NO_DEFAULT_CONTACT, MET_NO_ID} from './met-no.ts';
export {
  homeAssistant,
  HOME_ASSISTANT_CREDENTIAL,
  HOME_ASSISTANT_ENTITY_OPTION,
  HOME_ASSISTANT_ID,
  HOME_ASSISTANT_URL_OPTION,
} from './home-assistant.ts';
export {
  ProviderError,
  type CredentialRequirement,
  type ForecastDay,
  type Location,
  type ProviderFetch,
  type ProviderHelp,
  type Units,
  type WeatherProvider,
  type WeatherRequest,
} from './types.ts';
