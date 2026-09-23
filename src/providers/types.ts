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
/* What a provider IS, and what it is not.
 *
 * A Block declares WHAT IT NEEDS - a weather reading. A provider declares HOW
 * TO GET ONE. The household picks. That inversion is the whole point of this
 * directory, and it is what turns "you need a Home Assistant token before the
 * wall shows a temperature" into "the wall shows a temperature, and if you run
 * Home Assistant you can point it at your own sensors instead".
 *
 * THREE RULES HOLD THIS LAYER.
 *
 * 1. A PROVIDER MAPS INTO `WeatherReading` AND NOTHING ELSE. The render layer
 *    (`src/render/**`) is not modified by adding a provider - it already takes
 *    a `WeatherReading` and does not care where one came from. If a provider
 *    ever needed a new field on the render side, the registry shape would have
 *    failed: the point is that "add a weather source" is a call-site change.
 *
 * 2. HELP TEXT LIVES HERE, BESIDE THE CODE THAT USES THE CREDENTIAL. Help in
 *    a separate document is help that goes stale the first time an upstream
 *    renames a menu. Every provider answers the same four questions, because
 *    those are the four a person who has never made a token actually has:
 *    what is this, how do I make one, what can it do if it leaks, and what if
 *    I would rather not.
 *
 * 3. A PROVIDER NEVER SEES A STORED SECRET IT WAS NOT GIVEN. The credential
 *    arrives as one string on the context object, resolved by the server from
 *    environment-or-store. A provider cannot read the credential file, cannot
 *    read process.env, and therefore cannot leak a credential belonging to a
 *    different integration.
 */

import type {WeatherReading} from '../render/data.ts';

/* The subset of `fetch` a provider is allowed to use. Injectable so every test
 * in this directory runs offline, and narrow so a provider cannot reach for a
 * streaming body, a cookie jar or a redirect policy. Structurally compatible
 * with `FetchLike` in server/snapshot.ts on purpose - one shape, two users. */
export type ProviderFetch = (
  input: string,
  init?: {headers?: Record<string, string>; signal?: AbortSignal},
) => Promise<{ok: boolean; status: number; json(): Promise<unknown>}>;

/** A household's place, as coordinates plus the name it was typed as.
 *
 * COORDINATES ARE A HOME ADDRESS IN ANOTHER FORM. They live in the settings
 * sidecar, never in a canvas document, and never in a share export - the same
 * rule and the same enforcement point as a calendar location. */
export type Location = {
  /** What the household typed, e.g. `Boulder`. Rendered as the block's place. */
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  /** Region/state, for disambiguating two places with the same name. */
  readonly region?: string;
  readonly countryCode?: string;
  /** IANA zone the geocoder reported, if any. Advisory only. */
  readonly timeZone?: string;
};

export type Units = 'metric' | 'imperial';

/** What a provider needs before it can be selected. `none` is the interesting
 * case and the default: weather genuinely needs no account anywhere. */
export type CredentialRequirement =
  | {readonly kind: 'none'}
  | {
      readonly kind: 'required';
      /** The id the credential store holds it under. */
      readonly credentialId: string;
      /** What the field is called on the settings page. */
      readonly label: string;
    };

/** The four questions, answered once, next to the code that uses the token. */
export type ProviderHelp = {
  /** "A long-lived access token lets Canvas read your sensors." */
  readonly whatItIs: string;
  /** Numbered steps naming the real UI path. Empty when nothing to make. */
  readonly howToMakeOne: readonly string[];
  /** Honest scope. A Home Assistant token is powerful; a photo key is not. */
  readonly ifItLeaks: string;
  /** The no-credential alternative, named. For weather there genuinely is one. */
  readonly ifYouWouldRatherNot: string;
};

/** Everything a provider is handed for one read. Assembled by the server from
 * settings, the credential store and the environment; a provider reads neither
 * itself. */
export type WeatherRequest = {
  readonly location: Location | null;
  readonly units: Units;
  readonly fetch: ProviderFetch;
  /** Already resolved through environment-wins precedence, or null. */
  readonly credential: string | null;
  /** Non-credential per-provider configuration: a base URL, an entity id. */
  readonly options: {readonly [key: string]: string | null | undefined};
  /** An identifying contact string for providers whose terms require one. */
  readonly contact: string;
  readonly timeoutMs: number;
};

/** One day of an outlook. Deliberately minimal: a wall display is read at a
 * glance and three numbers is already the most anyone takes in. */
export type ForecastDay = {
  /** ISO date, `YYYY-MM-DD`, in the provider's reported local frame. */
  readonly date: string;
  readonly high: number | null;
  readonly low: number | null;
  readonly state: string;
  readonly unit: string;
};

/** A provider failure, in words a household can act on and with NOTHING of the
 * credential in it. The `code` is for the UI to branch on; the `message` is
 * what a person reads. */
export class ProviderError extends Error {
  readonly code: 'unauthorised' | 'unreachable' | 'unconfigured' | 'unusable';

  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export type WeatherProvider = {
  readonly id: string;
  readonly label: string;
  /** One line for the settings page, above the fold, never in a tooltip. */
  readonly summary: string;
  readonly credential: CredentialRequirement;
  /** True when the provider is useless without a household location. Home
   * Assistant is the exception: it reads an entity that already knows where
   * it is. */
  readonly needsLocation: boolean;
  /** Marks a provider as not-for-everyone on the settings page, so the list
   * reads "here is the one you want, and here are the others". */
  readonly advanced: boolean;
  readonly help: ProviderHelp;
  /** The whole contract. Throws ProviderError; never returns a partial. */
  read(request: WeatherRequest): Promise<WeatherReading>;
  /** Optional: the experimental outlook Block's data. A provider that cannot
   * supply one simply omits this, and the Block degrades with a reason. */
  forecast?(request: WeatherRequest, days: number): Promise<readonly ForecastDay[]>;
};
