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
/* Screens: the registration that makes a kiosk link stable.
 *
 * A Screen is a named record - "Kitchen tablet", "Hallway TV" - that owns a
 * token and points at what it currently shows. `/d/<token>` resolves through
 * it, which is the whole point: repointing a display is an edit on a phone
 * rather than a trip to the hallway with a keyboard, and the canvas id never
 * becomes a credential.
 *
 * Six decisions carry this module. Each had an obvious alternative that is
 * wrong, and each mirrors a decision already made in access.ts for the same
 * measured reason.
 *
 * 1. A SIDECAR, NEVER THE DOCUMENT. Screen records live at
 *    CANVAS_DATA_DIR/screens/<id>.json. A screen token is a credential, and
 *    the canvas document deliberately round-trips unknown metadata into share
 *    exports (see access.ts decision 1, which measured exactly that). A
 *    sidecar is also what makes "a duplicate inherits no screen" structural:
 *    `duplicate()` copies a document, and a screen is not in it.
 *
 * 2. SCREEN TOKENS AND SHARE TOKENS ARE DISTINCT NAMESPACES. They are minted
 *    by the SAME helper - `newShareToken`, 32 random bytes base64url - because
 *    the strength requirement is identical and two generators would eventually
 *    disagree. They are STORED in different sidecars with different indexes,
 *    and no code path consults both: `/d/` asks only the ScreenStore, `/s/`
 *    asks only the AccessStore. So a screen token presented at `/s/` is an
 *    unknown token and vice versa, and revoking one can never revoke the
 *    other by accident. Their lifetimes are genuinely different - a share to
 *    a grandparent is disposable, a wall display is expected to reconnect
 *    forever - and one revocation policy for two risks is how a display dies
 *    because somebody withdrew a link.
 *
 * 3. `target` IS A TAGGED UNION FROM THE START. `{kind: 'canvas', id}` today,
 *    `{kind: 'loop', id}` later. The tag costs one field now and saves a
 *    migration over records that are, by construction, the things pointed at
 *    by URLs nobody can conveniently change.
 *
 * 4. LOOKUP IS CONSTANT-TIME IN THE TOKEN. A map keyed by SHA-256 of the
 *    token, confirmed with `timingSafeEqual`. Identical reasoning to access.ts
 *    decision 4: a linear scan that bails early leaks the token's prefix
 *    through timing, and a 256-bit random token has no wordlist, so a fast
 *    hash is the correct index here.
 *
 * 5. `lastSeenAt` / `lastSeenRevision` ARE OPERATIONAL STATE, NOT ANALYTICS.
 *    They answer the single most useful question about a fleet - "is the
 *    kitchen tablet alive and showing the current thing?" - and on a wall
 *    display silent failure is the normal failure. They are written on the
 *    manifest poll, which is the cheap request, never on the render.
 *
 * 6. THE POLL INTERVAL CARRIES JITTER, COMPUTED FROM A RATIO THE SERVER
 *    STATES. Six screens booting after a power cut must not become a
 *    synchronised thundering herd, and they will if every display sleeps
 *    exactly 60s from a common start. The jitter function is pure and
 *    exported so it can be tested at its endpoints instead of observed
 *    statistically.
 */

import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, readdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';

import {newShareToken, isShareToken} from './access.ts';
import {
  SCREEN_POLL_DEFAULT_SECONDS,
  SCREEN_POLL_MAX_SECONDS,
  SCREEN_POLL_MIN_SECONDS,
} from './config.ts';
import {writeAtomic, isCanvasId} from './store.ts';

/* ------------------------------------------------------------ identities -- */

/* Same shape as a canvas id - 16 random bytes, base64url, 22 characters - and
 * a SEPARATE predicate on purpose. A screen id and a canvas id are never
 * interchangeable, and sharing `isCanvasId` for both would make that confusion
 * invisible at the call site. As with canvas ids, the pattern is the only
 * thing that reaches the filesystem, so `..`, `/`, `%2e` and NUL cannot. */
export const SCREEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SCREEN_FILE_PATTERN = /^[A-Za-z0-9_-]{22}\.json$/;

export function newScreenId(): string {
  return randomBytes(16).toString('base64url');
}

export function isScreenId(value: unknown): value is string {
  return typeof value === 'string' && SCREEN_ID_PATTERN.test(value);
}

/* Minted by the share-token helper - same 32 bytes, same encoding, same
 * strength - and then kept somewhere else entirely. See decision 2. */
export function newScreenToken(): string {
  return newShareToken();
}

/* Shape only. Whether a well-formed token is a SCREEN token is answered by the
 * screen index and nothing else. */
export function isScreenToken(value: unknown): value is string {
  return isShareToken(value);
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/* For logs. A screen token in a log file is a wall display somebody else can
 * now watch. */
export function screenFingerprint(token: string): string {
  return tokenKey(token).slice(0, 12);
}

/* ---------------------------------------------------------------- record -- */

export type ScreenTarget = {readonly kind: 'canvas'; readonly id: string};

export function isScreenTarget(value: unknown): value is ScreenTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'canvas' && isCanvasId(record.id);
}

export type ScreenRecord = {
  readonly version: 1;
  readonly id: string;
  readonly label: string;
  readonly token: string;
  readonly target: ScreenTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  /* null until the display has polled once. Absent is not zero: "never seen"
   * and "seen showing revision 0" are different operational answers. */
  readonly lastSeenAt: string | null;
  readonly lastSeenRevision: number | null;
};

/* What an admin is told. The token IS included - it is the kiosk URL and the
 * feature is unusable without it - exactly as `describeAccess` returns the
 * share token to the owner of the canvas. */
export type ScreenDescription = {
  readonly id: string;
  readonly label: string;
  readonly token: string;
  readonly displayPath: string;
  readonly target: ScreenTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSeenRevision: number | null;
};

export function describeScreen(record: ScreenRecord): ScreenDescription {
  return {
    id: record.id,
    label: record.label,
    token: record.token,
    displayPath: `${DISPLAY_PREFIX}${record.token}`,
    target: record.target,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    lastSeenRevision: record.lastSeenRevision,
  };
}

export const DISPLAY_PREFIX = '/d/';

export const MAX_LABEL_LENGTH = 120;

/* A label is a human name for a physical thing, shown to an admin. Control
 * characters are stripped rather than rejected because a paste from a phone
 * keyboard should not be an error, and the length is bounded because an
 * unbounded string in a record an unauthenticated-for-now API can write is a
 * disk-filling primitive. */
export function normaliseLabel(value: unknown, fallback = 'Screen'): string {
  if (typeof value !== 'string') return fallback;
  /* eslint-disable-next-line no-control-regex */
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (cleaned === '') return fallback;
  return cleaned.slice(0, MAX_LABEL_LENGTH);
}

/* ------------------------------------------------------------- polling ---- */

export const DEFAULT_POLL_SECONDS = SCREEN_POLL_DEFAULT_SECONDS;
/* A floor, because a household of six screens polling every second is a
 * self-inflicted load test, and a ceiling because a display that checks once a
 * day is not a display that updates. Defined in config.ts - the one module
 * that imports nothing from the server - and re-exported here so callers have
 * one name to reach for and there is still only one definition. */
export const MIN_POLL_SECONDS = SCREEN_POLL_MIN_SECONDS;
export const MAX_POLL_SECONDS = SCREEN_POLL_MAX_SECONDS;

/* +/- 25%. Large enough that six screens started by one power cut spread over
 * a 30-second window on the first poll and diverge further on every poll
 * after; small enough that "60 seconds" is still an honest description of how
 * long an edit takes to appear. */
export const POLL_JITTER_RATIO = 0.25;

/* Pure, and exported so the endpoints can be asserted rather than sampled.
 * `random` is a value in [0, 1) - `Math.random()` in a browser, a fixed number
 * in a test. */
export function nextPollDelayMs(
  intervalMs: number,
  jitterRatio: number,
  random: number,
): number {
  const ratio = Math.min(Math.max(jitterRatio, 0), 0.9);
  const spread = intervalMs * ratio;
  const offset = (random * 2 - 1) * spread;
  /* Never below a second, whatever an operator or a hostile config asks for:
   * a zero delay is a busy loop on a device with no operator standing at it. */
  return Math.max(1000, Math.round(intervalMs + offset));
}

/* ----------------------------------------------------------------- store -- */

export type ScreenStoreOptions = {
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly newToken?: () => string;
  readonly log?: (line: string) => void;
};

export type ScreenFailure = {readonly code: string; readonly message: string; readonly path?: string};
export type ScreenResult<T> = {ok: true; value: T} | {ok: false; error: ScreenFailure};

/* One shape for "no such screen", for an unknown id AND a malformed one, for
 * the same reason `notFound()` exists in store.ts: a different answer for a
 * malformed id tells a prober which guesses were well-formed. */
export function screenNotFound(): ScreenFailure {
  return {code: 'not_found', message: 'no screen with that id'};
}

export class ScreenStore {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #newToken: () => string;
  readonly #log: (line: string) => void;
  #ready: Promise<void> | null = null;
  /* tokenKey -> screen id. Rebuilt from disk on init, maintained on every
   * write. This map is the ONLY thing that turns a token into a screen, and
   * nothing else in the process reads it - which is decision 2 made
   * structural rather than documented. */
  readonly #index = new Map<string, string>();
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, options: ScreenStoreOptions = {}) {
    this.#dir = join(dataDir, 'screens');
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newScreenId;
    this.#newToken = options.newToken ?? newScreenToken;
    this.#log = options.log ?? ((line) => console.warn(line));
  }

  get directory(): string {
    return this.#dir;
  }

  async init(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    /* 0o700: these files hold live display credentials. */
    await mkdir(this.#dir, {recursive: true, mode: 0o700});
    let entries: string[] = [];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!SCREEN_FILE_PATTERN.test(entry)) continue;
      const record = await this.#read(entry.slice(0, -'.json'.length));
      if (record === null) continue;
      this.#index.set(tokenKey(record.token), record.id);
    }
  }

  #pathFor(id: string): string {
    if (!isScreenId(id)) throw new Error('refusing to build a path from a non-id');
    return join(this.#dir, `${id}.json`);
  }

  async #read(id: string): Promise<ScreenRecord | null> {
    let text: string;
    try {
      text = await readFile(this.#pathFor(id), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as ScreenRecord;
      if (
        parsed?.version !== 1 ||
        parsed.id !== id ||
        !isScreenToken(parsed.token) ||
        !isScreenTarget(parsed.target)
      ) {
        /* A record this build cannot understand is not a screen. Failing
         * closed means a corrupt file stops a display updating; failing open
         * would mean a corrupt file decides what is on a wall. */
        this.#log(`[canvas] ignoring malformed screen record ${id}`);
        return null;
      }
      return parsed;
    } catch {
      this.#log(`[canvas] ignoring unreadable screen record ${id}`);
      return null;
    }
  }

  async #write(record: ScreenRecord): Promise<ScreenRecord> {
    await writeAtomic(this.#pathFor(record.id), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  async #serialise<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(id) ?? Promise.resolve();
    const run = previous.then(work, work);
    const chained = run.then(() => undefined, () => undefined);
    this.#chains.set(id, chained);
    try {
      return await run;
    } finally {
      if (this.#chains.get(id) === chained) this.#chains.delete(id);
    }
  }

  async list(): Promise<ScreenRecord[]> {
    await this.init();
    let entries: string[] = [];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return [];
    }
    const out: ScreenRecord[] = [];
    for (const entry of entries) {
      if (!SCREEN_FILE_PATTERN.test(entry)) continue;
      const record = await this.#read(entry.slice(0, -'.json'.length));
      if (record !== null) out.push(record);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return out;
  }

  async read(id: string): Promise<ScreenRecord | null> {
    await this.init();
    if (!isScreenId(id)) return null;
    return this.#read(id);
  }

  async create(input: {label?: unknown; target?: unknown}): Promise<ScreenResult<ScreenRecord>> {
    await this.init();
    if (!isScreenTarget(input.target)) {
      return {
        ok: false,
        error: {
          code: 'invalid_target',
          message: 'target must be {"kind":"canvas","id":"<canvas id>"}',
          path: 'target',
        },
      };
    }
    const at = this.#now().toISOString();
    const id = this.#newId();
    const token = this.#newToken();
    const record: ScreenRecord = {
      version: 1,
      id,
      label: normaliseLabel(input.label),
      token,
      target: {kind: 'canvas', id: input.target.id},
      createdAt: at,
      updatedAt: at,
      lastSeenAt: null,
      lastSeenRevision: null,
    };
    this.#index.set(tokenKey(token), id);
    await this.#write(record);
    return {ok: true, value: record};
  }

  /* Rename, repoint, or both - and NEVER re-mint the token. That is the core
   * promise of the whole phase: the URL taped to the back of a television
   * outlives every decision about what it shows. Rotation is a separate,
   * explicit act. */
  async update(
    id: string,
    input: {label?: unknown; target?: unknown},
  ): Promise<ScreenResult<ScreenRecord>> {
    await this.init();
    if (!isScreenId(id)) return {ok: false, error: screenNotFound()};
    if (input.target !== undefined && !isScreenTarget(input.target)) {
      return {
        ok: false,
        error: {
          code: 'invalid_target',
          message: 'target must be {"kind":"canvas","id":"<canvas id>"}',
          path: 'target',
        },
      };
    }
    return this.#serialise(id, async () => {
      const existing = await this.#read(id);
      if (existing === null) return {ok: false as const, error: screenNotFound()};
      const record: ScreenRecord = {
        ...existing,
        label: input.label === undefined ? existing.label : normaliseLabel(input.label, existing.label),
        target: input.target === undefined
          ? existing.target
          : {kind: 'canvas', id: (input.target as ScreenTarget).id},
        updatedAt: this.#now().toISOString(),
      };
      await this.#write(record);
      return {ok: true as const, value: record};
    });
  }

  /* New token, old one dead in the same turn. The index entry goes first so
   * there is no window in which both tokens resolve. */
  async rotate(id: string): Promise<ScreenResult<ScreenRecord>> {
    await this.init();
    if (!isScreenId(id)) return {ok: false, error: screenNotFound()};
    return this.#serialise(id, async () => {
      const existing = await this.#read(id);
      if (existing === null) return {ok: false as const, error: screenNotFound()};
      this.#index.delete(tokenKey(existing.token));
      const token = this.#newToken();
      this.#index.set(tokenKey(token), id);
      const record: ScreenRecord = {
        ...existing,
        token,
        updatedAt: this.#now().toISOString(),
        /* The paired display is, as of this instant, not the thing polling.
         * Claiming it was "last seen" a second ago would be a lie about a
         * screen that is now showing a cached render forever. */
        lastSeenAt: null,
        lastSeenRevision: null,
      };
      await this.#write(record);
      return {ok: true as const, value: record};
    });
  }

  async remove(id: string): Promise<ScreenResult<{id: string}>> {
    await this.init();
    if (!isScreenId(id)) return {ok: false, error: screenNotFound()};
    return this.#serialise(id, async () => {
      const existing = await this.#read(id);
      if (existing === null) return {ok: false as const, error: screenNotFound()};
      this.#index.delete(tokenKey(existing.token));
      await unlink(this.#pathFor(id)).catch(() => undefined);
      return {ok: true as const, value: {id}};
    });
  }

  /* Token -> screen, or null. Malformed, unknown and revoked all leave by the
   * same door, so a caller cannot accidentally give them different answers. */
  async resolve(token: unknown): Promise<ScreenRecord | null> {
    await this.init();
    if (!isScreenToken(token)) return null;
    const id = this.#index.get(tokenKey(token));
    if (id === undefined) return null;
    const record = await this.#read(id);
    if (record === null) return null;
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(record.token, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return record;
  }

  /* Written on the manifest poll. Deliberately best-effort and never fatal: a
   * display that cannot be bookkept must still be told what to render. */
  async touch(id: string, revision: number | null): Promise<void> {
    if (!isScreenId(id)) return;
    await this.#serialise(id, async () => {
      const existing = await this.#read(id);
      if (existing === null) return;
      await this.#write({
        ...existing,
        lastSeenAt: this.#now().toISOString(),
        lastSeenRevision: revision,
      });
    }).catch(() => undefined);
  }
}
