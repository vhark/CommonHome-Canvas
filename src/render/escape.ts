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
/* ONE escaper for the whole product.
 *
 * Every string a renderer emits came from somewhere a household typed, or from
 * an upstream provider: a canvas name, a text block's body, a calendar title, a
 * photographer's name. All of it lands on a URL a wall display loads
 * automatically and unattended, with nobody watching the screen and nobody
 * reading the source. That makes an unescaped interpolation stored XSS on a
 * device that is never audited.
 *
 * There were previously two private copies of this function (display.ts and
 * api.ts). Two copies of a security primitive is one copy that will eventually
 * be missing a character, so both now import this one.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text and attribute values alike. Quotes are escaped, so one function is
 * sufficient for both positions and there is no way to pick the wrong one. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!);
}

/* A URL is not just text: `javascript:` in an href or an `src` executes, and
 * escaping does not stop it because there is no character to escape. So a URL
 * is validated by SCHEME and dropped entirely when it is not one a display may
 * load. Relative URLs are permitted; a scheme-relative `//host/x` is not,
 * because it inherits the page's scheme and reads as a path at a glance.
 *
 * `data:` is allowed for images only (see `safeImageUrl`), never for links. */
const ALLOWED_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function schemeOf(raw: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  return match === null ? null : `${match[1]!.toLowerCase()}:`;
}

function looksRelative(raw: string): boolean {
  /* A single leading slash is a path on this origin. Two is a host. */
  if (raw.startsWith('//')) return false;
  return raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../');
}

/** Escaped href, or null when the URL must not be emitted at all. */
export function safeLinkUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const scheme = schemeOf(raw);
  if (scheme === null) return looksRelative(raw) ? escapeHtml(raw) : null;
  return ALLOWED_LINK_SCHEMES.has(scheme) ? escapeHtml(raw) : null;
}

/** Escaped image src, or null. `data:image/...` is permitted because an
 * inlined thumbnail is a legitimate authored photo and the CSP already limits
 * `img-src` to self, https and data. */
export function safeImageUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const scheme = schemeOf(raw);
  if (scheme === null) return looksRelative(raw) ? escapeHtml(raw) : null;
  if (scheme === 'http:' || scheme === 'https:') return escapeHtml(raw);
  if (scheme === 'data:' && /^data:image\//i.test(raw)) return escapeHtml(raw);
  return null;
}
