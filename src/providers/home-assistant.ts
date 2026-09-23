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
/* Home Assistant: now ONE PROVIDER AMONG SEVERAL, not the weather source.
 *
 * Nothing about how the request is made has changed from snapshot.ts - the
 * path, the header, the fields read and the timeout are the same. What has
 * changed is its POSITION: it is `advanced: true`, it is not the default, and
 * a household that does not run Home Assistant now never sees a weather Block
 * that says "no source configured".
 *
 * IT IS STILL THE BEST OPTION FOR THE HOUSEHOLDS THAT HAVE IT, and the help
 * text says so rather than apologising for it: a public API cannot report the
 * temperature of a sensor on someone's porch, and a household with one should
 * use it.
 *
 * THE TOKEN IS HANDED IN, NEVER READ. `request.credential` arrives already
 * resolved through environment-wins precedence. This module cannot read the
 * credential file and cannot read process.env, so it cannot leak a credential
 * belonging to another integration, and a test can exercise it with an
 * invented token and no environment at all.
 *
 * THE ERROR MESSAGES NEVER ECHO THE TOKEN. Not the whole token, not a prefix,
 * not a length. "That token was rejected" is the entire useful content of a
 * 401, and everything beyond it is a credential in a log file.
 */

import type {WeatherReading} from '../render/data.ts';
import {attributionFrom} from '../render/data.ts';
import {unitFor} from './conditions.ts';
import {
  ProviderError,
  type ProviderFetch,
  type WeatherProvider,
  type WeatherRequest,
} from './types.ts';

export const HOME_ASSISTANT_ID = 'home-assistant';

/** The id the credential store holds the long-lived token under. Named once,
 * here, so the settings page, the store and this provider cannot disagree. */
export const HOME_ASSISTANT_CREDENTIAL = 'home-assistant-token';

/** Non-credential options this provider reads. A URL is not a secret - it is
 * frequently a LAN name - so it lives in settings, not in the credential
 * file. The entity id likewise: it is a local name, not a bearer token. */
export const HOME_ASSISTANT_URL_OPTION = 'url';
export const HOME_ASSISTANT_ENTITY_OPTION = 'weatherEntity';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function callHomeAssistant(
  fetchImpl: ProviderFetch,
  base: string,
  path: string,
  token: string,
  timeoutMs: number,
): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(`${base}/api/${path}`, {
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /* The cause carries the URL, which for a self-hosted Home Assistant is a
     * LAN address - a household fact, not something to put in a message that
     * reaches a page. */
    throw new ProviderError(
      'unreachable',
      'Home Assistant could not be reached at that address from this machine.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    /* The ENTIRE useful content of this failure. No prefix, no suffix, no
     * length, no echo. */
    throw new ProviderError('unauthorised', 'That token was rejected by Home Assistant.');
  }
  if (res.status === 404) {
    throw new ProviderError(
      'unusable',
      'Home Assistant has no entity with that id. Check the weather entity name in Developer tools → States.',
    );
  }
  if (!res.ok) {
    throw new ProviderError('unreachable', `Home Assistant answered ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError('unusable', 'Home Assistant sent a reply Canvas could not read.');
  }
}

export const homeAssistant: WeatherProvider = {
  id: HOME_ASSISTANT_ID,
  label: 'Home Assistant',
  summary: 'Reads a weather entity from your own Home Assistant. Needs a long-lived access token.',
  credential: {
    kind: 'required',
    credentialId: HOME_ASSISTANT_CREDENTIAL,
    label: 'Long-lived access token',
  },
  /* The entity already knows where it is. Asking a household to type a place
   * name to read their own porch sensor would be asking twice. */
  needsLocation: false,
  advanced: true,
  help: {
    whatItIs:
      'A long-lived access token lets Canvas read a weather entity from your Home '
      + 'Assistant — your own sensors, including ones no public forecast can see. '
      + 'Canvas only ever reads; it cannot switch anything on or off.',
    howToMakeOne: [
      'Open Home Assistant and click your name at the bottom of the sidebar.',
      'Choose the Security tab.',
      'Scroll to Long-lived access tokens and choose Create token.',
      'Name it something you will recognise later, such as “Canvas”.',
      'Copy the token it shows you — Home Assistant will not show it again — and paste it here.',
    ],
    ifItLeaks:
      'A Home Assistant token is powerful. It is not read-only at the Home Assistant '
      + 'end: anyone holding it can read every entity in your house and call services, '
      + 'which can mean unlocking doors. Canvas never sends it to a browser and never '
      + 'writes it to a log, but treat it like a house key. You can revoke it from the '
      + 'same Security page at any time.',
    ifYouWouldRatherNot:
      'You do not need this for weather. Open-Meteo above gives real local forecasts '
      + 'with no account and no token, and it is what Canvas uses by default.',
  },

  async read(request: WeatherRequest): Promise<WeatherReading> {
    const url = trimmed(request.options[HOME_ASSISTANT_URL_OPTION]).replace(/\/$/, '');
    const entity = trimmed(request.options[HOME_ASSISTANT_ENTITY_OPTION]);
    const token = request.credential ?? '';

    if (url === '' || token === '') {
      throw new ProviderError(
        'unconfigured',
        'Home Assistant needs both its address and a long-lived access token before it can be used.',
      );
    }
    if (entity === '') {
      throw new ProviderError(
        'unconfigured',
        'Home Assistant needs the id of a weather entity, such as the one shown in Developer tools → States.',
      );
    }

    const state = (await callHomeAssistant(
      request.fetch,
      url,
      `states/${encodeURIComponent(entity)}`,
      token,
      request.timeoutMs,
    )) as {state?: unknown; attributes?: Record<string, unknown>} | null;

    const attributes = state?.attributes ?? {};
    const place = trimmed(attributes.friendly_name);

    return {
      state: String(state?.state ?? 'unknown'),
      temperature: num(attributes.temperature),
      /* The entity's own unit, because a Home Assistant instance is already
       * configured with the household's preference and overriding it here
       * would make the same house disagree with itself. */
      unit: trimmed(attributes.temperature_unit) || unitFor(request.units),
      ...(place === '' ? {} : {place}),
      /* attributionFrom shortens a provider's whole sentence to the
       * institution being credited, which is what the licences ask for and
       * what fits under a number on a wall. */
      attribution: attributionFrom(attributes.attribution ?? 'Home Assistant'),
    };
  },
};
