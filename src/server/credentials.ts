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
/* WRITE-ONLY CREDENTIALS. This is the load-bearing module of the phase.
 *
 * A settings page that accepts a token and gives it back is a credential
 * exfiltration endpoint for whoever reaches it - and it is reachable by
 * exactly the audience that matters, because it is the one page holding every
 * secret the household owns. So:
 *
 *   WRITE  set it.
 *   CLEAR  remove it.
 *   READ   NEVER. `describe()` answers {configured, hint, source} and there is
 *          no method on this class that returns a secret to a caller outside
 *          the server process. `resolve()` exists for the one legitimate
 *          consumer - a provider about to make a request - and is deliberately
 *          NOT reachable from any HTTP route.
 *
 * FIVE DECISIONS, each with an obvious wrong alternative.
 *
 * 1. THE HINT IS A HASH PREFIX, NOT THE LAST FOUR CHARACTERS OF THE SECRET.
 *    "ending 4f2a" reads like the tail of the token and the design note wrote
 *    it that way, but a tail IS part of the secret: four characters of a real
 *    token narrows a search and confirms a guess. The hint here is the first
 *    four hex of SHA-256 over the value, which is stable (the same token
 *    always shows the same hint, so a household can tell whether the value
 *    changed), useless to an attacker, and reads identically in the UI.
 *
 * 2. ENVIRONMENT WINS, AND THE UI IS TOLD WHICH. A container configured by
 *    env must not be silently overridden by a stale value somebody typed a
 *    year ago. `source: 'environment'` lets the page say "set by environment"
 *    instead of showing an empty box that invites entering it twice.
 *
 * 3. THE FILE IS 0600 AND SO IS ITS DIRECTORY. `writeAtomic` already opens
 *    its temp file 0600 and rename preserves the mode, so the value is never
 *    momentarily world-readable between creation and a chmod. Verified in the
 *    tests on the real file rather than assumed.
 *
 * 4. A SECRET IS NEVER LOGGED, INCLUDING ON THE WAY TO A FAILURE. There is no
 *    template string in this file that interpolates a value, and the errors
 *    name the credential ID only.
 *
 * 5. ONLY DECLARED IDS ARE STORED. An id no provider asks for is refused
 *    rather than written, so the file cannot accumulate secrets nothing will
 *    ever read - which is a pile of liability with no owner.
 */

import {createHash, timingSafeEqual} from 'node:crypto';
import {chmod, mkdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';

import {declaredCredentialIds} from '../providers/index.ts';
import {writeAtomic} from './store.ts';

export const CREDENTIALS_FILE = 'credentials.json';
export const CREDENTIALS_MODE = 0o600;

/** Where a live value actually came from. `none` is not an error - most
 * providers need no credential at all. */
export type CredentialSource = 'environment' | 'stored' | 'none';

/** EVERYTHING a route is allowed to learn about a credential. There is
 * deliberately no field here that could hold a secret, so a route cannot leak
 * one by serialising this whole object - which is what routes do. */
export type CredentialDescription = {
  readonly id: string;
  readonly configured: boolean;
  /** `ending 4f2a` — derived from a HASH, never from the value itself. */
  readonly hint: string | null;
  readonly source: CredentialSource;
  /** True when the environment holds it, so the UI can disable the field
   * rather than let someone type a value that will be ignored. */
  readonly fromEnvironment: boolean;
  readonly updatedAt: string | null;
};

type StoredCredential = {
  readonly value: string;
  readonly updatedAt: string;
};

type CredentialFile = {
  readonly version: 1;
  readonly credentials: {readonly [id: string]: StoredCredential};
};

/* The environment names a credential can arrive under.
 *
 * Both spellings of the Home Assistant token are honoured, exactly as
 * config.ts does (`HOMEASSISTANT_TOKEN ?? HA_TOKEN`), because a household that
 * already has one in a .env file must not have to rename it to keep working.
 * The list is ordered, and the first non-empty wins. */
export const CREDENTIAL_ENV: Record<string, readonly string[]> = {
  'home-assistant-token': ['HOMEASSISTANT_TOKEN', 'HA_TOKEN'],
  'unsplash-access-key': ['UNSPLASH_ACCESS_KEY'],
};

/** Ids this build will store. Provider-declared ids plus the photo key, which
 * has no provider registry entry yet but is already a real credential this
 * server holds. */
export function storableCredentialIds(): readonly string[] {
  const ids = new Set<string>(declaredCredentialIds());
  for (const id of Object.keys(CREDENTIAL_ENV)) ids.add(id);
  return [...ids].sort();
}

export function isStorableCredentialId(value: unknown): value is string {
  return typeof value === 'string' && storableCredentialIds().includes(value);
}

/* A hash prefix, not a tail of the secret. See decision 1 above. Rendered as
 * "ending 4f2a" because that is the phrase a person recognises, and what it
 * actually identifies - "this is the same value you set before" - is true of
 * a hash prefix and of a tail equally. */
export function hintFor(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 4);
}

function environmentValue(id: string, env: NodeJS.ProcessEnv): string | null {
  for (const name of CREDENTIAL_ENV[id] ?? []) {
    const raw = env[name];
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  return null;
}

export type CredentialStoreOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

export class CredentialStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  #ready: Promise<void> | null = null;
  #cache: CredentialFile = {version: 1, credentials: {}};
  /* One chain for the whole file, because unlike the access sidecar this is a
   * SINGLE file: two concurrent PUTs for different ids would otherwise
   * read-modify-write the same document and one would lose. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: CredentialStoreOptions = {}) {
    this.#dir = dataDir;
    this.#path = join(dataDir, CREDENTIALS_FILE);
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  get path(): string {
    return this.#path;
  }

  async init(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    await mkdir(this.#dir, {recursive: true});
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      /* No file is the NORMAL state, not an error: it is what an empty data
       * directory looks like, and the whole product must work from there. */
      return;
    }
    try {
      const parsed = JSON.parse(text) as CredentialFile;
      if (parsed?.version !== 1 || typeof parsed.credentials !== 'object' || parsed.credentials === null) {
        this.#log('[canvas] ignoring a malformed credentials file');
        return;
      }
      this.#cache = {version: 1, credentials: parsed.credentials};
    } catch {
      /* Never quote the body in the message: the body is the secrets. */
      this.#log('[canvas] ignoring an unreadable credentials file');
    }
    /* Repair the mode on an existing file, in case it was created by an older
     * build, restored from a backup, or copied with a permissive umask. */
    await chmod(this.#path, CREDENTIALS_MODE).catch(() => undefined);
  }

  async #write(next: CredentialFile): Promise<void> {
    await writeAtomic(this.#path, JSON.stringify(next, null, 2) + '\n');
    /* writeAtomic opens its temp file 0600 and rename preserves the mode, so
     * this is belt and braces rather than the only guard - but a mode this
     * important is worth stating twice. */
    await chmod(this.#path, CREDENTIALS_MODE).catch(() => undefined);
    this.#cache = next;
  }

  #serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /* ------------------------------------------------------------- reading -- */

  /** THE ONLY READ OF A VALUE, and it is not reachable from an HTTP route.
   *
   * Environment wins. A stale stored value must never override a container's
   * explicit configuration, because the person who set the env var is the
   * person who is going to debug the screen. */
  async resolve(id: string): Promise<{value: string | null; source: CredentialSource}> {
    await this.init();
    const fromEnv = environmentValue(id, this.#env);
    if (fromEnv !== null) return {value: fromEnv, source: 'environment'};
    const stored = this.#cache.credentials[id];
    if (stored !== undefined && typeof stored.value === 'string' && stored.value !== '') {
      return {value: stored.value, source: 'stored'};
    }
    return {value: null, source: 'none'};
  }

  /** What a ROUTE may say. No secret can travel in this shape. */
  async describe(id: string): Promise<CredentialDescription> {
    await this.init();
    const fromEnv = environmentValue(id, this.#env);
    const stored = this.#cache.credentials[id];
    if (fromEnv !== null) {
      return {
        id,
        configured: true,
        hint: `ending ${hintFor(fromEnv)}`,
        source: 'environment',
        fromEnvironment: true,
        /* An environment variable has no stored timestamp, and inventing
         * "now" would make the page claim it changed on every reload. */
        updatedAt: null,
      };
    }
    if (stored !== undefined && typeof stored.value === 'string' && stored.value !== '') {
      return {
        id,
        configured: true,
        hint: `ending ${hintFor(stored.value)}`,
        source: 'stored',
        fromEnvironment: false,
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
      };
    }
    return {id, configured: false, hint: null, source: 'none', fromEnvironment: false, updatedAt: null};
  }

  async describeAll(): Promise<readonly CredentialDescription[]> {
    await this.init();
    const out: CredentialDescription[] = [];
    for (const id of storableCredentialIds()) out.push(await this.describe(id));
    return out;
  }

  /** Constant-time equality against the live value, for a caller that wants
   * to know whether a submitted value is the one already held - without ever
   * being told what is held. Not currently used by a route; present so that
   * "has this changed?" never has to be answered by reading the secret. */
  async matches(id: string, candidate: string): Promise<boolean> {
    const {value} = await this.resolve(id);
    if (value === null) return false;
    const a = Buffer.from(value, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /* ------------------------------------------------------------- writing -- */

  async set(id: string, value: unknown): Promise<
    {ok: true; description: CredentialDescription} | {ok: false; code: string; message: string}
  > {
    await this.init();
    if (!isStorableCredentialId(id)) {
      return {ok: false, code: 'unknown_credential', message: `no integration uses a credential called ${String(id)}`};
    }
    if (typeof value !== 'string' || value.trim() === '') {
      /* The message names the FIELD, never the value. */
      return {ok: false, code: 'empty_credential', message: 'a credential cannot be empty; use DELETE to clear it'};
    }
    /* Trimmed, because a token pasted from a web page routinely carries a
     * trailing newline and a household should not have to debug that. */
    const trimmed = value.trim();
    return this.#serialise(async () => {
      const next: CredentialFile = {
        version: 1,
        credentials: {
          ...this.#cache.credentials,
          [id]: {value: trimmed, updatedAt: this.#now().toISOString()},
        },
      };
      await this.#write(next);
      return {ok: true as const, description: await this.describe(id)};
    });
  }

  async clear(id: string): Promise<CredentialDescription> {
    await this.init();
    await this.#serialise(async () => {
      if (this.#cache.credentials[id] === undefined) return;
      const credentials = {...this.#cache.credentials};
      delete credentials[id];
      await this.#write({version: 1, credentials});
    });
    /* Described AFTER the clear, so a household that also has the value in
     * the environment is correctly told it is still configured from there -
     * which is the confusing case, and the one worth being right about. */
    return this.describe(id);
  }

  /** The file's mode as it is on disk. Exists so the 0600 claim is verified
   * against the filesystem rather than against this module's intentions. */
  async fileMode(): Promise<number | null> {
    try {
      return (await stat(this.#path)).mode & 0o777;
    } catch {
      return null;
    }
  }
}
