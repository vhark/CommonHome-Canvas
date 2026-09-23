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
/* The settings surface: `/settings`, `/api/settings`, `/api/credentials`.
 *
 * LOOPBACK ONLY, AND THAT IS THE WHOLE OF THE AUTHENTICATION STORY FOR NOW.
 *
 * This page holds every credential the household owns, so it belongs behind
 * administrator authentication. That does not exist yet. Rather than ship it
 * anyway and write a warning in a README - a property that depends on
 * somebody reading a README is not a property - these routes inherit the
 * existing rule and call the SAME `apiReachable` the canvas API uses: the
 * peer address, which is the one value in a request a client cannot choose.
 *
 * THE ESCAPE HATCH IS DELIBERATELY *NOT* HONOURED HERE IN FULL. `apiReachable`
 * returns true when `CANVAS_API_ALLOW_REMOTE=true`, which someone may have
 * set for an unrelated reason - to reach the canvas API through their own
 * authenticating proxy. Publishing the CREDENTIAL page as a side effect of
 * that would be exactly the accident the design note warns about. So this
 * module requires loopback OR the allow-remote flag AND says so loudly in the
 * banner; see `settingsReachable`.
 *
 * NO ROUTE IN THIS FILE RETURNS A SECRET. `CredentialStore.describe()` is the
 * only credential shape any handler here can reach; `resolve()` is called by
 * the weather source alone, on its way to a provider. There is no GET that
 * prints a value, no POST that echoes one back in an error, and no log line
 * that carries one.
 *
 * FORMS POST, AND THE ANSWER IS A REDIRECT. A settings page that answers a
 * POST with a 200 leaves the browser one reload away from resubmitting a
 * credential. POST-redirect-GET, with the outcome carried in a query
 * parameter that is an opaque CODE rather than a message, so a crafted URL
 * cannot put arbitrary text on the page.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';

import {escapeHtml} from '../render/escape.ts';
import {
  geocode,
  isWeatherProviderId,
  ProviderError,
  weatherProvider,
  type Location,
} from '../providers/index.ts';
import {apiReachable} from './api.ts';
import {isKnownBlockType, ALL_BLOCK_TYPES, EXPERIMENTAL_BLOCK_TYPES} from './blocks.ts';
import type {CanvasConfig} from './config.ts';
import type {CredentialStore} from './credentials.ts';
import {renderSettingsPage, SETTINGS_PATH, type Notice} from './settings-page.ts';
import {parseLocation, type SettingsStore} from './settings.ts';
import {connectedSentence, type WeatherSource} from './weather-source.ts';

export {SETTINGS_PATH};

export const SETTINGS_API_PATH = '/api/settings';
export const CREDENTIALS_API_PATH = '/api/credentials';

/* A megabyte would be absurd for a settings form; 64 KiB is already generous
 * for a place name and a token, and keeps this unauthenticated (see above)
 * surface from being a memory primitive. */
const MAX_FORM_BYTES = 64 * 1024;

export type SettingsContext = {
  readonly config: CanvasConfig;
  readonly settings: SettingsStore;
  readonly credentials: CredentialStore;
  /* Optional so a server built for routing tests need not construct one; the
   * test endpoint refuses rather than pretending. */
  readonly weather?: WeatherSource;
  /* Injectable so the geocoder can be exercised offline. */
  readonly geocode?: typeof geocode;
};

/** The gate. Same peer-address check as the canvas API, named separately so
 * the reason it exists is attached to the credential surface rather than
 * inherited silently. */
export function settingsReachable(config: CanvasConfig, remoteAddress: string | undefined): boolean {
  return apiReachable(config, remoteAddress);
}

/* ------------------------------------------------------------- outcomes -- */

/* Opaque codes, resolved to prose HERE. A query parameter that is rendered
 * verbatim is a way to put any sentence on a page that a household trusts
 * with its credentials - "Canvas needs you to confirm your bank details" is a
 * plausible phishing string and a reflected-text page will render it. */
const NOTICES: Record<string, Notice> = {
  blocks_saved: {tone: 'ok', message: 'Blocks saved.'},
  weather_saved: {tone: 'ok', message: 'Weather source saved.'},
  options_saved: {tone: 'ok', message: 'Saved.'},
  contact_saved: {tone: 'ok', message: 'Contact address saved.'},
  experimental_saved: {tone: 'ok', message: 'Experimental settings saved.'},
  location_saved: {tone: 'ok', message: 'Location saved.'},
  credential_saved: {tone: 'ok', message: 'Credential saved. Canvas will not show it again.'},
  credential_cleared: {tone: 'ok', message: 'Credential removed.'},
  credential_empty: {tone: 'problem', message: 'Nothing was entered, so nothing was saved.'},
  credential_unknown: {tone: 'problem', message: 'No integration uses a credential by that name.'},
  location_none: {tone: 'problem', message: 'No place by that name was found. Try a larger town nearby.'},
  location_invalid: {tone: 'problem', message: 'That place could not be read. Search again.'},
  provider_unknown: {tone: 'problem', message: 'No weather source by that name.'},
  test_unavailable: {tone: 'problem', message: 'This server cannot run a test.'},
  not_saved: {tone: 'problem', message: 'That could not be saved.'},
};

function noticeFor(code: string | null): Notice | null {
  if (code === null) return null;
  /* A test result is the ONE outcome whose text is generated rather than
   * chosen, because a temperature is the whole point of the endpoint. It is
   * escaped by the page like every other string, and it is built from a
   * provider's own reading rather than from the request. */
  return NOTICES[code] ?? null;
}

/* --------------------------------------------------------------- reading -- */

/* One bounded read, shared. Returns null past the limit or on a broken
 * socket; the callers decide what the bytes mean. */
function readBytes(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        chunks.length = 0;
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/* A JSON body, whole. Used by the /api/settings writes, where a nested
 * `location` object must survive - flattening it through URLSearchParams and
 * re-parsing each value would turn a coordinate into a string and back. */
async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const text = await readBytes(req);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* A form body. The settings PAGE posts urlencoded (no JavaScript anywhere),
 * and curl posts JSON; both arrive here as the same flat key/value bag,
 * because every field these handlers read IS flat. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const text = await readBytes(req);
  if (text === null) return null;
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return new URLSearchParams(text);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else if (value !== null && value !== undefined) {
      params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return params;
}

/* --------------------------------------------------------------- writing -- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  /* no-store rather than no-cache: a page listing which integrations a
   * household has configured should not sit in a shared cache, and a back
   * button should re-ask rather than re-render a stale credential state. */
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  /* The global policy says form-action 'none', which would block every form
   * on this page. Re-set for this route only, exactly as share.ts does: one
   * route needing a form is not a reason for every route to permit one. */
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      /* 'none', not 'self': this page has no script and must not be able to
       * acquire one. It is the page that holds every credential. */
      "script-src 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  res.end(html);
}

function redirect(res: ServerResponse, code: string, extra: Record<string, string> = {}): void {
  const params = new URLSearchParams({notice: code, ...extra});
  res.statusCode = 303;
  res.setHeader('Location', `${SETTINGS_PATH}?${params.toString()}`);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function forbidden(res: ServerResponse): void {
  sendJson(res, 403, {
    error: {
      code: 'not_authenticated',
      message:
        'settings hold every credential this household owns and Canvas has no administrator '
        + 'authentication yet, so this page answers loopback clients only',
    },
  });
}

/* ----------------------------------------------------------------- page -- */

async function sendSettingsPage(
  res: ServerResponse,
  ctx: SettingsContext,
  query: URLSearchParams,
): Promise<void> {
  const settings = await ctx.settings.read();
  const credentials = await ctx.credentials.describeAll();

  /* A test result arrives as a separate parameter, because it is the one
   * outcome whose words are produced by a provider rather than chosen from
   * the table above. It is capped and escaped - a provider that returned a
   * novel must not become a page. */
  const result = query.get('result');
  const failed = query.get('failed') === '1';
  const notice: Notice | null = result !== null
    ? {tone: failed ? 'problem' : 'ok', message: result.slice(0, 300)}
    : noticeFor(query.get('notice'));

  /* Candidate places survive the redirect as JSON in the query, because the
   * alternative is holding per-browser state on a server with no sessions.
   * Parsed through the same validator the store uses, so a crafted URL cannot
   * put an arbitrary object on the page. */
  let places: Location[] = [];
  const raw = query.get('places');
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        places = parsed.map((entry) => parseLocation(entry))
          .filter((entry): entry is Location => entry !== null)
          .slice(0, 8);
      }
    } catch {
      places = [];
    }
  }

  sendHtml(res, 200, renderSettingsPage({
    settings,
    credentials,
    notice,
    places,
    placeQuery: (query.get('place') ?? '').slice(0, 120),
  }));
}

/* --------------------------------------------------------------- actions -- */

async function handleBlocks(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const checked = new Set(form.getAll('block').filter((type) => isKnownBlockType(type)));
  const current = await ctx.settings.read();

  /* A CHECKBOX THAT IS OFF SENDS NOTHING, so "absent means off" is the only
   * correct reading of an HTML form - but only for the types this FORM
   * offers. The built-in form must not switch every experiment off as a side
   * effect of saving Blocks, and vice versa, so each form states its own
   * scope. */
  const scope = ALL_BLOCK_TYPES.filter((type) => !EXPERIMENTAL_BLOCK_TYPES.includes(type));
  const blocks: Record<string, boolean> = {...current.blocks};
  for (const type of scope) blocks[type] = checked.has(type);

  await ctx.settings.patch({blocks});
  redirect(res, 'blocks_saved');
}

async function handleExperimental(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const checked = new Set(form.getAll('block').filter((type) => isKnownBlockType(type)));
  const current = await ctx.settings.read();
  const blocks: Record<string, boolean> = {...current.blocks};
  for (const type of EXPERIMENTAL_BLOCK_TYPES) blocks[type] = checked.has(type);
  await ctx.settings.patch({
    blocks,
    experimentalEnabled: form.get('experimentalEnabled') !== null,
  });
  redirect(res, 'experimental_saved');
}

async function handleWeather(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const providerId = form.get('providerId');
  if (providerId !== null && !isWeatherProviderId(providerId)) {
    return redirect(res, 'provider_unknown');
  }
  const units = form.get('units');
  await ctx.settings.patch({
    weather: {
      ...(providerId === null ? {} : {providerId}),
      ...(units === 'metric' || units === 'imperial' ? {units} : {}),
    },
  });
  redirect(res, 'weather_saved');
}

async function handleProviderOptions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const providerId = form.get('providerId');
  if (!isWeatherProviderId(providerId)) return redirect(res, 'provider_unknown');

  const current = await ctx.settings.read();
  const options: Record<string, string> = {...(current.weather.options[providerId] ?? {})};
  for (const [key, value] of form.entries()) {
    if (key === 'providerId') continue;
    options[key] = value;
  }
  await ctx.settings.patch({
    weather: {options: {...current.weather.options, [providerId]: options}},
  });
  redirect(res, 'options_saved');
}

async function handleContact(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  await ctx.settings.patch({contact: form.get('contact') ?? ''});
  redirect(res, 'contact_saved');
}

async function handleLocationSearch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const place = (form.get('place') ?? '').trim().slice(0, 120);
  if (place === '') return redirect(res, 'location_invalid');

  let places: readonly Location[] = [];
  try {
    places = await (ctx.geocode ?? geocode)(place, {count: 5});
  } catch {
    /* The cause is not shown: it is a network error carrying a URL, and the
     * useful thing to tell a household is that the lookup did not work. */
    return redirect(res, 'location_none', {place});
  }
  if (places.length === 0) return redirect(res, 'location_none', {place});
  redirect(res, '', {place, places: JSON.stringify(places)});
}

async function handleLocationChoose(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const raw = form.get('place');
  if (raw === null) return redirect(res, 'location_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redirect(res, 'location_invalid');
  }
  const location = parseLocation(parsed);
  if (location === null) return redirect(res, 'location_invalid');
  await ctx.settings.patch({location});
  redirect(res, 'location_saved');
}

/* THE WRITE-ONLY CREDENTIAL ROUTES.
 *
 * Note what is missing: there is no GET here that returns a value, and the
 * failure paths redirect with a CODE rather than a message, so there is no
 * path by which a submitted value can be reflected back into a page. A
 * settings page that echoes a rejected token into an error box has published
 * it to the browser history and to any proxy in between. */
async function handleCredentialSet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  const id = form.get('id') ?? '';
  const value = form.get('value') ?? '';
  if (value.trim() === '') return redirect(res, 'credential_empty');
  const saved = await ctx.credentials.set(id, value);
  /* The failure code, never the value and never the message from the store
   * (which names the field only, but this keeps the rule absolute). */
  redirect(res, saved.ok ? 'credential_saved' : 'credential_unknown');
}

async function handleCredentialClear(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
): Promise<void> {
  const form = await readForm(req);
  if (form === null) return redirect(res, 'not_saved');
  await ctx.credentials.clear(form.get('id') ?? '');
  redirect(res, 'credential_cleared');
}

/* THE TEST ENDPOINT, AND WHY IT RETURNS A TEMPERATURE.
 *
 * A green tick proves a handshake. A temperature proves the whole path: the
 * credential resolved, the request was accepted, the response parsed, and the
 * mapping into a WeatherReading worked - which is the thing that will be on
 * the wall. So the success sentence is "Connected — 14 °C in Boulder, from
 * Open-Meteo" and not "OK".
 *
 * THE FAILURE NEVER ECHOES THE CREDENTIAL. `WeatherSource` narrows every
 * throw to a `ProviderError` whose message is written for a household and
 * contains no token, no URL and no upstream body; anything that is not one is
 * replaced entirely rather than stringified. */
async function handleTest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
  wantsJson: boolean,
  providerIdFromPath: string | null,
): Promise<void> {
  const form = providerIdFromPath === null ? await readForm(req) : null;
  const providerId = providerIdFromPath ?? form?.get('providerId') ?? '';
  const provider = weatherProvider(providerId);
  if (provider === null) {
    if (wantsJson) {
      return sendJson(res, 404, {error: {code: 'unknown_provider', message: 'no integration by that id'}});
    }
    return redirect(res, 'provider_unknown');
  }
  if (ctx.weather === undefined) {
    if (wantsJson) {
      return sendJson(res, 503, {
        error: {code: 'test_unavailable', message: 'this server was built without a weather source'},
      });
    }
    return redirect(res, 'test_unavailable');
  }

  try {
    const result = await ctx.weather.test(provider);
    const message = connectedSentence(result);
    if (wantsJson) {
      return sendJson(res, 200, {
        ok: true,
        providerId: provider.id,
        message,
        reading: {
          temperature: result.reading.temperature,
          unit: result.reading.unit,
          state: result.reading.state,
          place: result.reading.place ?? null,
        },
      });
    }
    redirect(res, '', {result: message});
  } catch (cause) {
    /* Belt and braces: WeatherSource already normalises, and anything that
     * still is not a ProviderError becomes a fixed sentence rather than a
     * stringified unknown. */
    const message = cause instanceof ProviderError
      ? cause.message
      : `${provider.label} could not be reached.`;
    const code = cause instanceof ProviderError ? cause.code : 'unreachable';
    if (wantsJson) {
      return sendJson(res, 200, {ok: false, providerId: provider.id, code, message});
    }
    redirect(res, '', {result: message, failed: '1'});
  }
}

/* ------------------------------------------------------------------ route -- */

/** Returns true when this module owned the request and has answered it. */
export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SettingsContext,
  urlPath: string,
): Promise<boolean> {
  const owned =
    urlPath === SETTINGS_PATH
    || urlPath.startsWith(`${SETTINGS_PATH}/`)
    || urlPath === SETTINGS_API_PATH
    || urlPath === CREDENTIALS_API_PATH
    || urlPath.startsWith(`${CREDENTIALS_API_PATH}/`)
    || urlPath.startsWith('/api/integrations/');
  if (!owned) return false;

  /* THE GATE, BEFORE ANYTHING ELSE IS READ - including the body. A refused
   * peer must not be able to make this process allocate for its payload. */
  if (!settingsReachable(ctx.config, req.socket.remoteAddress)) {
    forbidden(res);
    return true;
  }

  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  const method = req.method ?? 'GET';

  /* ---- the page ---- */
  if (urlPath === SETTINGS_PATH) {
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: GET, HEAD'}});
      return true;
    }
    if (method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end();
      return true;
    }
    await sendSettingsPage(res, ctx, query);
    return true;
  }

  /* ---- the form actions ---- */
  const form: Record<string, (r: IncomingMessage, s: ServerResponse, c: SettingsContext) => Promise<void>> = {
    [`${SETTINGS_PATH}/blocks`]: handleBlocks,
    [`${SETTINGS_PATH}/experimental`]: handleExperimental,
    [`${SETTINGS_PATH}/weather`]: handleWeather,
    [`${SETTINGS_PATH}/provider-options`]: handleProviderOptions,
    [`${SETTINGS_PATH}/contact`]: handleContact,
    [`${SETTINGS_PATH}/location`]: handleLocationSearch,
    [`${SETTINGS_PATH}/location/choose`]: handleLocationChoose,
    [`${SETTINGS_PATH}/credential`]: handleCredentialSet,
    [`${SETTINGS_PATH}/credential/clear`]: handleCredentialClear,
  };
  const action = form[urlPath];
  if (action !== undefined) {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: POST'}});
      return true;
    }
    await action(req, res, ctx);
    return true;
  }

  if (urlPath === `${SETTINGS_PATH}/test`) {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: POST'}});
      return true;
    }
    await handleTest(req, res, ctx, false, null);
    return true;
  }

  /* ---- POST /api/integrations/:id/test ---- */
  const integration = /^\/api\/integrations\/([^/]+)\/test$/.exec(urlPath);
  if (integration !== null) {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: POST'}});
      return true;
    }
    let id: string | null = null;
    try {
      id = decodeURIComponent(integration[1]!);
    } catch {
      id = null;
    }
    await handleTest(req, res, ctx, true, id);
    return true;
  }

  /* ---- /api/settings ---- */
  if (urlPath === SETTINGS_API_PATH) {
    if (method === 'GET') {
      /* Nothing in Settings is secret - that is the whole reason credentials
       * live in a different file - so the stored shape is the response
       * shape, and the tests assert that rather than trusting it. */
      sendJson(res, 200, {settings: await ctx.settings.read()});
      return true;
    }
    if (method === 'PUT' || method === 'PATCH') {
      const value = await readJsonBody(req);
      if (value === undefined) {
        sendJson(res, 400, {error: {code: 'unreadable_body', message: 'the request body could not be read'}});
        return true;
      }
      const next = method === 'PUT'
        ? await ctx.settings.write(value)
        : await ctx.settings.patch(value);
      sendJson(res, 200, {settings: next});
      return true;
    }
    res.setHeader('Allow', 'GET, PUT, PATCH');
    sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: GET, PUT, PATCH'}});
    return true;
  }

  /* ---- /api/credentials[/:id] ----
   *
   * GET answers `{configured, hint, source}` and there is NO branch anywhere
   * below that can reach a value. PUT sets, DELETE clears. */
  if (urlPath === CREDENTIALS_API_PATH) {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: GET'}});
      return true;
    }
    sendJson(res, 200, {credentials: await ctx.credentials.describeAll()});
    return true;
  }

  if (urlPath.startsWith(`${CREDENTIALS_API_PATH}/`)) {
    let id: string | null = null;
    try {
      id = decodeURIComponent(urlPath.slice(`${CREDENTIALS_API_PATH}/`.length));
    } catch {
      id = null;
    }
    if (id === null || id === '' || id.includes('/')) {
      sendJson(res, 404, {error: {code: 'not_found', message: 'no credential by that name'}});
      return true;
    }

    if (method === 'GET') {
      sendJson(res, 200, {credential: await ctx.credentials.describe(id)});
      return true;
    }
    if (method === 'PUT') {
      const body = await readForm(req);
      const value = body?.get('value') ?? null;
      const saved = await ctx.credentials.set(id, value);
      if (!saved.ok) {
        sendJson(res, saved.code === 'unknown_credential' ? 404 : 422, {
          error: {code: saved.code, message: saved.message},
        });
        return true;
      }
      /* The DESCRIPTION, which by construction cannot carry a value. */
      sendJson(res, 200, {credential: saved.description});
      return true;
    }
    if (method === 'DELETE') {
      sendJson(res, 200, {credential: await ctx.credentials.clear(id)});
      return true;
    }
    res.setHeader('Allow', 'GET, PUT, DELETE');
    sendJson(res, 405, {error: {code: 'method_not_allowed', message: 'allowed: GET, PUT, DELETE'}});
    return true;
  }

  /* A path under /settings/ that no action claims. A plain 404 page rather
   * than the settings page, so a typo is visible. */
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset="utf-8"><title>Not found</title><p>${escapeHtml('No such settings page.')}\n`);
  return true;
}
