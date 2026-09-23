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
/* Per-canvas access levels: the credential side of sharing.
 *
 * Six decisions carry this module. Each one is written down because each one
 * had an obvious alternative that is wrong.
 *
 * 1. CREDENTIALS LIVE IN A SIDECAR, NEVER IN THE DOCUMENT. The obvious shape -
 *    `metadata.access` on the canvas document - was measured against the real
 *    `toShareable()` before anything was built, and the token, the hash and
 *    the salt ALL survived into the shareable output. That is not a bug in the
 *    model: the document format deliberately round-trips unknown metadata so a
 *    document written by a newer build survives an older one, and `toShareable`
 *    strips only `local`. Both behaviours are correct and neither is changed
 *    here. Instead the credentials live at CANVAS_DATA_DIR/access/<id>.json,
 *    which the document format cannot reach and an export cannot serialise.
 *    The document may carry at most a NON-SECRET `metadata.accessLevel` for
 *    display.
 *
 *    This fixes duplication for free, and more strongly than the existing
 *    keyword sweep in store.ts: a sidecar is simply not copied.
 *
 * 2. TOKENS ARE 32 RANDOM BYTES AND NEVER A FUNCTION OF THE ID. A token
 *    derived from the canvas id is not a capability, it is an encoding: learn
 *    the derivation once and every canvas in the house is readable. The design
 *    note asks for 128 bits; 256 costs nothing and ends the question.
 *
 * 3. PASSPHRASES ARE SCRYPT, NOT SHA-256. A household passphrase is low
 *    entropy - a few words somebody can say out loud. A fast hash over a low
 *    entropy secret is a wordlist away from plaintext for anyone who obtains
 *    the file, and the file is a plain JSON file in a directory people back
 *    up. scrypt is memory-hard, is in the standard library, and therefore
 *    costs no dependency. The parameters are RECORDED BESIDE EACH HASH so
 *    they can be raised later without invalidating existing passphrases.
 *
 * 4. COMPARISONS ARE CONSTANT-TIME, INCLUDING THE TOKEN LOOKUP. `===` on a
 *    token leaks its prefix through timing, and so does a linear scan that
 *    bails early. Token lookup goes through a map keyed by SHA-256 of the
 *    token - a hash lookup's cost does not depend on how much of the token was
 *    right - and the winning candidate is then confirmed with
 *    `timingSafeEqual`. SHA-256 is the correct hash HERE, unlike (3), because
 *    a 256-bit random token has no wordlist.
 *
 * 5. CREDENTIALS ARE A LIST WITH ONE ENTRY. Passphrase-only is decided; named
 *    viewers are not being built. But per-person revocation is the one thing
 *    named credentials would buy, and storing a list now rather than a scalar
 *    makes that an addition instead of a migration. It costs one pair of
 *    brackets.
 *
 * 6. SESSIONS ARE PERSISTED AS HASHES, NOT HELD IN MEMORY. A 30-day cookie
 *    whose server-side half dies on restart is a 30-day cookie that lasts
 *    until the next container update, which is a promise Canvas would break
 *    weekly. Sessions therefore live in the same sidecar - as SHA-256 of the
 *    session id, so the file cannot be read to steal a live session - and
 *    rotation clears the list, which is what makes revocation immediate and
 *    total rather than eventual.
 */

import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, readdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';

import {writeAtomic, isCanvasId} from './store.ts';

/* ---------------------------------------------------------------- levels -- */

export const ACCESS_LEVELS = ['private', 'link', 'passphrase'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/* The default, and the default for a canvas that says nothing. A level you
 * get by accident must be the closed one. */
export const DEFAULT_ACCESS_LEVEL: AccessLevel = 'private';

/* The non-secret field the DOCUMENT is allowed to carry, for display only.
 * Authority lives in the sidecar; this is a label. */
export const ACCESS_LEVEL_FIELD = 'accessLevel';

/* ---------------------------------------------------------------- scrypt -- */

/* Chosen by measurement on this class of hardware, then recorded in every
 * stored record so they can be raised without a migration.
 *
 *   N = 2^15 (32768), r = 8, p = 1, 32-byte key, 16-byte salt
 *
 * N=2^15 costs 128*N*r = 32 MiB of memory and ~110ms on a modern x86 core,
 * which is roughly half a second on the Raspberry-Pi-class board a household
 * display server plausibly runs on. That is the top of what an interactive
 * unlock can spend without feeling broken, and the memory cost is the point:
 * it is what a GPU or ASIC wordlist attack cannot parallelise cheaply, which
 * is exactly the attack a four-word household passphrase loses to against any
 * fast hash. maxmem is set above 128*N*r because Node's default (32 MiB) is
 * exactly at the boundary and would throw. */
export const SCRYPT_PARAMS = {N: 32768, r: 8, p: 1, keyLength: 32} as const;
export const SALT_BYTES = 16;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export type ScryptParams = {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
};

function derive(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      /* Normalised so a passphrase typed with a composed accent on one device
       * and a combining one on another is the same passphrase. */
      passphrase.normalize('NFKC'),
      salt,
      params.keyLength,
      {N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM},
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export type Credential = {
  readonly id: string;
  readonly label: string;
  readonly algorithm: 'scrypt';
  readonly params: ScryptParams;
  readonly salt: string;
  readonly hash: string;
  readonly createdAt: string;
};

export async function hashPassphrase(
  passphrase: string,
  options: {params?: ScryptParams; now?: () => Date; label?: string} = {},
): Promise<Credential> {
  const params = options.params ?? SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(passphrase, salt, params);
  return {
    id: randomUUID(),
    label: options.label ?? 'passphrase',
    algorithm: 'scrypt',
    params,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

/* Constant-time against the stored hash. A record whose parameters this build
 * cannot honour fails closed rather than falling back to something weaker. */
export async function verifyPassphrase(credential: Credential, passphrase: string): Promise<boolean> {
  if (credential.algorithm !== 'scrypt') return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(credential.hash, 'base64');
  } catch {
    return false;
  }
  const params = credential.params;
  if (
    !Number.isInteger(params?.N) || !Number.isInteger(params?.r) ||
    !Number.isInteger(params?.p) || !Number.isInteger(params?.keyLength) ||
    params.keyLength !== expected.length
  ) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = await derive(passphrase, Buffer.from(credential.salt, 'base64'), params);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ---------------------------------------------------------------- tokens -- */

/* base64url of 32 bytes is always 43 unpadded characters. As with canvas ids,
 * the pattern is the only thing that ever reaches a lookup, so a token
 * containing `/`, `..`, `%2e` or a NUL simply fails to match. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_TOKEN_BYTES = 32;

export function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function isShareToken(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value);
}

/* The index key. SHA-256 of a 256-bit random token: there is no wordlist to
 * run, so a fast hash is correct here in a way it is emphatically not for a
 * passphrase. Its purpose is to make lookup cost independent of how much of
 * the token the caller guessed right. */
function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/* Logs and analytics get this, never the token. A share link that turns up in
 * a log file is a share link that has been published. */
export function tokenFingerprint(token: string): string {
  return tokenKey(token).slice(0, 12);
}

/* -------------------------------------------------------------- sessions -- */

export type SessionTimeout =
  /* "Never" in the design note means until the browser closes, NOT until the
   * heat death of the universe: a cookie with no Expires is a session cookie,
   * which is the honest reading of "no timeout" for a shared link. */
  | {readonly kind: 'session'}
  | {readonly kind: 'days'; readonly days: number};

export const DEFAULT_SESSION_DAYS = 30;
export const MAX_SESSION_DAYS = 3650;
const SESSION_ID_BYTES = 32;

export type StoredSession = {
  readonly hash: string;
  readonly createdAt: string;
  /* null means session-lifetime: the server keeps it until rotation or
   * restart-independent cleanup, the browser drops it when it closes. */
  readonly expiresAt: string | null;
};

export function parseSessionTimeout(value: unknown): SessionTimeout | null {
  if (value === undefined || value === null) return null;
  if (value === 'session') return {kind: 'session'};
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_DAYS) {
    return {kind: 'days', days: value};
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return parseSessionTimeout(Number(value.trim()));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.kind === 'session') return {kind: 'session'};
    if (record.kind === 'days') return parseSessionTimeout(record.days);
  }
  return null;
}

/* ---------------------------------------------------------------- record -- */

export type AccessRecord = {
  readonly version: 1;
  readonly canvasId: string;
  readonly level: AccessLevel;
  /* Absent at `private`: a private canvas has no share link to revoke,
   * because it never had one. */
  readonly shareToken: string | null;
  readonly credentials: readonly Credential[];
  readonly sessionTimeout: SessionTimeout;
  readonly sessions: readonly StoredSession[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

/* What an owner may be told about their own canvas. The token IS included -
 * it is the share link and the whole point - but hashes and salts are not,
 * because nothing outside this module ever needs them. */
export type AccessDescription = {
  readonly level: AccessLevel;
  readonly shareToken: string | null;
  readonly sharePath: string | null;
  readonly hasPassphrase: boolean;
  readonly sessionTimeout: SessionTimeout;
  readonly activeSessions: number;
  readonly updatedAt: string;
};

export function describeAccess(record: AccessRecord | null, now = new Date()): AccessDescription {
  if (record === null) {
    return {
      level: DEFAULT_ACCESS_LEVEL,
      shareToken: null,
      sharePath: null,
      hasPassphrase: false,
      sessionTimeout: {kind: 'days', days: DEFAULT_SESSION_DAYS},
      activeSessions: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    level: record.level,
    shareToken: record.shareToken,
    sharePath: record.shareToken === null ? null : `/s/${record.shareToken}`,
    hasPassphrase: record.credentials.length > 0,
    sessionTimeout: record.sessionTimeout,
    activeSessions: live(record.sessions, now).length,
    updatedAt: record.updatedAt,
  };
}

function live(sessions: readonly StoredSession[], now: Date): StoredSession[] {
  const t = now.getTime();
  return sessions.filter((s) => s.expiresAt === null || Date.parse(s.expiresAt) > t);
}

/* --------------------------------------------------------- rate limiting -- */

/* Per-token, in-memory, growing delay. A four-word household passphrase falls
 * quickly to an unthrottled online attack; the delay is what turns "a weekend"
 * into "longer than the canvas will exist".
 *
 * In-memory is deliberate. Persisting failure counters would let anyone who
 * can reach the link fill a disk, and a restart resetting the counter costs an
 * attacker a restart they cannot cause. */
export const ATTEMPT_BASE_DELAY_MS = 500;
export const ATTEMPT_MAX_DELAY_MS = 30_000;
/* Free attempts before the delay starts: a person mistyping their own
 * passphrase twice should not be punished. */
export const ATTEMPT_GRACE = 2;

export type Throttle = {readonly allowed: boolean; readonly retryAfterMs: number};

export class AttemptLimiter {
  readonly #failures = new Map<string, {count: number; nextAllowedAt: number}>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  check(token: string): Throttle {
    const entry = this.#failures.get(tokenKey(token));
    if (entry === undefined) return {allowed: true, retryAfterMs: 0};
    const wait = entry.nextAllowedAt - this.#now();
    return wait > 0 ? {allowed: false, retryAfterMs: wait} : {allowed: true, retryAfterMs: 0};
  }

  fail(token: string): Throttle {
    const key = tokenKey(token);
    const entry = this.#failures.get(key) ?? {count: 0, nextAllowedAt: 0};
    entry.count += 1;
    const over = Math.max(0, entry.count - ATTEMPT_GRACE);
    const delay = over === 0
      ? 0
      : Math.min(ATTEMPT_BASE_DELAY_MS * 2 ** (over - 1), ATTEMPT_MAX_DELAY_MS);
    entry.nextAllowedAt = this.#now() + delay;
    this.#failures.set(key, entry);
    return {allowed: delay === 0, retryAfterMs: delay};
  }

  succeed(token: string): void {
    this.#failures.delete(tokenKey(token));
  }

  /* Rotation must not carry a throttle onto a token that did not earn it, and
   * must not leave a dead token's counter behind forever. */
  forget(token: string): void {
    this.#failures.delete(tokenKey(token));
  }
}

/* ----------------------------------------------------------------- store -- */

const ACCESS_FILE_PATTERN = /^[A-Za-z0-9_-]{22}\.json$/;

export type AccessStoreOptions = {
  readonly now?: () => Date;
  readonly newToken?: () => string;
  readonly newSessionId?: () => string;
  readonly params?: ScryptParams;
  readonly defaultTimeout?: SessionTimeout;
  readonly log?: (line: string) => void;
};

export type UnlockOutcome =
  | {readonly ok: true; readonly sessionId: string; readonly expiresAt: Date | null}
  | {readonly ok: false; readonly reason: 'wrong' | 'throttled'; readonly retryAfterMs: number};

export class AccessStore {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #newToken: () => string;
  readonly #newSessionId: () => string;
  readonly #params: ScryptParams;
  readonly #defaultTimeout: SessionTimeout;
  readonly #log: (line: string) => void;
  readonly limiter: AttemptLimiter;
  #ready: Promise<void> | null = null;
  /* tokenKey -> canvas id. Rebuilt from disk on init and maintained on every
   * write, so a lookup is one hash and one map probe regardless of how many
   * canvases exist and regardless of how wrong the token was. */
  readonly #index = new Map<string, string>();
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, options: AccessStoreOptions = {}) {
    this.#dir = join(dataDir, 'access');
    this.#now = options.now ?? (() => new Date());
    this.#newToken = options.newToken ?? newShareToken;
    this.#newSessionId = options.newSessionId ?? (() => randomBytes(SESSION_ID_BYTES).toString('base64url'));
    this.#params = options.params ?? SCRYPT_PARAMS;
    this.#defaultTimeout = options.defaultTimeout ?? {kind: 'days', days: DEFAULT_SESSION_DAYS};
    this.#log = options.log ?? ((line) => console.warn(line));
    this.limiter = new AttemptLimiter();
  }

  get directory(): string {
    return this.#dir;
  }

  async init(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    /* 0o700: the access directory holds hashes and live session material and
     * has no business being world-readable on a shared box. */
    await mkdir(this.#dir, {recursive: true, mode: 0o700});
    let entries: string[] = [];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!ACCESS_FILE_PATTERN.test(entry)) continue;
      const id = entry.slice(0, -'.json'.length);
      const record = await this.#read(id);
      if (record === null) continue;
      if (record.shareToken !== null) this.#index.set(tokenKey(record.shareToken), id);
    }
  }

  #pathFor(id: string): string {
    if (!isCanvasId(id)) throw new Error('refusing to build a path from a non-id');
    return join(this.#dir, `${id}.json`);
  }

  async #read(id: string): Promise<AccessRecord | null> {
    let text: string;
    try {
      text = await readFile(this.#pathFor(id), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as AccessRecord;
      if (parsed?.version !== 1 || parsed.canvasId !== id) {
        this.#log(`[canvas] ignoring malformed access record for ${id}`);
        return null;
      }
      /* A record that fails to name a level it understands is treated as
       * private, never as open. Failing closed on a corrupt credential file is
       * the only safe direction. */
      if (!isAccessLevel(parsed.level)) return {...parsed, level: 'private'};
      return parsed;
    } catch {
      this.#log(`[canvas] ignoring unreadable access record for ${id}`);
      return null;
    }
  }

  async #write(record: AccessRecord): Promise<AccessRecord> {
    await writeAtomic(this.#pathFor(record.canvasId), JSON.stringify(record, null, 2) + '\n');
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

  async read(id: string): Promise<AccessRecord | null> {
    await this.init();
    if (!isCanvasId(id)) return null;
    return this.#read(id);
  }

  async levelOf(id: string): Promise<AccessLevel> {
    return (await this.read(id))?.level ?? DEFAULT_ACCESS_LEVEL;
  }

  /* Sets the level, minting a token the first time one is needed and keeping
   * the existing one otherwise - changing the level from `link` to
   * `passphrase` must not invalidate a link the household already sent out,
   * because that is a rotation and rotation is a separate, explicit act. */
  async set(
    id: string,
    input: {
      readonly level: AccessLevel;
      readonly passphrase?: string | null;
      readonly sessionTimeout?: SessionTimeout | null;
    },
  ): Promise<{ok: true; record: AccessRecord} | {ok: false; code: string; message: string}> {
    await this.init();
    if (!isCanvasId(id)) return {ok: false, code: 'not_found', message: 'no canvas with that id'};
    return this.#serialise(id, async () => {
      const existing = await this.#read(id);
      const at = this.#now().toISOString();

      if (input.level === 'private') {
        await this.#forget(id, existing);
        return {ok: true as const, record: {
          version: 1 as const,
          canvasId: id,
          level: 'private' as const,
          shareToken: null,
          credentials: [],
          sessionTimeout: input.sessionTimeout ?? existing?.sessionTimeout ?? this.#defaultTimeout,
          sessions: [],
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        }};
      }

      let credentials = existing?.credentials ?? [];
      if (typeof input.passphrase === 'string' && input.passphrase !== '') {
        /* Changing the passphrase is a revocation, so it ends the sessions it
         * granted. The design note is explicit: "Changing the passphrase
         * invalidates every existing unlock, which is what makes it a
         * revocation and not just an edit." */
        credentials = [await hashPassphrase(input.passphrase, {params: this.#params, now: this.#now})];
      } else if (input.passphrase === null) {
        credentials = [];
      }
      if (input.level === 'passphrase' && credentials.length === 0) {
        return {
          ok: false as const,
          code: 'passphrase_required',
          message: 'level "passphrase" needs a passphrase; none is set and none was supplied',
        };
      }

      const rotatedCredential = credentials !== (existing?.credentials ?? []);
      const token = existing?.shareToken ?? this.#newToken();
      const record: AccessRecord = {
        version: 1,
        canvasId: id,
        level: input.level,
        shareToken: token,
        credentials,
        sessionTimeout: input.sessionTimeout ?? existing?.sessionTimeout ?? this.#defaultTimeout,
        sessions: rotatedCredential ? [] : live(existing?.sessions ?? [], this.#now()),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      this.#index.set(tokenKey(token), id);
      await this.#write(record);
      return {ok: true as const, record};
    });
  }

  async #forget(id: string, existing: AccessRecord | null): Promise<void> {
    if (existing?.shareToken) {
      this.#index.delete(tokenKey(existing.shareToken));
      this.limiter.forget(existing.shareToken);
    }
    await unlink(this.#pathFor(id)).catch(() => undefined);
  }

  /* Back to private, and the sidecar goes away entirely. */
  async clear(id: string): Promise<void> {
    await this.init();
    if (!isCanvasId(id)) return;
    await this.#serialise(id, async () => {
      await this.#forget(id, await this.#read(id));
    });
  }

  /* A share link you cannot withdraw is not a share link. Rotation mints a new
   * token, drops the old one from the index in the same turn, and clears every
   * session - so an unlocked browser holding the old link loses both halves at
   * once rather than keeping a session that outlives the URL. */
  async rotate(id: string): Promise<AccessRecord | null> {
    await this.init();
    if (!isCanvasId(id)) return null;
    return this.#serialise(id, async () => {
      const existing = await this.#read(id);
      if (existing === null || existing.level === 'private') return null;
      if (existing.shareToken !== null) {
        this.#index.delete(tokenKey(existing.shareToken));
        this.limiter.forget(existing.shareToken);
      }
      const token = this.#newToken();
      const record: AccessRecord = {
        ...existing,
        shareToken: token,
        sessions: [],
        updatedAt: this.#now().toISOString(),
      };
      this.#index.set(tokenKey(token), id);
      await this.#write(record);
      return record;
    });
  }

  /* Token -> canvas, or null. Malformed, unknown and revoked all return null
   * by the same path so the caller cannot accidentally give them different
   * answers. */
  async resolve(token: unknown): Promise<AccessRecord | null> {
    await this.init();
    if (!isShareToken(token)) return null;
    const id = this.#index.get(tokenKey(token));
    if (id === undefined) return null;
    const record = await this.#read(id);
    if (record === null || record.shareToken === null || record.level === 'private') return null;
    /* The index is keyed by a hash; confirm the token itself in constant time
     * so a SHA-256 collision - or, far more plausibly, a stale index entry -
     * cannot authorise anything. */
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(record.shareToken, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return record;
  }

  /* One attempt. Returns a session on success; on failure says only whether
   * the caller is throttled, never whether a passphrase was close. */
  async unlock(record: AccessRecord, passphrase: unknown): Promise<UnlockOutcome> {
    const token = record.shareToken ?? '';
    const gate = this.limiter.check(token);
    if (!gate.allowed) return {ok: false, reason: 'throttled', retryAfterMs: gate.retryAfterMs};

    let matched = false;
    if (typeof passphrase === 'string') {
      /* Every credential is checked, with no early exit, so the time taken
       * does not reveal which entry matched once this is a list of several. */
      for (const credential of record.credentials) {
        if (await verifyPassphrase(credential, passphrase)) matched = true;
      }
    }
    if (!matched) {
      const next = this.limiter.fail(token);
      return {ok: false, reason: 'wrong', retryAfterMs: next.retryAfterMs};
    }
    this.limiter.succeed(token);
    return this.#serialise(record.canvasId, async () => {
      const current = await this.#read(record.canvasId);
      if (current === null) return {ok: false as const, reason: 'wrong' as const, retryAfterMs: 0};
      const sessionId = this.#newSessionId();
      const now = this.#now();
      const expiresAt = current.sessionTimeout.kind === 'days'
        ? new Date(now.getTime() + current.sessionTimeout.days * 86_400_000)
        : null;
      await this.#write({
        ...current,
        sessions: [
          ...live(current.sessions, now),
          {
            hash: createHash('sha256').update(sessionId, 'utf8').digest('hex'),
            createdAt: now.toISOString(),
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        ],
        updatedAt: now.toISOString(),
      });
      return {ok: true as const, sessionId, expiresAt};
    });
  }

  /* Sessions are per canvas: the record is looked up by canvas id, so a
   * session minted for the family photos is not even a candidate for the
   * finances. */
  async hasSession(record: AccessRecord, sessionId: unknown): Promise<boolean> {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const wanted = Buffer.from(createHash('sha256').update(sessionId, 'utf8').digest('hex'), 'utf8');
    let found = false;
    for (const session of live(record.sessions, this.#now())) {
      const stored = Buffer.from(session.hash, 'utf8');
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) found = true;
    }
    return found;
  }

  async endSessions(id: string): Promise<void> {
    await this.init();
    if (!isCanvasId(id)) return;
    await this.#serialise(id, async () => {
      const current = await this.#read(id);
      if (current === null) return;
      await this.#write({...current, sessions: [], updatedAt: this.#now().toISOString()});
    });
  }
}
