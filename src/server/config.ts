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
  readonly homeAssistant: HomeAssistantConfig | null;
  readonly photos: PhotoConfig | null;
  readonly analytics: 'on' | 'off';
  readonly locale: string;
  readonly timeZone: string | null;
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

  return {
    config: {
      port: port(env.CANVAS_PORT, 4174, problems),
      /* Binds all interfaces by default because the normal deployment is a
       * container, where loopback-only would make it unreachable. The host
       * allowlist, not the bind address, is what limits who may talk to it. */
      host: env.CANVAS_HOST?.trim() || '0.0.0.0',
      baseUrl: base,
      dataDir: env.CANVAS_DATA_DIR?.trim() || '/data',
      allowedHosts: allowedHosts(env.CANVAS_ALLOWED_HOSTS, base),
      homeAssistant: homeAssistant(env, problems),
      photos: photos(env),
      analytics: analyticsRaw === 'off' ? 'off' : 'on',
      locale: env.CANVAS_LOCALE?.trim() || 'en-US',
      /* Null means "use the host's zone", which is right for a container that
       * has been given the host's /etc/localtime. */
      timeZone: env.CANVAS_TIMEZONE?.trim() || null,
    },
    problems,
  };
}

/* Describes what is enabled without ever revealing a secret's value, for the
 * startup banner and a health endpoint. Reporting a token's presence is
 * useful; reporting its value is how credentials end up in logs. */
export function describeConfig(config: CanvasConfig): Record<string, string> {
  return {
    port: String(config.port),
    host: config.host,
    baseUrl: config.baseUrl ?? '(not set - absolute links disabled)',
    dataDir: config.dataDir,
    allowedHosts: config.allowedHosts.join(', '),
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
    locale: config.locale,
    timeZone: config.timeZone ?? '(host default)',
  };
}
