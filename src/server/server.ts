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
/* The Canvas display server.
 *
 * This is the process a container runs. It replaces the Vite dev server that
 * previously carried this logic, for three reasons that matter to a household
 * appliance: a dev server is not a supported production artifact, it needs the
 * whole build toolchain resident in the image, and it holds a websocket the
 * wall screen never reads.
 *
 * Deliberately built on `node:http` alone. Canvas has ZERO runtime
 * dependencies, which is what lets the runtime image ship without node_modules
 * and makes the supply chain for a screen in someone's kitchen inspectable in
 * an afternoon. A framework here would buy routing we do not need at the cost
 * of that property.
 */

import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describeConfig, type CanvasConfig} from './config.ts';
import {apiReachable, handleCanvasRoutes, handleScreenRoutes} from './api.ts';
import {AccessStore} from './access.ts';
import {CredentialStore} from './credentials.ts';
import {handleDisplayRoutes} from './display.ts';
import {ScreenStore} from './screens.ts';
import {handleShareRoutes} from './share.ts';
import {describeSettings, SettingsStore} from './settings.ts';
import {handleSettingsRoutes, SETTINGS_PATH} from './settings-routes.ts';
import {WeatherSource} from './weather-source.ts';
import {CanvasStore} from './store.ts';
import {emptySnapshot, SnapshotSource, type Snapshot} from './snapshot.ts';
import {CalendarFetcher, type CalendarSource} from './calendar.ts';
import {FeedCache} from './feeds.ts';
import {handleCalendarRequest} from './calendar-route.ts';
import {CANVAS_STYLESHEET, CANVAS_STYLESHEET_PATH} from '../render/index.ts';

/* The built ambient bundle, emitted by `npm run build:ambient`. Resolved
 * relative to this module so the same path works in a checkout and in the
 * container image, which preserve the same src/server <-> dist/ambient
 * relationship. */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../dist/ambient', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export type ServerOptions = {
  readonly config: CanvasConfig;
  /* Overridable so tests can point at a fixture directory instead of needing
   * a build to have run. */
  readonly staticDir?: string;
  readonly snapshotSource?: {snapshot(): Promise<Snapshot>};
  /* Overridable so a test can point the store at a temp directory without
   * going through CANVAS_DATA_DIR. */
  readonly store?: CanvasStore;
  readonly access?: AccessStore;
  readonly screens?: ScreenStore;
  /* Settings and credentials, overridable for the same reason as the store:
   * a test points them at a temp directory without going through
   * CANVAS_DATA_DIR. */
  readonly settings?: SettingsStore;
  readonly credentials?: CredentialStore;
  /* The shared refresh loops. Injectable so a test can drive them by hand
   * instead of by a timer, and OPTIONAL so a caller that only exercises
   * routing gets a server with no live data rather than one that starts
   * reaching for a network. */
  readonly feeds?: FeedCache;
  /* Off by default. A refresh loop is a side effect on a shared network, and
   * a module that starts one merely by being constructed is a module every
   * test in the suite quietly rate-limits someone's provider with.
   * `startCanvasServer` turns it on; `createCanvasServer` does not. */
  readonly startFeeds?: boolean;
  readonly log?: (line: string) => void;
};

/* Security headers for a display that may render a photo from a third party
 * and nothing else. No inline-script exception is needed: the ambient bundle
 * is an external module. `img-src` allows https so photo providers work
 * without naming one in source. */
function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' https: data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; '),
  );
}

/* Host header check.
 *
 * The Host header is attacker-controlled, so it is compared against an
 * allowlist rather than used to build anything. The port is stripped because a
 * household reaches the screen on :4174 directly and through a proxy on :443,
 * and making someone enumerate ports produces a baffling 403. */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  /* IPv6 literals are bracketed: [::1]:4174 -> [::1] */
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return allowed.some((a) => {
    const candidate = a.trim().toLowerCase();
    const bare = candidate.startsWith('[')
      ? candidate.slice(0, candidate.indexOf(']') + 1)
      : candidate.split(':')[0];
    return bare === host || candidate === raw;
  });
}

/* Maps a request path to a file inside the static root, or null if it escapes.
 *
 * Containment is verified on the RESOLVED path rather than by scrubbing `..`
 * from the input, because scrubbing is defeated by encoding and by the many
 * ways a path can be spelled. Resolve first, then ask whether the answer is
 * still inside the root - that question has no false negatives. */
export function resolveStaticPath(urlPath: string, root: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  /* A NUL byte can truncate a path in downstream C code; reject outright. */
  if (decoded.includes('\0')) return null;

  const rootResolved = resolve(root);
  const requested = decoded === '/' || decoded === '' ? '/ambient.html' : decoded;
  const candidate = resolve(join(rootResolved, '.' + (requested.startsWith('/') ? requested : '/' + requested)));

  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
  return candidate;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createCanvasServer(options: ServerOptions): Server {
  const {config} = options;
  const staticDir = resolve(options.staticDir ?? DEFAULT_STATIC_DIR);
  const source = options.snapshotSource ?? new SnapshotSource(config);
  const store = options.store ?? new CanvasStore(config.dataDir);
  /* Derived from the STORE's own directory rather than from config.dataDir,
   * so an injected store (a test, or anything pointing at a different root)
   * gets its credentials in the same data root as its canvases. Two halves of
   * one canvas living under two roots is how a "revoked" token survives. */
  const access = options.access ?? new AccessStore(resolve(store.directory, '..'));
  /* Same derivation, same reason: an injected store's screens must live in
   * the same data root as its canvases, or a "deleted" screen survives in a
   * directory nobody is looking at. */
  const screens = options.screens ?? new ScreenStore(resolve(store.directory, '..'));
  /* Same derivation again: settings and credentials belong in the same data
   * root as the canvases they configure. */
  const dataRoot = resolve(store.directory, '..');
  const settings = options.settings ?? new SettingsStore(dataRoot, {log: options.log});
  const credentials = options.credentials ?? new CredentialStore(dataRoot, {log: options.log});

  /* THE WEATHER SOURCE IS BUILT UNCONDITIONALLY.
   *
   * Not "if Home Assistant is configured", not "if an entity id is set" -
   * unconditionally, because the default provider needs no credential and no
   * account. This is the single call site that turns the whole inversion on:
   * a household with an empty data directory and no environment gets a real
   * temperature as soon as it has named a place. */
  const weather = new WeatherSource({config, settings, credentials});

  /* Calendar sources, keyed by the opaque id the browser is allowed to name.
   * The credential-bearing URL stays in this map, in this process. */
  const calendarFetcher = new CalendarFetcher({displayZone: config.timeZone});
  const calendarSources = new Map<string, CalendarSource>(
    config.calendars.map((c) => [c.id, c as CalendarSource]),
  );

  /* ONE FEED CACHE PER SERVER, built here and shared by `/d/`, `/s/` and
   * `/c/`. Not one per request, not one per screen: that is the whole point.
   * See the header of feeds.ts for what happens without it. */
  const feeds = options.feeds ?? new FeedCache({config, weatherSource: weather, log: options.log});
  if (options.startFeeds === true) feeds.start();

  const startedAt = Date.now();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res);

    const urlPath = (req.url ?? '/').split('?')[0];

    if (!hostAllowed(req.headers.host, config.allowedHosts)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Host not permitted.\n');
    }

    /* GET /api/calendar/:id - shaped events for one configured source.
     *
     * The level is decided HERE, by the route, and never read from the
     * request: a viewer arriving over a shared link must not be able to ask
     * for the private shaping. Until share tokens exist, only loopback
     * callers reach this at all, and they get the source's own level. */
    if (urlPath.startsWith('/api/calendar/')) {
      if (!apiReachable(config, req.socket.remoteAddress)) {
        return json(res, 403, {error: 'not available from this address'});
      }
      const sourceId = urlPath.slice('/api/calendar/'.length);
      const source = calendarSources.get(sourceId);
      const result = await handleCalendarRequest(calendarFetcher, calendarSources, {
        sourceId,
        level: source?.level ?? 'shared',
      });
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      res.statusCode = result.status;
      return res.end(JSON.stringify(result.body));
    }

    /* Before the read-only gate below, because these are the only routes that
     * legitimately write. Any throw is turned into a 500 with no detail: a
     * stack trace in a response body names paths and module layout.
     *
     * `/s/` is dispatched here too and is the ONE route that is NOT behind the
     * loopback gate - that is the entire point of a share link. Its own
     * enforcement (token, then passphrase, then session) happens inside
     * handleShareRoutes and strictly before any canvas is read.
     *
     * `/d/` is the second such route, and deliberately so: a paired display
     * is not on loopback and must never be asked for anything. Its token is
     * resolved against the SCREEN store only - the two token namespaces never
     * cross-resolve, so a share token is not a display credential and a
     * screen token is not a share link. */
    try {
      if (await handleSettingsRoutes(req, res, {config, settings, credentials, weather}, urlPath)) return;
      if (await handleShareRoutes(req, res, {config, store, access, feeds, settings}, urlPath)) return;
      if (await handleDisplayRoutes(req, res, {config, store, screens, feeds, settings}, urlPath)) return;
      if (await handleScreenRoutes(req, res, {config, store, access, screens, feeds, settings}, urlPath)) return;
      if (await handleCanvasRoutes(req, res, {config, store, access, screens, feeds, settings}, urlPath)) return;
    } catch (cause) {
      (options.log ?? console.error)(`[canvas] api error on ${urlPath}: ${(cause as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      return res.end(JSON.stringify({error: {code: 'internal_error', message: 'the request could not be completed'}}));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      return res.end('GET required.\n');
    }

    /* Liveness must never depend on an integration. A container whose health
     * check fails because someone has no home automation server would be
     * restarted forever for a condition that is not an error. Reports only
     * what `describeConfig` is willing to say, which never includes a secret's
     * value. */
    if (urlPath === '/healthz') {
      return json(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        config: describeConfig(config),
        /* Names, intervals and success ages only. describeFeeds carries no
         * URL, no token, no entity id and no upstream message, by the same
         * discipline describeConfig follows. */
        feeds: feeds.describeFeeds(),
        /* The household's own choices. Nothing here is a secret - that is the
         * whole reason credentials live in a separate file - and the place
         * is reported BY NAME ONLY, never as coordinates. */
        settings: describeSettings(settings.current),
      });
    }

    /* The render stylesheet, on ONE fixed token-free path shared by `/d/`, `/s/`
     * and `/c/`. One cacheable file for a household of six screens rather than
     * six copies, and an external file rather than an inline <style> so the
     * global CSP can keep saying style-src 'self' - a page that needs the policy
     * loosened is a page that loosens it for the whole product.
     *
     * Above the loopback gate and outside every token namespace on purpose: it
     * carries no canvas data, so there is nothing on it to authorise, and a
     * display that could not fetch its stylesheet would show unstyled text. */
    if (urlPath === CANVAS_STYLESHEET_PATH) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Length', String(Buffer.byteLength(CANVAS_STYLESHEET)));
      /* Revalidated rather than immutable: the path is not content-hashed
       * because the server has no bundler to hash with. */
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      return res.end(req.method === 'HEAD' ? undefined : CANVAS_STYLESHEET);
    }

    if (urlPath === '/__ambient/snapshot') {
      try {
        return json(res, 200, await source.snapshot());
      } catch {
        /* Shape preserved on total failure so the client keeps rendering its
         * last known good snapshot instead of blanking. */
        return json(res, 503, emptySnapshot(['all']));
      }
    }

    const filePath = resolveStaticPath(urlPath, staticDir);
    if (filePath === null) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Forbidden.\n');
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');

      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', String(info.size));
      /* Hashed asset filenames are immutable; the HTML entry point must not be
       * cached or a wall screen keeps an old bundle until someone reboots it. */
      res.setHeader(
        'Cache-Control',
        /\/assets\//.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      if (req.method === 'HEAD') return res.end();

      const stream = createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      stream.pipe(res);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found.\n');
    }
  });
}

/* Starts listening and wires clean shutdown. A container stop sends SIGTERM;
 * without a handler Node exits non-zero after the grace period, which reads as
 * a crash in every orchestrator's logs. */
export async function startCanvasServer(options: ServerOptions): Promise<Server> {
  const log = options.log ?? ((line: string) => console.log(line));
  /* THE ONE PLACE THE REFRESH LOOPS ARE STARTED. A long-running server wants
   * them; a test constructing a server to check a 404 does not. */
  /* Constructed HERE rather than left to createCanvasServer, so shutdown has
   * a handle on the thing it must stop. A refresh loop that outlives its
   * server is a process that will not exit and a provider that keeps being
   * polled by a service nobody can reach. */

  /* Settings and credentials are LOADED BEFORE THE FIRST REFRESH, because the
   * first refresh reads them. Constructing the feed cache with an unloaded
   * settings store would make the first weather request use the defaults and
   * ignore the household's own provider choice for five minutes. */
  const dataRoot = options.store === undefined
    ? options.config.dataDir
    : resolve(options.store.directory, '..');
  const settings = options.settings ?? new SettingsStore(dataRoot, {log: options.log});
  const credentials = options.credentials ?? new CredentialStore(dataRoot, {log: options.log});
  try {
    await settings.init();
    await credentials.init();
  } catch (cause) {
    /* Not fatal, for the same reason an unwritable data directory is not:
     * the thing on the wall matters more than the ability to configure it,
     * and the defaults are a working product. */
    log(`[canvas] settings could not be loaded (${(cause as Error).message}); using defaults`);
  }

  const weather = new WeatherSource({config: options.config, settings, credentials});
  const feeds = options.feeds
    ?? new FeedCache({config: options.config, weatherSource: weather, log: options.log});
  const server = createCanvasServer({
    ...options,
    settings,
    credentials,
    feeds,
    startFeeds: options.startFeeds !== false,
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.config.port, options.config.host, () => {
      server.off('error', fail);
      ok();
    });
  });

  log('[canvas] CommonHome Canvas display server');
  for (const [key, value] of Object.entries(describeConfig(options.config))) {
    log(`[canvas]   ${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(feeds.describeFeeds())) {
    log(`[canvas]   feed ${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(describeSettings(settings.current))) {
    log(`[canvas]   setting ${key}: ${value}`);
  }
  log(`[canvas] listening on http://${options.config.host}:${options.config.port}`);

  /* Said at every start, in the place nobody can miss, because the whole
   * property depends on an operator knowing it. A warning buried in a README
   * protects nothing. */
  if (options.config.apiAllowRemote) {
    log('[canvas] WARNING: CANVAS_API_ALLOW_REMOTE=true - the canvas API accepts');
    log('[canvas]          requests from the network and HAS NO AUTHENTICATION.');
    log('[canvas]          Anyone who can reach this port can read, edit and delete');
    log('[canvas]          every canvas. Only correct behind your own authenticating proxy.');
  } else {
    log('[canvas] canvas API (/api/canvases, /c/:id): unauthenticated, so answered');
    log('[canvas]   for loopback clients only until authentication ships. The ambient');
    log('[canvas]   display and /healthz are unaffected and remain reachable.');
  }
  /* Said every time, because /s/ is the one route that deliberately answers a
   * stranger and an operator should know it exists before a link is sent. */
  log('[canvas] share links (/s/:token): reachable from the network by design;');
  log('[canvas]   a canvas is private until its access level is set explicitly.');
  /* Said every time, because /d/ is the second route that answers a stranger
   * and because the access rule behind it is surprising until it is stated: a
   * screen token renders its target on its own, with no passphrase, whatever
   * the canvas's access level says. Pairing is the administrative act. */
  log('[canvas] display links (/d/:token): reachable from the network by design;');
  log('[canvas]   a paired screen renders its target with no passphrase prompt, and');
  log('[canvas]   /d/ serves no editing capability at all.');
  /* Said every time, and separately from the canvas API, because this page
   * holds every credential the household owns and Canvas has no
   * administrator authentication yet. The design note is explicit that this
   * must be stated in the banner rather than buried. */
  if (options.config.apiAllowRemote) {
    log(`[canvas] WARNING: the settings page (${SETTINGS_PATH}) holds every credential this`);
    log('[canvas]          household owns, has NO administrator authentication, and');
    log('[canvas]          CANVAS_API_ALLOW_REMOTE=true has published it to the network.');
    log('[canvas]          Credentials are still write-only - no route returns one - but');
    log('[canvas]          anyone who can reach this port can REPLACE them.');
  } else {
    log(`[canvas] settings (${SETTINGS_PATH}, /api/settings, /api/credentials): answered for`);
    log('[canvas]   loopback clients only, because they hold every credential this household');
    log('[canvas]   owns and administrator authentication does not exist yet. Credentials are');
    log('[canvas]   write-only: no route in Canvas returns a stored secret.');
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`[canvas] ${signal} received, closing`);
    /* Stopped before the socket, so a refresh in flight cannot start another
     * interval against a provider on the way out. */
    feeds.stop();
    server.close(() => process.exit(0));
    /* A wall display holds long-lived connections; do not wait forever for a
     * browser that will reconnect on its own. */
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}
