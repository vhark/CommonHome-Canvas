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
/* Configuration, resolved once from the environment.
 *
 * Everything a household must change to run Canvas lives here, so a deployment
 * is `docker run -e ...` rather than a source edit. Three rules hold this
 * together and each one has bitten a self-hosted project before:
 *
 * 1. NO HOUSEHOLD VALUE IS A CONSTANT IN SOURCE. This file previously carried
 *    a LAN address, a VPN address, a calendar entity and a person entity as
 *    literals. Those are one household's facts; publishing them is both a
 *    privacy leak and an instant non-starter for anyone else.
 *
 * 2. EVERY INTEGRATION IS OPTIONAL. Canvas with no Home Assistant and no
 *    photo key must still boot and render. An integration that is mandatory
 *    to start is an integration that makes the project undeployable for most
 *    people, and the ambient screen already degrades gracefully by design.
 *
 * 3. SECRETS ARE READ HERE AND NEVER SHAPED INTO A RESPONSE. The browser gets
 *    shaped data; tokens stay in this process.
 */

import {createHash} from 'node:crypto';

export type HomeAssistantConfig = {
  readonly url: string;
  readonly token: string;
  readonly weatherEntity: string | null;
  readonly calendarEntity: string | null;
  readonly personEntities: readonly string[];
};

export type PhotoConfig = {
  readonly accessKey: string;
  readonly topicId: string;
  readonly appName: string;
};

export type CanvasConfig = {
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string | null;
  readonly dataDir: string;
  readonly allowedHosts: readonly string[];
  /* Escape hatch for the unauthenticated canvas API. See `apiAllowRemote`
   * below and the header comment in api.ts. */
  readonly apiAllowRemote: boolean;
  readonly homeAssistant: HomeAssistantConfig | null;
  readonly photos: PhotoConfig | null;
  readonly analytics: 'on' | 'off';
  readonly locale: string;
  readonly timeZone: string | null;
  /* Subscribed ICS calendars, keyed by opaque id.
   *
   * Each entry's `url` is a BEARER CREDENTIAL - a calendar share link grants
   * permanent read of that calendar to whoever holds it - so sources live
   * here, server-side, and the browser only ever names an id. */
  readonly calendars: readonly CalendarSourceConfig[];
  /* How often a paired display re-checks its manifest, in seconds. Jitter is
   * applied by the client on top of this, so six screens started by one power
   * cut do not poll in lockstep. */
  readonly screenPollSeconds: number;
};

/* One subscribed calendar. Mirrors CalendarSource in calendar.ts; declared
 * here so config.ts does not import the server's calendar module. */
export type CalendarSourceConfig = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly level: 'private' | 'shared';
  readonly showTitles: boolean;
  readonly refreshMs: number;
};

export type ConfigProblem = {readonly key: string; readonly message: string};

/* Parsed rather than trusted: an env var is a string from outside the program.
 * A bad port should say so at startup, not surface later as a listen error. */
function port(raw: string | undefined, fallback: number, problems: ConfigProblem[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push({key: 'CANVAS_PORT', message: `not a valid port: ${raw}`});
    return fallback;
  }
  return n;
}

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/* A base URL is how Canvas generates absolute links - share URLs, a QR code
 * for a tablet, the address to read out for a TV. A service that only ever
 * receives requests cannot work this out reliably behind a reverse proxy,
 * which is why it is configured rather than inferred from the Host header
 * (an attacker-controlled value that has produced real poisoning bugs). */
function baseUrl(raw: string | undefined, problems: ConfigProblem[]): string | null {
  if (!raw || raw.trim() === '') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      problems.push({key: 'CANVAS_BASE_URL', message: `must be http or https: ${raw}`});
      return null;
    }
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    problems.push({key: 'CANVAS_BASE_URL', message: `not a valid URL: ${raw}`});
    return null;
  }
}

/* Host allowlist. Loopback is always permitted so a fresh container is
 * reachable for a health check before anything is configured. The configured
 * base URL's host is included automatically, because requiring someone to
 * state their own domain twice is a trap that produces a confusing 403. */
function allowedHosts(raw: string | undefined, base: string | null): string[] {
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const h of list(raw)) hosts.add(h);
  if (base) {
    try {
      hosts.add(new URL(base).host);
      hosts.add(new URL(base).hostname);
    } catch {
      /* base was validated above; unreachable in practice */
    }
  }
  return [...hosts];
}

function homeAssistant(env: NodeJS.ProcessEnv, problems: ConfigProblem[]): HomeAssistantConfig | null {
  const url = env.HOMEASSISTANT_URL ?? env.HA_URL ?? '';
  const token = env.HOMEASSISTANT_TOKEN ?? env.HA_TOKEN ?? '';
  if (!url && !token) return null;

  /* Half-configured is a mistake worth naming. Silently disabling the
   * integration when someone set the URL but forgot the token produces a
   * blank display and no explanation. */
  if (!url || !token) {
    problems.push({
      key: 'HOMEASSISTANT_URL/HOMEASSISTANT_TOKEN',
      message: 'both are required to enable Home Assistant; integration disabled',
    });
    return null;
  }
  return {
    url: url.replace(/\/$/, ''),
    token,
    /* Entity ids are household-specific with no sensible default: the
     * weather entity is named after someone's home. Unset means the ambient
     * screen simply omits that element, which it already handles. */
    weatherEntity: env.CANVAS_WEATHER_ENTITY?.trim() || null,
    calendarEntity: env.CANVAS_CALENDAR_ENTITY?.trim() || null,
    personEntities: list(env.CANVAS_PERSON_ENTITIES),
  };
}

function photos(env: NodeJS.ProcessEnv): PhotoConfig | null {
  const accessKey = env.UNSPLASH_ACCESS_KEY ?? '';
  if (!accessKey) return null;
  return {
    accessKey,
    /* Default topic is a wallpaper collection: calm landscapes suited to a
     * wall display. Overridable because one household's idea of calm is
     * another's idea of dull. */
    topicId: env.CANVAS_PHOTO_TOPIC?.trim() || 'bo8jQKTaE0Y',
    /* Identifies the application in the photo provider's required UTM
     * parameters. Part of the attribution obligation, not branding. */
    appName: env.CANVAS_APP_NAME?.trim() || 'commonhome_canvas',
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  config: CanvasConfig;
  problems: readonly ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  const base = baseUrl(env.CANVAS_BASE_URL, problems);

  const analyticsRaw = (env.CANVAS_ANALYTICS ?? 'on').trim().toLowerCase();
  if (analyticsRaw !== 'on' && analyticsRaw !== 'off') {
    problems.push({key: 'CANVAS_ANALYTICS', message: `expected on or off, got: ${analyticsRaw}`});
  }

  /* The canvas API has no authentication yet, so remote access to it is opt
   * in by an explicitly named variable rather than implied by a bind address.
   * Anything but a literal `true` is off: a typo must fail closed. */
  const apiAllowRemoteRaw = (env.CANVAS_API_ALLOW_REMOTE ?? '').trim().toLowerCase();
  if (apiAllowRemoteRaw !== '' && apiAllowRemoteRaw !== 'true' && apiAllowRemoteRaw !== 'false') {
    problems.push({
      key: 'CANVAS_API_ALLOW_REMOTE',
      message: `expected true or false, got: ${apiAllowRemoteRaw}; treating as false`,
    });
  }

  return {
    config: {
      port: port(env.CANVAS_PORT, 4174, problems),
      /* LOOPBACK BY DEFAULT, deliberately, and this is a reversal of the
       * earlier default.
       *
       * The server now carries a WRITE API (/api/canvases) that has no
       * authentication yet. A default that publishes an unauthenticated write
       * API to every interface is the kind of gap that ships by accident and
       * is only noticed from the outside, so the default is the safe one and
       * exposure is a stated choice.
       *
       * The container is unaffected: Dockerfile and docker-compose.yml both
       * set CANVAS_HOST=0.0.0.0 explicitly, because an ambient display nobody
       * can reach from a tablet is not a product. That is exactly the right
       * shape - a deployment that intends to be reachable says so, and a bare
       * `node src/server/main.ts` on a laptop or a shared box does not
       * silently become one.
       *
       * The bind address is NOT what protects the API. Because the container
       * legitimately binds 0.0.0.0, api.ts independently refuses non-loopback
       * peers on every API route regardless of how the socket is bound; this
       * default is the second layer, not the only one. */
      host: env.CANVAS_HOST?.trim() || '127.0.0.1',
      baseUrl: base,
      dataDir: env.CANVAS_DATA_DIR?.trim() || '/data',
      allowedHosts: allowedHosts(env.CANVAS_ALLOWED_HOSTS, base),
      apiAllowRemote: apiAllowRemoteRaw === 'true',
      homeAssistant: homeAssistant(env, problems),
      photos: photos(env),
      analytics: analyticsRaw === 'off' ? 'off' : 'on',
      locale: env.CANVAS_LOCALE?.trim() || 'en-US',
      /* Null means "use the host's zone", which is right for a container that
       * has been given the host's /etc/localtime. */
      timeZone: env.CANVAS_TIMEZONE?.trim() || null,
      calendars: calendars(env, problems),
      screenPollSeconds: screenPollSeconds(env.CANVAS_SCREEN_POLL_SECONDS, problems),
    },
    problems,
  };
}

/* Subscribed ICS calendars from the environment.
 *
 * Numbered slots (CANVAS_CALENDAR_1_URL, _2_URL, ...) rather than one
 * delimited value, because a calendar URL legitimately contains the
 * characters any delimiter would use, and a household should not have to
 * escape its own share link.
 *
 * The id is derived by hashing the URL, never by exposing it: it must be
 * stable across restarts so a saved canvas keeps working, and opaque so the
 * id cannot be turned back into the credential. Truncated to 16 hex chars -
 * enough that ids do not collide in a household, short enough to read. */
function calendars(
  env: NodeJS.ProcessEnv,
  problems: ConfigProblem[],
): CalendarSourceConfig[] {
  const out: CalendarSourceConfig[] = [];
  for (let i = 1; i <= 16; i++) {
    const url = env[`CANVAS_CALENDAR_${i}_URL`]?.trim();
    if (!url) continue;

    /* Refuse plaintext http for a bearer credential. webcal:// is accepted
     * because it is literally what Apple and Outlook hand a user; it is https
     * underneath. */
    const scheme = url.split(':', 1)[0].toLowerCase();
    if (scheme !== 'https' && scheme !== 'webcal') {
      /* The message must not quote the value: the value IS the credential,
       * and this string goes to the startup banner and the logs. */
      problems.push({
        key: `CANVAS_CALENDAR_${i}_URL`,
        message: `must be https:// or webcal:// (a calendar link is a credential); got ${scheme}://`,
      });
      continue;
    }

    const levelRaw = (env[`CANVAS_CALENDAR_${i}_LEVEL`] ?? '').trim().toLowerCase();
    if (levelRaw !== '' && levelRaw !== 'private' && levelRaw !== 'shared') {
      problems.push({
        key: `CANVAS_CALENDAR_${i}_LEVEL`,
        message: `expected private or shared, got: ${levelRaw}; treating as private`,
      });
    }

    const titlesRaw = (env[`CANVAS_CALENDAR_${i}_TITLES`] ?? '').trim().toLowerCase();
    if (titlesRaw !== '' && titlesRaw !== 'true' && titlesRaw !== 'false') {
      problems.push({
        key: `CANVAS_CALENDAR_${i}_TITLES`,
        message: `expected true or false, got: ${titlesRaw}; treating as false`,
      });
    }

    const refreshRaw = (env[`CANVAS_CALENDAR_${i}_REFRESH`] ?? '').trim();
    let refreshMs = 900_000;
    if (refreshRaw !== '') {
      const n = Number(refreshRaw);
      /* A 5-second poll against someone else's public feed is how a household
       * gets rate limited, so the floor is enforced rather than suggested. */
      if (!Number.isFinite(n) || n < 60) {
        problems.push({
          key: `CANVAS_CALENDAR_${i}_REFRESH`,
          message: `expected seconds >= 60, got: ${refreshRaw}; using 900`,
        });
      } else {
        refreshMs = Math.round(n) * 1000;
      }
    }

    out.push({
      id: createHash('sha256').update(url).digest('hex').slice(0, 16),
      label: env[`CANVAS_CALENDAR_${i}_LABEL`]?.trim() || `Calendar ${i}`,
      url,
      /* Default private: the safe level is the one you get by saying nothing. */
      level: levelRaw === 'shared' ? 'shared' : 'private',
      showTitles: titlesRaw === 'true',
      refreshMs,
    });
  }
  return out;
}

/* How often a paired display re-checks its manifest.
 *
 * The bounds are enforced rather than suggested, in both directions and for
 * different reasons. A one-second floor would be a household of six screens
 * running a self-inflicted load test against their own server; a day-long
 * ceiling would mean an edit made at breakfast appears at bedtime, which is
 * not "edit once, all screens update" in any useful sense. A bad value is a
 * named problem in the startup banner and the default, never a silent
 * clamp. */
function screenPollSeconds(raw: string | undefined, problems: ConfigProblem[]): number {
  if (raw === undefined || raw.trim() === '') return SCREEN_POLL_DEFAULT_SECONDS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < SCREEN_POLL_MIN_SECONDS || n > SCREEN_POLL_MAX_SECONDS) {
    problems.push({
      key: 'CANVAS_SCREEN_POLL_SECONDS',
      message:
        `expected ${SCREEN_POLL_MIN_SECONDS}-${SCREEN_POLL_MAX_SECONDS} seconds, got: ${raw}; ` +
        `using ${SCREEN_POLL_DEFAULT_SECONDS}`,
    });
    return SCREEN_POLL_DEFAULT_SECONDS;
  }
  return Math.round(n);
}

/* Restated here rather than imported from screens.ts, because config.ts
 * deliberately imports nothing from the server's own modules: it is the thing
 * everything else is configured BY, and a cycle through it is how a config
 * module ends up half-initialised at import time. The dependency runs the
 * other way - screens.ts imports these - so there is exactly one definition
 * and no agreement to maintain. */
export const SCREEN_POLL_DEFAULT_SECONDS = 60;
export const SCREEN_POLL_MIN_SECONDS = 5;
export const SCREEN_POLL_MAX_SECONDS = 3600;

/* Describes what is enabled without ever revealing a secret's value, for the
 * startup banner and a health endpoint. Reporting a token's presence is
 * useful; reporting its value is how credentials end up in logs. */
export function describeConfig(config: CanvasConfig): Record<string, string> {
  return {
    port: String(config.port),
    host: config.host,
    baseUrl: config.baseUrl ?? '(not set - absolute links disabled)',
    dataDir: config.dataDir,
    /* Labels and count only. The URLs are credentials and never appear in
     * the banner, /healthz, or any log line. */
    calendars:
      config.calendars.length === 0
        ? '(none)'
        : config.calendars.map((c) => `${c.label} [${c.level}]`).join(', '),
    allowedHosts: config.allowedHosts.join(', '),
    /* Stated in the banner and on /healthz because it is the one setting
     * whose wrong value is invisible from the machine running the server. */
    canvasApi: config.apiAllowRemote
      ? 'UNAUTHENTICATED and reachable from the network (CANVAS_API_ALLOW_REMOTE=true)'
      : 'unauthenticated, loopback-only',
    homeAssistant: config.homeAssistant
      ? `enabled (${config.homeAssistant.url}, token set)`
      : 'disabled',
    weatherEntity: config.homeAssistant?.weatherEntity ?? '(none)',
    calendarEntity: config.homeAssistant?.calendarEntity ?? '(none)',
    personEntities: config.homeAssistant?.personEntities.length
      ? String(config.homeAssistant.personEntities.length) + ' configured'
      : '(none)',
    photos: config.photos ? 'enabled (key set)' : 'disabled',
    analytics: config.analytics,
    screenPoll: `${config.screenPollSeconds}s (+/- jitter)`,
    locale: config.locale,
    timeZone: config.timeZone ?? '(host default)',
  };
}
