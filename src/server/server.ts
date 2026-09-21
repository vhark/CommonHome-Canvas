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
import {emptySnapshot, SnapshotSource, type Snapshot} from './snapshot.ts';

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
  const startedAt = Date.now();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res);

    const urlPath = (req.url ?? '/').split('?')[0];

    if (!hostAllowed(req.headers.host, config.allowedHosts)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Host not permitted.\n');
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
      });
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
  const server = createCanvasServer(options);

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
  log(`[canvas] listening on http://${options.config.host}:${options.config.port}`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`[canvas] ${signal} received, closing`);
    server.close(() => process.exit(0));
    /* A wall display holds long-lived connections; do not wait forever for a
     * browser that will reconnect on its own. */
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}
