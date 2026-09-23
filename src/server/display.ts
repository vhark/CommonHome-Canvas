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
/* `/d/<screenToken>` - the kiosk surface. The second route in Canvas that
 * answers a caller who is not on loopback, and the only one that is expected
 * to keep answering the same caller forever.
 *
 * FOUR RULES CARRY THIS FILE.
 *
 * 1. A SCREEN TOKEN AUTHORISES THE RENDER ON ITS OWN. A paired display never
 *    prompts for a passphrase, EVEN WHEN THE TARGET CANVAS IS PASSPHRASE
 *    LEVEL. This is not a shortcut, it is the decision the design exists to
 *    make: pairing a display is a deliberate administrative act - somebody
 *    minted a token and typed it into a device once - which is stronger
 *    evidence than a shared secret typed by whoever happens to be standing in
 *    the hallway. The alternative is a wall display blanking to a login every
 *    thirty days, which is exactly the failure this phase prevents. So this
 *    module never consults the AccessStore at all; the canvas's access level
 *    is not even read.
 *
 * 2. `/d/` SERVES NO EDITING CAPABILITY. Not "editing hidden by CSS" - there
 *    is no form, no input, no button, no editor bundle, and no route here
 *    that accepts a write. A hallway screen is operated by whoever walks
 *    past, including a five-year-old. The tests assert this on the serialised
 *    bytes, because a CSS class is a claim and bytes are a fact.
 *
 * 3. SCREEN TOKENS ARE A SEPARATE NAMESPACE FROM SHARE TOKENS. This module
 *    resolves through `ScreenStore` and nothing else; `share.ts` resolves
 *    through `AccessStore` and nothing else. Neither ever falls back to the
 *    other, so a screen token presented at `/s/` is simply an unknown token,
 *    and a share token presented at `/d/` likewise. Two credentials with
 *    genuinely different lifetimes get two revocation policies.
 *
 * 4. A FAILURE IS NEVER A BLANK SCREEN AND NEVER AN ERROR PAGE. A display
 *    showing yesterday's canvas is useful; a display showing a connection
 *    error is furniture that has failed in public. The client caches its last
 *    good render in localStorage and shows it with a small staleness note.
 *    Revocation lands in exactly the same place by design: a revoked screen
 *    should stop updating, not start screaming in the hallway.
 *
 * The one uniform miss is the same rule as `/s/`: unknown, revoked, rotated
 * away, malformed, wrong shape - all identical in status, headers, header
 * order and body bytes, so the route is not an existence oracle.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';

import type {CanvasConfig} from './config.ts';
import {SHARE_NOT_FOUND_BODY} from './share.ts';
import {
  DEFAULT_POLL_SECONDS,
  POLL_JITTER_RATIO,
  isScreenToken,
  type ScreenRecord,
  type ScreenStore,
} from './screens.ts';
import type {FeedCache} from './feeds.ts';
import type {Settings} from './settings.ts';
import type {CanvasStore, StoredCanvas} from './store.ts';
import {
  renderCanvasFragment,
  renderCanvasHtmlPage,
  type RenderOptions,
} from '../render/index.ts';
import {prepareRender} from './render-context.ts';

export const DISPLAY_PREFIX = '/d/';

/* The kiosk script is served from a FIXED, token-free path so it is one
 * cacheable file for a household of six screens rather than six copies, and
 * so the page needs no inline script - the global CSP says script-src 'self'
 * and a page that needs the policy loosened is a page that loosens it for the
 * whole product. The script contains no secret: it reads its own token out of
 * `location.pathname`. */
export const KIOSK_SCRIPT_PATH = `${DISPLAY_PREFIX}kiosk.js`;

/* Byte-identical to the `/s/` miss on purpose. Cross-surface probing should
 * not distinguish "no such share" from "no such screen" either. */
export const DISPLAY_NOT_FOUND_BODY = SHARE_NOT_FOUND_BODY;

function displayHeaders(res: ServerResponse, contentType: string): void {
  /* A kiosk URL in a search index is a wall display a stranger can watch, and
   * a Referer carrying the token hands the capability to whatever the page
   * links to - which is nothing, but the header costs nothing either. */
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Type', contentType);
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
      /* `'none'`, unlike `/s/`: a display has nothing to submit, and saying so
       * in the policy means a form injected by any means cannot post. */
      "form-action 'none'",
      "object-src 'none'",
    ].join('; '),
  );
}

export function sendDisplayNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  displayHeaders(res, 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(DISPLAY_NOT_FOUND_BODY)));
  res.end(DISPLAY_NOT_FOUND_BODY);
}

/* The escaper this module used to carry privately now lives in
 * src/render/escape.ts and is shared with every other renderer. Two copies of a
 * security primitive is one copy that will eventually be missing a character. */

/* ---------------------------------------------------------------- render -- */

/* The canvas content, and nothing else: no id, no token, no link, no control.
 * Returned both inline in the shell (so the first paint needs no JavaScript,
 * which matters on a TV browser that may have run out of memory overnight)
 * and on its own from `/view`, so a revision change can be swapped in without
 * a full reload - a reload flashes a photo and re-runs every layout.
 *
 * THE FUNCTION THAT PRODUCES IT IS `renderCanvasFragment` IN src/render/, AND
 * IT IS THE SAME FUNCTION `/s/` AND `/c/` CALL. This module adds nothing to the
 * fragment and subtracts nothing from it; the only thing it chooses is the share
 * level, and `/d/` is a paired household display so it gets the private one.
 * That is what makes "one renderer" a structural fact rather than a claim - the
 * tests compare the three surfaces' fragment bytes. */
export function renderDisplayFragment(doc: StoredCanvas, options?: RenderOptions): string {
  return renderCanvasFragment(doc, options ?? {shareLevel: 'private'});
}

/* Unobtrusive on purpose: a stale display is still a useful display, and a
 * full-width red banner would make a working-but-old screen look broken. */
const STALE_NOTE =
  '<p class="screen-stale" id="screen-stale" hidden>Showing the last update received.</p>';

/* The shell. Every byte of it is a constant except the fragment and the
 * revision, and there is deliberately nothing in it that could be mistaken
 * for a control: no form, no input, no button, no textarea, no
 * contenteditable, no drag handle, no link to `/c/` or `/api/`. The stylesheet
 * is an external same-origin file so the page needs no inline <style> and the
 * CSP need not be loosened for the product. */
export function renderDisplayPage(doc: StoredCanvas, options?: RenderOptions): string {
  return renderCanvasHtmlPage(doc, {
    ...(options ?? {shareLevel: 'private'}),
    title: 'CommonHome Canvas',
    mainAttributes: `id="screen-view" data-revision="${doc.metadata.revision}"`,
    extraBody: `${STALE_NOTE}\n<style>\n  .screen-stale { position: fixed; inset: auto auto 1rem 1rem;\n`
      + '                  font-size: .8125rem; opacity: .55; padding: .375rem .625rem;\n'
      + '                  border-radius: .5rem; border: 1px solid currentColor;\n'
      + '                  background: Canvas; color: CanvasText; z-index: 9; }\n'
      + '  .screen-stale[hidden] { display: none; }\n</style>',
    scriptPath: KIOSK_SCRIPT_PATH,
  });
}

/* ---------------------------------------------------------------- client -- */

/* Served as a static string rather than built, because Canvas has no runtime
 * dependencies and the runtime image has no bundler. It is small enough to
 * read in one sitting, which is the point: this is the code that decides what
 * a screen in someone's kitchen shows when the server is unreachable.
 *
 * It is ALSO the second place the no-editing rule is enforced: there is no
 * code path here that sends anything but GET. */
export const KIOSK_SCRIPT = `/* CommonHome Canvas kiosk client. AGPL-3.0-or-later. */
const view = document.getElementById('screen-view');
const stale = document.getElementById('screen-stale');
const parts = location.pathname.split('/');
const token = parts[2] || '';
const key = 'ch_screen_' + token;

/* Defaults used only before the first manifest arrives, or while it cannot be
 * reached. They must be sane on their own: a display that boots into an
 * outage still needs a retry cadence. */
let intervalMs = ${DEFAULT_POLL_SECONDS * 1000};
let jitterRatio = ${POLL_JITTER_RATIO};
let etag = null;

function save(revision, html) {
  try {
    localStorage.setItem(key, JSON.stringify({revision: revision, html: html, at: Date.now()}));
  } catch (e) {
    /* Private mode, or a full quota. Caching is an improvement, not a
       requirement, so a failure here must never stop the render. */
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached && typeof cached.html === 'string' ? cached : null;
  } catch (e) {
    return null;
  }
}

function setStale(on) {
  if (stale) stale.hidden = !on;
}

/* +/- jitterRatio. Six screens brought up by one power cut must not become a
   synchronised thundering herd; without this they poll in lockstep forever,
   because they were all started by the same event. */
function nextDelay() {
  const spread = intervalMs * Math.min(Math.max(jitterRatio, 0), 0.9);
  return Math.max(1000, Math.round(intervalMs + (Math.random() * 2 - 1) * spread));
}

if (view && view.children.length === 0) {
  const cached = restore();
  if (cached) {
    view.innerHTML = cached.html;
    view.dataset.revision = String(cached.revision);
    setStale(true);
  }
} else if (view) {
  save(view.dataset.revision, view.innerHTML);
}

async function refresh(revision) {
  const res = await fetch(location.pathname.replace(/\\/$/, '') + '/view', {
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!res.ok) throw new Error('view unavailable');
  const body = await res.json();
  if (view) {
    view.innerHTML = body.html;
    view.dataset.revision = String(body.revision);
  }
  save(body.revision, body.html);
}

async function poll() {
  try {
    const headers = etag ? {'If-None-Match': etag} : undefined;
    const res = await fetch(location.pathname.replace(/\\/$/, '') + '/manifest', {
      cache: 'no-store',
      credentials: 'omit',
      headers: headers,
    });
    if (res.status === 304) {
      setStale(false);
    } else if (res.ok) {
      etag = res.headers.get('ETag');
      const manifest = await res.json();
      if (typeof manifest.pollIntervalSeconds === 'number') {
        intervalMs = manifest.pollIntervalSeconds * 1000;
      }
      if (typeof manifest.pollJitterRatio === 'number') jitterRatio = manifest.pollJitterRatio;
      const current = view ? view.dataset.revision : null;
      if (String(manifest.revision) !== String(current)) await refresh(manifest.revision);
      setStale(false);
    } else {
      /* 404 is the revoked case, and it is deliberately NOT special: the
         display keeps showing what it has and quietly says it is stale. A
         revoked screen should stop updating, not start screaming. */
      setStale(true);
    }
  } catch (e) {
    setStale(true);
  }
  setTimeout(poll, nextDelay());
}

setTimeout(poll, nextDelay());
`;

/* ----------------------------------------------------------------- route -- */

export type DisplayContext = {
  readonly config: CanvasConfig;
  readonly store: CanvasStore;
  readonly screens: ScreenStore;
  /* Optional: a server built without integrations renders with no live data,
   * which is the same path a household that configured none takes. */
  readonly feeds?: FeedCache;
  /* The household's own Block switches. Optional; absent means the defaults. */
  readonly settings?: {readonly current: Settings};
};

function pollSeconds(config: CanvasConfig): number {
  return config.screenPollSeconds ?? DEFAULT_POLL_SECONDS;
}

/* Includes the target id, so REPOINTING a screen changes the ETag even in the
 * pathological case where the new canvas happens to sit at the same revision
 * number as the old one. An ETag that ignored the target would hand a display
 * a 304 and leave it showing the wrong canvas indefinitely. */
function manifestEtag(record: ScreenRecord, revision: number): string {
  return `"${record.target.kind}:${record.target.id}:${revision}"`;
}

function ifNoneMatch(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return header.trim();
}

/* Returns true when this module owned the request and has answered it. */
export async function handleDisplayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DisplayContext,
  urlPath: string,
): Promise<boolean> {
  if (urlPath !== '/d' && !urlPath.startsWith(DISPLAY_PREFIX)) return false;

  /* GET and HEAD only, everywhere under /d/. There is no write verb on this
   * surface at all, which is rule 2 expressed as routing rather than as a
   * comment. */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    displayHeaders(res, 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><title>Not allowed</title>\n');
    return true;
  }

  if (urlPath === KIOSK_SCRIPT_PATH) {
    res.statusCode = 200;
    displayHeaders(res, 'text/javascript; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(KIOSK_SCRIPT)));
    res.end(req.method === 'HEAD' ? undefined : KIOSK_SCRIPT);
    return true;
  }

  /* NOT served here: the stylesheet. It lives on one global token-free path
   * (`/assets/canvas.css`, served in server.ts) because it is byte-identical for
   * every surface and every screen, so a household of six displays shares one
   * cacheable file instead of six. It carries no canvas data, so there is
   * nothing on it to authorise, and having it outside `/d/` keeps this module's
   * routing to exactly: the script, the page, the manifest and the view. */

  const segments = urlPath.split('/').filter(Boolean);
  let token: string | null = null;
  try {
    token = segments.length === 2 || segments.length === 3 ? decodeURIComponent(segments[1]) : null;
  } catch {
    token = null;
  }
  const tail = segments.length === 3 ? segments[2] : null;
  if (tail !== null && tail !== 'manifest' && tail !== 'view') {
    sendDisplayNotFound(res);
    return true;
  }

  /* The ONLY resolution on this surface, and it consults the screen index
   * alone. `null` covers malformed, unknown and revoked identically. */
  const record = token !== null && isScreenToken(token) ? await ctx.screens.resolve(token) : null;
  if (record === null) {
    sendDisplayNotFound(res);
    return true;
  }

  /* NOTE THE ABSENCE: no access lookup, no passphrase, no session. A screen
   * token is sufficient on its own - see rule 1. */
  const got = await ctx.store.get(record.target.id);
  if (!got.ok) {
    /* A screen pointing at a canvas that is gone is the same miss as a token
     * nobody issued. It must not become a "that canvas was deleted" oracle. */
    sendDisplayNotFound(res);
    return true;
  }
  const revision = got.value.metadata.revision;

  if (tail === 'manifest') {
    /* Proof of life, recorded before the answer is chosen, so a 304 counts
     * exactly as much as a 200 - a display that is up to date is the one most
     * likely to be 304ing forever, and it is the one an operator most needs
     * to see as alive. */
    await ctx.screens.touch(record.id, revision);

    const etag = manifestEtag(record, revision);
    res.setHeader('ETag', etag);
    if (ifNoneMatch(req.headers['if-none-match']) === etag) {
      res.statusCode = 304;
      displayHeaders(res, 'application/json; charset=utf-8');
      res.end();
      return true;
    }
    const body = JSON.stringify({
      target: record.target,
      revision,
      updatedAt: got.value.metadata.updatedAt,
      pollIntervalSeconds: pollSeconds(ctx.config),
      pollJitterRatio: POLL_JITTER_RATIO,
    }, null, 2) + '\n';
    res.statusCode = 200;
    displayHeaders(res, 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  if (tail === 'view') {
    /* ONE `now` for the document preparation and the render, and no fetch on
     * this path at all: the feeds were filled by their own timers. Six screens
     * polling this route every sixty seconds produce zero provider requests. */
    const view = prepareRender(got.value, ctx, 'private');
    const body = JSON.stringify({
      revision,
      html: renderDisplayFragment(view.doc, view.options),
    }) + '\n';
    res.statusCode = 200;
    displayHeaders(res, 'application/json; charset=utf-8');
    res.setHeader('ETag', manifestEtag(record, revision));
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  res.statusCode = 200;
  displayHeaders(res, 'text/html; charset=utf-8');
  res.setHeader('ETag', manifestEtag(record, revision));
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const page = prepareRender(got.value, ctx, 'private');
  res.end(renderDisplayPage(page.doc, page.options));
  return true;
}
