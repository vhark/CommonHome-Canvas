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
/* The canvas HTTP surface: /api/canvases/... and /c/:id.
 *
 * THIS API IS UNAUTHENTICATED IN THIS PHASE. Auth is a later phase, and an
 * unauthenticated write API reachable from a LAN is not a rough edge, it is a
 * remote "replace what is on the kitchen wall" button for anyone on the
 * network. Two things hold that shut, and both are here rather than in
 * deployment docs, because a property that depends on somebody reading a
 * README is not a property:
 *
 *   1. The server binds loopback by default (see config.ts).
 *   2. EVERY route in this module independently refuses a non-loopback peer
 *      until auth exists, regardless of bind address.
 *
 * (2) exists because (1) is not enough on its own: the container image and
 * docker-compose.yml both set CANVAS_HOST=0.0.0.0 so the ambient DISPLAY is
 * reachable from a tablet, which is the whole point of the product. The bind
 * address therefore cannot be the thing protecting the API. The check is on
 * the peer address - not a header, not a hostname - because the peer address
 * is the one value in a request the client cannot choose.
 *
 * Escaping the check is deliberate, explicit and logged at startup:
 * CANVAS_API_ALLOW_REMOTE=true. It exists so someone who has put Canvas
 * behind their own authenticating proxy is not forced to patch source, and it
 * is spelled out loudly enough that nobody sets it by accident.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';

import {saveDocument, toShareable} from '../canvas/index.ts';
import {
  describeAccess,
  isAccessLevel,
  parseSessionTimeout,
  type AccessStore,
} from './access.ts';
import type {CanvasConfig} from './config.ts';
import {
  describeScreen,
  isScreenId,
  screenNotFound,
  type ScreenStore,
} from './screens.ts';
import {
  CanvasStore,
  isCanvasId,
  notFound,
  type StoreFailure,
  type StoredCanvas,
} from './store.ts';
import {
  escapeHtml,
  renderCanvasHtmlPage,
  type RenderOptions,
} from '../render/index.ts';
import {prepareRender} from './render-context.ts';
import type {Settings} from './settings.ts';
import type {FeedCache} from './feeds.ts';

/* A canvas document is layout and text, not media. A megabyte is already an
 * absurd document and the limit is what stops an unauthenticated (see above)
 * endpoint from being a memory exhaustion primitive. */
export const MAX_BODY_BYTES = 1024 * 1024;

export type ApiContext = {
  readonly config: CanvasConfig;
  readonly store: CanvasStore;
  /* Optional so a caller that only exercises document routes need not build
   * one. Every access route refuses when it is absent rather than pretending
   * a canvas is unprotected. */
  readonly access?: AccessStore;
  /* Optional for the same reason as `access`: a caller exercising only
   * document routes need not build one, and the screen routes refuse rather
   * than inventing a store. */
  readonly screens?: ScreenStore;
  /* Optional for the same reason: `/c/` renders with no live data when a
   * server was built without a feed cache, which is the same path a household
   * with no integrations configured takes. */
  readonly feeds?: FeedCache;
  /* The household's own switches. Optional so every existing caller and test
   * keeps working on the product's defaults, which are every built-in Block
   * on and no experiments. */
  readonly settings?: {readonly current: Settings};
};

/* IPv4 loopback is a whole /8, and Node reports a v4 peer on a dual-stack
 * socket in the v4-mapped form. All three spellings are the same machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (addr === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!v4) return false;
  return v4.slice(1).every((n) => Number(n) <= 255) && Number(v4[1]) === 127;
}

export function apiReachable(config: CanvasConfig, remoteAddress: string | undefined): boolean {
  return config.apiAllowRemote || isLoopbackAddress(remoteAddress);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function sendError(res: ServerResponse, status: number, error: StoreFailure): void {
  sendJson(res, status, {error});
}

/* The uniform miss. Identical status, headers and body for "no such id" and
 * "that is not an id at all", so probing /api/canvases/<guess> learns nothing
 * about which guesses were even well-formed. */
function sendNotFound(res: ServerResponse): void {
  sendError(res, 404, notFound());
}

/* Maps a store failure onto a status code.
 *
 * A validation failure is 422 carrying the MODEL'S OWN structured error -
 * code, message and the path that is wrong - because "500 Internal Server
 * Error" for a document someone typed is a lie about whose fault it is and
 * tells them nothing about what to fix. */
function statusFor(error: StoreFailure): number {
  if (error.code === 'not_found') return 404;
  if (error.code === 'revision_conflict') return 409;
  if (error.code === 'invalid_revision') return 400;
  if (error.code.startsWith('stored_') || error.code === 'id_mismatch') return 500;
  return 422;
}

export function readBody(req: IncomingMessage): Promise<{ok: true; text: string} | {ok: false; error: StoreFailure}> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    let done = false;
    const finish = (value: {ok: true; text: string} | {ok: false; error: StoreFailure}) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        /* Past the limit, chunks are counted and discarded rather than kept,
         * so the memory cost stops growing immediately. The socket is NOT
         * destroyed at once: a client that is still sending gets its
         * connection reset before the response reaches it and sees a network
         * error instead of "your canvas is too large", which is a much worse
         * thing to debug. Draining is bounded so an endless upload is still
         * cut off rather than serviced forever. */
        over = true;
        chunks.length = 0;
        if (size > MAX_BODY_BYTES * 8) {
          req.destroy();
          finish({ok: false, error: tooLarge()});
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(over
      ? {ok: false, error: tooLarge()}
      : {ok: true, text: Buffer.concat(chunks).toString('utf8')}));
    req.on('error', () => finish({ok: false, error: {code: 'body_unreadable', message: 'the request body could not be read'}}));
    req.on('aborted', () => finish({ok: false, error: {code: 'body_unreadable', message: 'the request body could not be read'}}));
  });
}

function tooLarge(): StoreFailure {
  return {code: 'body_too_large', message: `a canvas must be under ${MAX_BODY_BYTES} bytes`};
}

async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ok: true; value: unknown} | {ok: false}> {
  const body = await readBody(req);
  if (!body.ok) {
    sendError(res, body.error.code === 'body_too_large' ? 413 : 400, body.error);
    return {ok: false};
  }
  try {
    return {ok: true, value: JSON.parse(body.text)};
  } catch (cause) {
    sendError(res, 400, {
      code: 'invalid_json',
      message: `document is not JSON: ${(cause as Error).message}`,
    });
    return {ok: false};
  }
}

/* The revision the caller read, from If-Match.
 *
 * Deliberately required rather than optional-with-a-default: an update with
 * no If-Match is a blind write, and defaulting it to "whatever is current"
 * would turn optimistic concurrency into last-write-wins for every client
 * that forgot the header - which is every client, eventually. Quoted and
 * unquoted forms are both accepted because the ETag grammar quotes and people
 * typing curl by hand do not. */
export function parseIfMatch(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null;
  const raw = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function withRevisionHeaders(res: ServerResponse, doc: StoredCanvas): void {
  res.setHeader('ETag', `"${doc.metadata.revision}"`);
}

/* The escaper this module used to carry privately now lives in
 * src/render/escape.ts and is shared with every renderer in the product. */

/* A read-only rendering of a stored canvas, on the ONE shared renderer.
 *
 * `/c/:id` (the owner's own preview, loopback-only) and `/s/<token>` (a share
 * link) both come through here, and both get the identical canvas fragment that
 * `/d/<token>` serves - the tests compare the bytes, which is what makes the
 * single-renderer claim structural rather than aspirational.
 *
 * The SHARE LEVEL is the only thing the caller chooses, and the caller is the
 * ROUTE, never the request: `/s/` passes 'shared' so a visitor in a hallway
 * cannot see a location or an attendee, and `/c/` passes 'private' because it is
 * already behind the loopback gate and is the owner looking at their own canvas.
 *
 * No inline script, because the CSP set by the server says script-src 'self'
 * and a page that needs its own policy loosened is a page that will loosen it
 * for the whole product. `toShareable` is used for the embedded JSON copy so the
 * household's local density overrides are not published on an address that
 * will one day be shared.
 */
export function renderCanvasPage(
  doc: StoredCanvas,
  options: RenderOptions = {shareLevel: 'shared'},
): string {
  const name = escapeHtml(doc.metadata.name);
  const shareable = saveDocument(toShareable(doc));
  return renderCanvasHtmlPage(doc, {
    ...options,
    title: `${doc.metadata.name} — CommonHome Canvas`,
    /* The document's own JSON, below the render. Genuinely useful on the
     * owner's preview while there is no editor, and harmless on a share: it is
     * the SHAREABLE projection, so it carries no local state and no access
     * record. It is escaped, because a canvas name inside a JSON string is
     * still a canvas name inside an HTML document. */
    extraBody: [
      `<details class="ch-source"><summary>${name}</summary>`,
      `<pre>${escapeHtml(shareable)}</pre></details>`,
      '<style>',
      '  .ch-source { margin: 1.5rem 0 0; font: 12px/1.5 ui-monospace, monospace;',
      '               opacity: .55; }',
      /* 48x48 CSS px minimum, because <summary> IS interactive and DES-05
       * applies to every affordance and not only to buttons. */
      '  .ch-source summary { min-height: 48px; display: flex; align-items: center;',
      '                       padding: 0 .75rem; cursor: pointer; }',
      '  .ch-source pre { overflow: auto; max-height: 40vh; padding: .75rem; }',
      '</style>',
    ].join('\n'),
  });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendError(res, 405, {code: 'method_not_allowed', message: `allowed: ${allow}`});
}

/* ---- /api/canvases/:id/access ----
 *
 * Owner-side management of the share link. Loopback-only like every other
 * route in this module (the gate is applied once, above, before any of this
 * is reached) - the SHARED surface is `/s/<token>` in share.ts, and it is the
 * only route in Canvas that answers a stranger.
 *
 * The response carries the token, because the token IS the share link and
 * withholding it from the owner would make the feature unusable. It never
 * carries a hash, a salt or a session id: nothing outside access.ts needs
 * those, and a value that never leaves a module cannot leak from an endpoint.
 */
async function handleAccessRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  id: string,
  tail: string | null,
): Promise<boolean> {
  const access = ctx.access;
  if (access === undefined) {
    sendError(res, 503, {
      code: 'access_unavailable',
      message: 'this server was built without an access store',
    });
    return true;
  }

  /* The canvas must exist before its access can be spoken about, and the miss
   * is the same uniform 404 as everywhere else - otherwise /access becomes an
   * existence oracle for ids that /api/canvases/:id already refuses to
   * confirm. */
  const canvas = await ctx.store.get(id);
  if (!canvas.ok) {
    sendError(res, statusFor(canvas.error), canvas.error);
    return true;
  }

  if (tail === 'rotate') {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST'), true;
    const rotated = await access.rotate(id);
    if (rotated === null) {
      sendError(res, 409, {
        code: 'not_shared',
        message: 'this canvas is private and has no share link to rotate',
      });
      return true;
    }
    await writeLevelLabel(ctx, canvas.value, rotated.level);
    sendJson(res, 200, {access: describeAccess(rotated)});
    return true;
  }

  switch (req.method) {
    case 'GET':
      sendJson(res, 200, {access: describeAccess(await access.read(id))});
      return true;

    case 'PUT': {
      const body = await readJson(req, res);
      if (!body.ok) return true;
      const input = body.value as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        sendError(res, 422, {code: 'not_an_object', message: 'an access setting must be an object'});
        return true;
      }
      if (!isAccessLevel(input.level)) {
        sendError(res, 422, {
          code: 'unknown_access_level',
          message: `level must be one of private, link, passphrase; got ${String(input.level)}`,
          path: 'level',
        });
        return true;
      }
      let timeout = null;
      if (input.sessionTimeout !== undefined) {
        timeout = parseSessionTimeout(input.sessionTimeout);
        if (timeout === null) {
          sendError(res, 422, {
            code: 'invalid_session_timeout',
            message: 'sessionTimeout must be "session" or a whole number of days from 1 to 3650',
            path: 'sessionTimeout',
          });
          return true;
        }
      }
      const set = await access.set(id, {
        level: input.level,
        passphrase: input.passphrase === undefined
          ? undefined
          : input.passphrase === null ? null : String(input.passphrase),
        sessionTimeout: timeout,
      });
      if (!set.ok) {
        sendError(res, 422, {code: set.code, message: set.message});
        return true;
      }
      await writeLevelLabel(ctx, canvas.value, set.record.level);
      sendJson(res, 200, {access: describeAccess(set.record)});
      return true;
    }

    case 'DELETE': {
      /* Back to private: the token dies, the sessions die, the sidecar is
       * removed. Identical in effect to PUT {level: "private"}, and present
       * because "stop sharing this" is the verb a person reaches for. */
      await access.clear(id);
      await writeLevelLabel(ctx, canvas.value, 'private');
      sendJson(res, 200, {access: describeAccess(null)});
      return true;
    }

    default:
      return methodNotAllowed(res, 'GET, PUT, DELETE'), true;
  }
}

/* Mirrors the level onto the document as a NON-SECRET label, so a canvas
 * listing can show a padlock without consulting the sidecar. Best effort and
 * deliberately non-fatal: the authority is the sidecar, this is a caption, and
 * a caption losing a race with a concurrent edit must never fail the
 * revocation that just succeeded. */
async function writeLevelLabel(
  ctx: ApiContext,
  doc: StoredCanvas,
  level: string,
): Promise<void> {
  if (doc.metadata.accessLevel === level) return;
  const next = {...doc, metadata: {...doc.metadata, accessLevel: level}};
  await ctx.store.update(doc.metadata.uid, next, doc.metadata.revision);
}

/* ---- /api/screens ----
 *
 * Fleet management, loopback-only like every other route in this module. The
 * responses carry the screen TOKEN, because the token is the kiosk URL and
 * withholding it from the admin would make registration useless - the same
 * reasoning as the share token in `describeAccess`.
 *
 * There is no route here that a display calls. A display only ever talks to
 * `/d/`, which serves no write verb at all.
 */
export async function handleScreenRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  urlPath: string,
): Promise<boolean> {
  if (urlPath !== '/api/screens' && !urlPath.startsWith('/api/screens/')) return false;

  if (!apiReachable(ctx.config, req.socket.remoteAddress)) {
    sendError(res, 403, {
      code: 'not_authenticated',
      message:
        'the canvas API has no authentication yet and therefore answers loopback only; ' +
        'set CANVAS_API_ALLOW_REMOTE=true only if Canvas sits behind your own authenticating proxy',
    });
    return true;
  }

  const screens = ctx.screens;
  if (screens === undefined) {
    sendError(res, 503, {
      code: 'screens_unavailable',
      message: 'this server was built without a screen store',
    });
    return true;
  }

  const segments = urlPath.split('/').filter(Boolean);

  /* ---- /api/screens ---- */
  if (segments.length === 2) {
    if (req.method === 'GET') {
      sendJson(res, 200, {screens: (await screens.list()).map((s) => describeScreen(s))});
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body.ok) return true;
      const input = body.value as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        sendError(res, 422, {code: 'not_an_object', message: 'a screen registration must be an object'});
        return true;
      }
      /* The target canvas must exist before a screen may point at it. A
       * screen registered against nothing is a kiosk URL that 404s forever
       * and looks exactly like a revoked one. */
      const target = input.target as Record<string, unknown> | undefined;
      const targetId = typeof target?.id === 'string' ? target.id : null;
      if (targetId === null || !isCanvasId(targetId) || target?.kind !== 'canvas') {
        sendError(res, 422, {
          code: 'invalid_target',
          message: 'target must be {"kind":"canvas","id":"<canvas id>"}',
          path: 'target',
        });
        return true;
      }
      const canvas = await ctx.store.get(targetId);
      if (!canvas.ok) {
        sendError(res, statusFor(canvas.error), canvas.error);
        return true;
      }
      const created = await screens.create({label: input.label, target: input.target});
      if (!created.ok) return sendError(res, 422, created.error), true;
      res.setHeader('Location', `/api/screens/${created.value.id}`);
      sendJson(res, 201, {screen: describeScreen(created.value)});
      return true;
    }
    return methodNotAllowed(res, 'GET, POST'), true;
  }

  /* ---- /api/screens/:id[/rotate] ---- */
  let id: string | null = null;
  try {
    id = decodeURIComponent(segments[2] ?? '');
  } catch {
    id = null;
  }
  const tail = segments[3] ?? null;
  const shapeOk = segments.length === 3 || (segments.length === 4 && tail === 'rotate');
  if (!shapeOk) {
    sendError(res, 404, screenNotFound());
    return true;
  }

  const allow = tail === 'rotate' ? 'POST' : 'GET, PUT, DELETE';
  if (!allow.split(', ').includes(req.method ?? '')) return methodNotAllowed(res, allow), true;

  /* Checked before anything is dispatched on, so a malformed id and an
   * unknown one leave by the same door. */
  if (id === null || !isScreenId(id)) {
    sendError(res, 404, screenNotFound());
    return true;
  }

  if (tail === 'rotate') {
    const rotated = await screens.rotate(id);
    if (!rotated.ok) return sendError(res, 404, rotated.error), true;
    sendJson(res, 200, {screen: describeScreen(rotated.value)});
    return true;
  }

  switch (req.method) {
    case 'GET': {
      const record = await screens.read(id);
      if (record === null) return sendError(res, 404, screenNotFound()), true;
      sendJson(res, 200, {screen: describeScreen(record)});
      return true;
    }
    case 'PUT': {
      const body = await readJson(req, res);
      if (!body.ok) return true;
      const input = body.value as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        sendError(res, 422, {code: 'not_an_object', message: 'a screen update must be an object'});
        return true;
      }
      if (input.target !== undefined) {
        const target = input.target as Record<string, unknown> | null;
        const targetId = typeof target?.id === 'string' ? target.id : null;
        if (targetId === null || !isCanvasId(targetId) || target?.kind !== 'canvas') {
          sendError(res, 422, {
            code: 'invalid_target',
            message: 'target must be {"kind":"canvas","id":"<canvas id>"}',
            path: 'target',
          });
          return true;
        }
        const canvas = await ctx.store.get(targetId);
        if (!canvas.ok) {
          sendError(res, statusFor(canvas.error), canvas.error);
          return true;
        }
      }
      const updated = await screens.update(id, {label: input.label, target: input.target});
      if (!updated.ok) {
        sendError(res, updated.error.code === 'not_found' ? 404 : 422, updated.error);
        return true;
      }
      sendJson(res, 200, {screen: describeScreen(updated.value)});
      return true;
    }
    case 'DELETE': {
      const removed = await screens.remove(id);
      if (!removed.ok) return sendError(res, 404, removed.error), true;
      res.statusCode = 204;
      res.end();
      return true;
    }
    default:
      return methodNotAllowed(res, 'GET, PUT, DELETE'), true;
  }
}

/* Returns true when this module owned the request and has answered it, so the
 * caller can fall through to the static file server otherwise. */
export async function handleCanvasRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  urlPath: string,
): Promise<boolean> {
  const isApi = urlPath === '/api/canvases' || urlPath.startsWith('/api/canvases/');
  const isView = urlPath === '/c' || urlPath.startsWith('/c/');
  if (!isApi && !isView) return false;

  if (!apiReachable(ctx.config, req.socket.remoteAddress)) {
    /* 403 with the reason spelled out. A silent 404 here would send whoever
     * set this up hunting a routing bug that does not exist. */
    sendError(res, 403, {
      code: 'not_authenticated',
      message:
        'the canvas API has no authentication yet and therefore answers loopback only; ' +
        'set CANVAS_API_ALLOW_REMOTE=true only if Canvas sits behind your own authenticating proxy',
    });
    return true;
  }

  /* /api/canvases/:id -> ['api','canvases',id]; /c/:id -> ['c',id]. */
  const segments = urlPath.split('/').filter(Boolean);
  let id: string | null = null;
  try {
    id = decodeURIComponent(segments[isApi ? 2 : 1] ?? '');
  } catch {
    /* An undecodable id is a malformed id, and must be indistinguishable from
     * an unknown one - so it becomes null and takes the uniform-404 path. */
    id = null;
  }

  if (isView) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD'), true;
    if (segments.length !== 2 || id === null || !isCanvasId(id)) {
      sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>No canvas with that id.\n');
      return true;
    }
    const got = await ctx.store.get(id);
    if (!got.ok) {
      /* Same page, same status, for an unknown id and a malformed one. */
      sendHtml(res, statusFor(got.error) === 404 ? 404 : 500,
        '<!doctype html><meta charset="utf-8"><title>Not found</title><p>No canvas with that id.\n');
      return true;
    }
    withRevisionHeaders(res, got.value);
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end();
      return true;
    }
    /* 'private': `/c/` is the owner's own preview and is already behind the
     * loopback gate. The SHARED surface is `/s/`, and it passes 'shared'. */
    const page = prepareRender(got.value, ctx, 'private');
    sendHtml(res, 200, renderCanvasPage(page.doc, page.options));
    return true;
  }

  /* ---- /api/canvases ---- */
  if (segments.length === 2) {
    if (req.method === 'GET') {
      sendJson(res, 200, {canvases: await ctx.store.list()});
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body.ok) return true;
      const created = await ctx.store.create(body.value);
      if (!created.ok) return sendError(res, statusFor(created.error), created.error), true;
      withRevisionHeaders(res, created.value);
      res.setHeader('Location', `/api/canvases/${created.value.metadata.uid}`);
      sendJson(res, 201, created.value);
      return true;
    }
    return methodNotAllowed(res, 'GET, POST'), true;
  }

  /* ---- /api/canvases/:id[/duplicate|/access|/access/rotate] ---- */
  const SUBRESOURCES = ['duplicate', 'access'];
  const sub = segments[3] ?? null;
  const tail = segments[4] ?? null;
  const shapeOk =
    segments.length === 3 ||
    (segments.length === 4 && SUBRESOURCES.includes(sub ?? '')) ||
    (segments.length === 5 && sub === 'access' && tail === 'rotate');
  if (!shapeOk) {
    sendNotFound(res);
    return true;
  }

  /* Checked BEFORE the method is dispatched on, so a malformed id and an
   * unknown one take exactly the same path through this function. */
  if (id === null || !isCanvasId(id)) {
    if (sub === 'duplicate') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST'), true;
    } else if (sub === 'access') {
      const allow = tail === 'rotate' ? 'POST' : 'GET, PUT, DELETE';
      if (!allow.split(', ').includes(req.method ?? '')) return methodNotAllowed(res, allow), true;
    } else if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(req.method ?? '')) {
      return methodNotAllowed(res, 'GET, PUT, DELETE'), true;
    }
    sendNotFound(res);
    return true;
  }

  if (sub === 'access') {
    return handleAccessRoutes(req, res, ctx, id, tail);
  }

  if (sub === 'duplicate') {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST'), true;
    const copied = await ctx.store.duplicate(id);
    if (!copied.ok) return sendError(res, statusFor(copied.error), copied.error), true;
    withRevisionHeaders(res, copied.value);
    res.setHeader('Location', `/api/canvases/${copied.value.metadata.uid}`);
    sendJson(res, 201, copied.value);
    return true;
  }

  switch (req.method) {
    case 'GET':
    case 'HEAD': {
      const got = await ctx.store.get(id);
      if (!got.ok) return sendError(res, statusFor(got.error), got.error), true;
      withRevisionHeaders(res, got.value);
      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end();
        return true;
      }
      sendJson(res, 200, got.value);
      return true;
    }
    case 'PUT': {
      const expected = parseIfMatch(req.headers['if-match']);
      if (expected === null) {
        sendError(res, 428, {
          code: 'if_match_required',
          message:
            'PUT requires If-Match with the revision you read, so a concurrent edit is ' +
            'refused rather than silently overwritten',
        });
        return true;
      }
      const body = await readJson(req, res);
      if (!body.ok) return true;
      const updated = await ctx.store.update(id, body.value, expected);
      if (!updated.ok) return sendError(res, statusFor(updated.error), updated.error), true;
      withRevisionHeaders(res, updated.value);
      sendJson(res, 200, updated.value);
      return true;
    }
    case 'DELETE': {
      const removed = await ctx.store.remove(id);
      if (!removed.ok) return sendError(res, statusFor(removed.error), removed.error), true;
      /* The sidecar outlives nothing. A deleted canvas whose access record
       * stayed behind would leave a live token in the index pointing at an id
       * a future canvas could never reuse but a stale reader might. */
      await ctx.access?.clear(id);
      res.statusCode = 204;
      res.end();
      return true;
    }
    default:
      return methodNotAllowed(res, 'GET, PUT, DELETE'), true;
  }
}
