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
/* `/s/<token>` - the shared-link surface, and the only route in Canvas that
 * answers a caller who is not on the loopback interface.
 *
 * THE CENTRAL RULE OF THIS FILE: enforcement happens BEFORE the canvas data is
 * produced, not before it is rendered. `ctx.store.get(id)` is not called until
 * access has already been decided. A locked response must never CONTAIN the
 * canvas, because a field that reached the browser has leaked whatever the UI
 * did with it next. Every other structure here follows from that one rule:
 *
 *  - the locked page is built from constants and mentions neither the canvas's
 *    name, nor its id, nor its revision - a name is content, and "Finances
 *    (locked)" is a leak;
 *  - the miss is a single function emitting a byte-identical response, so an
 *    unknown token, a revoked token and a token that is not even well-formed
 *    are the same answer down to the byte and the header order;
 *  - a wrong passphrase emits exactly the locked page, so there is no oracle
 *    separating "this canvas exists and is locked" from "you guessed wrong".
 *
 * These pages are the only ones in the product that need `form-action`, which
 * the global policy sets to 'none'. The policy is re-set here rather than
 * loosened globally: one route needing a form is not a reason for every route
 * to permit one.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';

import {renderCanvasPage, readBody} from './api.ts';
import type {FeedCache} from './feeds.ts';
import {prepareRender} from './render-context.ts';
import type {CanvasConfig} from './config.ts';
import type {CanvasStore} from './store.ts';
import type {Settings} from './settings.ts';
import {
  AccessStore,
  isShareToken,
  type AccessRecord,
} from './access.ts';

export const SHARE_PREFIX = '/s/';

/* Named for the canvas, because sessions are per canvas: unlocking the family
 * photos must not unlock the finances, and a single site-wide session cookie
 * is exactly how that happens. The canvas id is not a credential - `/c/<id>`
 * is loopback-only and the id alone opens nothing - whereas the token is, so
 * the token stays out of the cookie's NAME and appears only in its Path, which
 * scopes the cookie to this one link and nothing else under `/s/`. */
export function sessionCookieName(canvasId: string): string {
  return `ch_canvas_${canvasId}`;
}

/* RFC 6265 is a list of `name=value` pairs separated by `; `. Written out
 * rather than pulled in, because a cookie parser is nine lines and a
 * dependency is forever - `"dependencies": {}` is what lets the runtime image
 * ship with no node_modules at all. */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/* `Secure` is set when - and only when - the request actually arrived over
 * TLS. Setting it unconditionally would break a household reaching Canvas over
 * plain http on its own LAN (the browser would silently drop the cookie and
 * the unlock would appear to do nothing); never setting it would let the
 * cookie travel in clear text for the households that do terminate TLS. The
 * forwarded header is trusted ONLY when the operator has stated a base URL, so
 * a stranger cannot flip the flag with a header of their own. */
export function requestIsSecure(req: IncomingMessage, config: CanvasConfig): boolean {
  if ((req.socket as {encrypted?: boolean}).encrypted === true) return true;
  if (config.baseUrl?.startsWith('https://')) {
    const proto = req.headers['x-forwarded-proto'];
    const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
    if (first === 'https') return true;
    /* An operator who declared an https base URL is behind TLS even when the
     * proxy forgot to say so. */
    return true;
  }
  return false;
}

export function buildSessionCookie(options: {
  readonly canvasId: string;
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date | null;
  readonly secure: boolean;
}): string {
  const parts = [
    `${sessionCookieName(options.canvasId)}=${options.sessionId}`,
    /* Scoped to this link. A cookie at `/` would be sent to every request the
     * household's browser makes to Canvas, including the ambient display. */
    `Path=${SHARE_PREFIX}${options.token}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  if (options.expiresAt !== null) {
    parts.push(`Expires=${options.expiresAt.toUTCString()}`);
    parts.push(`Max-Age=${Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000))}`);
  }
  /* No Expires/Max-Age at all IS the "no timeout" option: the cookie lives as
   * long as the browser session, which is the honest reading of "never expire"
   * for a link somebody shared. An actually-infinite cookie is a credential
   * nobody can revoke by closing a laptop. */
  return parts.join('; ');
}

/* ------------------------------------------------------------- responses -- */

/* Every /s/ response carries these, including the 404s. A shared link that
 * turns up in a search index is a public link nobody meant to make, and a
 * Referer leaking the token to whatever the recipient clicks next hands the
 * capability to a third party. */
function shareHeaders(res: ServerResponse): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  /* Re-stated for this route only: the global policy says form-action 'none',
   * which would block the unlock form's own POST. */
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
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
}

/* The one miss. Unknown token, revoked token, rotated-away token, a token that
 * is not 43 base64url characters, a path with too many segments: all of them
 * come through here, so they are identical in status, in header set, in header
 * ORDER and in body bytes. Nothing derived from the request is interpolated,
 * so the response cannot be used as a reflection oracle either.
 *
 * It deliberately does NOT mention canvases or sharing. */
export const SHARE_NOT_FOUND_BODY =
  '<!doctype html>\n<meta charset="utf-8">\n<title>Not found</title>\n<p>Not found.\n';

export function sendShareNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  shareHeaders(res);
  res.setHeader('Content-Length', String(Buffer.byteLength(SHARE_NOT_FOUND_BODY)));
  res.end(SHARE_NOT_FOUND_BODY);
}

/* The locked page. Constants only - no name, no id, no revision, no token, no
 * element, no layout, no event. The form posts back to the same address the
 * browser is already on, so the token never has to be written into the page
 * body and cannot be scraped out of it by anything that renders it.
 *
 * Identical bytes for "no session yet" and "that passphrase was wrong": the
 * second must not be a distinguishable answer, or the route becomes an oracle
 * telling an attacker their guesses are being received and judged. */
export const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Passphrase required</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem;
         display: grid; place-content: center; min-height: 100vh; }
  form { display: grid; gap: 1rem; width: min(22rem, 100%); }
  h1 { font-size: 1.25rem; margin: 0; }
  p { margin: 0; opacity: .75; font-size: .9375rem; }
  label { display: grid; gap: .5rem; }
  input, button { font: inherit; min-height: 48px; padding: 0 .75rem;
                  border-radius: .5rem; border: 1px solid currentColor; }
  button { cursor: pointer; }
</style>
<form method="post" autocomplete="on">
  <h1>Passphrase required</h1>
  <p>This link is protected. Enter the passphrase you were given.</p>
  <label>Passphrase
    <input type="password" name="passphrase" autocomplete="current-password" autofocus required>
  </label>
  <button type="submit">Unlock</button>
</form>
</html>
`;

function sendLocked(res: ServerResponse): void {
  /* 401 rather than 200: this is an authentication challenge and a cache or a
   * crawler should read it as one. The same status for both failure modes. */
  res.statusCode = 401;
  shareHeaders(res);
  res.setHeader('Content-Length', String(Buffer.byteLength(LOCKED_PAGE)));
  res.end(LOCKED_PAGE);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    /* unref so a pending penalty never keeps the process alive past a
     * shutdown; the socket is closed by the server's own grace timer. */
    setTimeout(resolve, ms).unref();
  });
}

/* ----------------------------------------------------------------- route -- */

export type ShareContext = {
  readonly config: CanvasConfig;
  readonly store: CanvasStore;
  readonly access: AccessStore;
  /* Optional, and when present it is the SHARED set: the FeedCache holds
   * calendars shaped twice, at the source, and this route is handed the set
   * that was shaped shared. Re-shaping here would put raw events in reach of
   * the one route that answers a stranger. */
  readonly feeds?: FeedCache;
  /* The household's own Block switches, so `/s/` cannot publish a Block type
   * the household turned off. Optional; absent means the defaults. */
  readonly settings?: {readonly current: Settings};
};

/* Reads the submitted passphrase from either an HTML form post (what the page
 * above sends, with no JavaScript anywhere) or a JSON body (what curl and a
 * future editor send). */
export function extractPassphrase(contentType: string | undefined, text: string): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(text);
      const value = (parsed as Record<string, unknown> | null)?.passphrase;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(text);
  const value = params.get('passphrase');
  return value === null ? null : value;
}

/* Returns true when this module owned the request and has answered it. */
export async function handleShareRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ShareContext,
  urlPath: string,
): Promise<boolean> {
  if (urlPath !== '/s' && !urlPath.startsWith(SHARE_PREFIX)) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.statusCode = 405;
    shareHeaders(res);
    return res.end('<!doctype html><meta charset="utf-8"><title>Not allowed</title>\n'), true;
  }

  const segments = urlPath.split('/').filter(Boolean);
  let token: string | null = null;
  try {
    token = segments.length === 2 ? decodeURIComponent(segments[1]) : null;
  } catch {
    /* An undecodable token is a malformed token, and must be the same answer
     * as an unknown one. */
    token = null;
  }

  /* `resolve` returns null for malformed, unknown, revoked and private alike,
   * and this is the ONLY place any of them is answered. */
  const record = token !== null && isShareToken(token) ? await ctx.access.resolve(token) : null;
  if (record === null || record.shareToken === null) {
    sendShareNotFound(res);
    return true;
  }

  if (record.level === 'link') {
    return renderShared(req, res, ctx, record);
  }

  /* ---- level: passphrase ---- */

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[sessionCookieName(record.canvasId)];
  if (await ctx.access.hasSession(record, sessionId)) {
    return renderShared(req, res, ctx, record);
  }

  if (req.method !== 'POST') {
    sendLocked(res);
    return true;
  }

  /* The growing delay is served as an actual wait rather than a distinct
   * "too many attempts" response, because a distinct response is itself the
   * signal an attacker wants: it confirms the token is live and tells them
   * when to come back. Waiting costs them the same time and tells them
   * nothing. */
  const gate = ctx.access.limiter.check(record.shareToken);
  if (!gate.allowed) await sleep(Math.min(gate.retryAfterMs, 30_000));

  const body = await readBody(req);
  const passphrase = body.ok ? extractPassphrase(req.headers['content-type'], body.text) : null;
  const outcome = await ctx.access.unlock(record, passphrase);
  if (!outcome.ok) {
    if (outcome.retryAfterMs > 0) await sleep(Math.min(outcome.retryAfterMs, 30_000));
    /* Byte-identical to the page an unlocked-nothing GET receives. */
    sendLocked(res);
    return true;
  }

  res.setHeader('Set-Cookie', buildSessionCookie({
    canvasId: record.canvasId,
    token: record.shareToken,
    sessionId: outcome.sessionId,
    expiresAt: outcome.expiresAt,
    secure: requestIsSecure(req, ctx.config),
  }));
  /* Re-read the record so the freshly written session is present, then render
   * in the same response: a redirect would work too, but a 303 back to the
   * same URL is one more round trip on a wall tablet for no gain. */
  const refreshed = (await ctx.access.read(record.canvasId)) ?? record;
  return renderShared(req, res, ctx, refreshed);
}

/* The ONLY path on which canvas data is fetched at all. Everything above
 * either returned or fell through to here having already decided access. */
async function renderShared(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ShareContext,
  record: AccessRecord,
): Promise<boolean> {
  const got = await ctx.store.get(record.canvasId);
  if (!got.ok) {
    /* A sidecar pointing at a canvas that is gone is the same miss as a token
     * nobody ever issued. It must not become a "the canvas was deleted"
     * oracle. */
    sendShareNotFound(res);
    return true;
  }
  res.statusCode = 200;
  shareHeaders(res);
  res.setHeader('ETag', `"${got.value.metadata.revision}"`);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  /* 'shared': THE ONE ROUTE IN CANVAS THAT ANSWERS A STRANGER. The level is
   * chosen here, by the route, and is never read from the request or from the
   * document - a viewer holding a share link must not be able to ask for the
   * private shaping. Everything else about the render is identical to `/d/` and
   * `/c/`, because it is the same function. */
  const page = prepareRender(got.value, ctx, 'shared');
  res.end(renderCanvasPage(page.doc, page.options));
  return true;
}
