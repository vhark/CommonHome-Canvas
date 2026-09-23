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
/* Canvas persistence: one JSON file per canvas under CANVAS_DATA_DIR.
 *
 * Four decisions carry this module, and each one is a failure mode that has
 * bitten someone else's self-hosted project.
 *
 * 1. PLAIN JSON FILES, ONE PER CANVAS, HUMAN-READABLE ON PURPOSE. A household
 *    must be able to read, back up, diff and hand-edit its own data with no
 *    tool at all, and a corrupt store must be diagnosable with `cat`. A
 *    database is a later decision that will need a measured reason, and the
 *    reason will not be a household with fifty canvases.
 *
 * 2. ATOMIC WRITES. Write a temporary file in the SAME directory, fsync it,
 *    then rename over the target. Rename within a directory is atomic on
 *    POSIX; writing in place is not. The failure this prevents is a half
 *    written document after a power cut, which on a wall display is a blank
 *    screen in someone's kitchen with no explanation.
 *
 * 3. OPTIMISTIC CONCURRENCY, NEVER LAST-WRITE-WINS. Every document carries a
 *    monotonic `metadata.revision`; `update` takes the revision the caller
 *    read and refuses if it has moved. Two tabs, or a person and an agent,
 *    must not silently overwrite each other - the loser is told, not
 *    discarded.
 *
 * 4. IDS ARE 16 RANDOM BYTES. `/c/<id>` will be a URL a display loads with no
 *    credential, so a guessable id is a guessable URL. Sequential ids, time
 *    based ids, and hashes of the name are all enumerable and none of them is
 *    used here.
 *
 * The canonical model in src/canvas owns serialisation, validation and share
 * semantics. This module never re-implements any of it: it calls
 * loadDocument/saveDocument/validateDocument/toShareable and confines itself
 * to identity, durability and concurrency.
 */

import {randomBytes} from 'node:crypto';
import {constants as FS} from 'node:fs';
import {mkdir, open, readFile, readdir, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';

import {
  loadDocument,
  saveDocument,
  toShareable,
  validateDocument,
  type CanvasDocument,
  type CanvasError,
} from '../canvas/index.ts';

/* base64url of 16 bytes is always 22 unpadded characters. The pattern is the
 * ONLY thing that ever reaches the filesystem as a name, which is what makes
 * path traversal through an id structurally impossible rather than scrubbed
 * for: `..`, `/`, `%2e` and a NUL byte all simply fail to match. */
export const CANVAS_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const CANVAS_FILE_PATTERN = /^[A-Za-z0-9_-]{22}\.json$/;

export const DEFAULT_CANVAS_NAME = 'Untitled canvas';
export const COPY_SUFFIX = ' (copy)';

export function newCanvasId(): string {
  return randomBytes(16).toString('base64url');
}

export function isCanvasId(value: unknown): value is string {
  return typeof value === 'string' && CANVAS_ID_PATTERN.test(value);
}

/* A stored canvas is a canonical CanvasDocument whose metadata additionally
 * carries the fields the STORE owns. They live on metadata rather than beside
 * the document so that one file is the whole truth: copying the file copies
 * the canvas, and `cat` shows its revision. */
export type StoredCanvas = CanvasDocument & {
  metadata: {
    uid: string;
    name: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
  };
};

export type CanvasSummary = {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/* A conflict must carry BOTH revisions or the caller cannot tell a stale read
 * from a lost one, and has nothing to show a person beyond "try again". */
export type StoreFailure = CanvasError & {
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
};

export type StoreResult<T> = {ok: true; value: T} | {ok: false; error: StoreFailure};

function fail<T>(error: StoreFailure): StoreResult<T> {
  return {ok: false, error};
}

function succeed<T>(value: T): StoreResult<T> {
  return {ok: true, value};
}

/* One shape for "no such canvas", used for an unknown id AND for a malformed
 * one. They must be indistinguishable: if a malformed id produced a different
 * status, a different body, or even a different message, an attacker probing
 * /api/canvases/<guess> would learn which guesses were well-formed and could
 * narrow the search space. It also means no id is ever echoed back, so the
 * response cannot be used as a reflection oracle either. */
export function notFound(): StoreFailure {
  return {code: 'not_found', message: 'no canvas with that id'};
}

/* Fields the store regenerates on every write. A client may send them; they
 * are always ignored, because identity and revision are the store's to
 * assign. A client-chosen uid would defeat decision 4 above. */
const STORE_OWNED_METADATA = ['uid', 'revision', 'createdAt', 'updatedAt'] as const;

/* Anything a duplicate must not inherit.
 *
 * `screens-and-fleet.md` §5 names three: no screen token, no share token, no
 * passphrase. None of those fields exists yet, which is exactly why this is a
 * delimited SECTION (`metadata.access`) plus a keyword sweep rather than a
 * list of three literal names. The model's own rule is that unknown fields
 * survive a round trip; for a DUPLICATE that rule inverts, because an
 * inherited unknown identity field is precisely the hijack §5 calls "the
 * single most dangerous possible behaviour" - a copy that silently takes over
 * what is on someone's wall. Erring toward dropping a harmless label beats
 * erring toward carrying a live credential.
 *
 * When share tokens are actually built, they belong under `metadata.access`
 * for the same reason `local` is one delimited section: stripping becomes a
 * structural guarantee instead of a list somebody has to remember to extend.
 */
const ACCESS_SECTION = 'access';
/* `accessLevel` is a NON-SECRET display label the document is allowed to
 * carry (the credentials themselves live in a sidecar the document format
 * cannot reach). It still must not travel to a duplicate: a copy that says
 * "passphrase" while having no sidecar would claim a protection it does not
 * have, which is worse than saying nothing. It is named explicitly because it
 * deliberately does NOT match the keyword sweep - it is not secret-ish. */
const ACCESS_LEVEL_LABEL = 'accessLevel';
const SECRETISH = /token|passphrase|password|secret|credential|share|screen/i;

function stripAccess(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === ACCESS_SECTION) continue;
    if (key === ACCESS_LEVEL_LABEL) continue;
    if (SECRETISH.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nameOf(metadata: unknown, fallback: string): string {
  if (isRecord(metadata) && typeof metadata.name === 'string' && metadata.name.trim() !== '') {
    return metadata.name;
  }
  return fallback;
}

/* Builds the candidate document the store will validate and write. Client
 * input is spread first and store-owned fields are applied last, so no client
 * value can win a collision. */
function stamp(
  input: Record<string, unknown>,
  identity: {id: string; revision: number; createdAt: string; updatedAt: string; name: string},
): unknown {
  const metadata = isRecord(input.metadata) ? {...input.metadata} : {};
  for (const key of STORE_OWNED_METADATA) delete metadata[key];
  return {
    ...input,
    metadata: {
      ...metadata,
      uid: identity.id,
      name: identity.name,
      revision: identity.revision,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    },
  };
}

export type CanvasStoreOptions = {
  /* Injectable so a test can assert on timestamps without sleeping, and so
   * two writes in the same millisecond are still orderable if that ever
   * matters. */
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
};

export class CanvasStore {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #log: (line: string) => void;
  #ready: Promise<void> | null = null;
  /* One promise chain per canvas id, so read-check-write is not interleaved.
   *
   * Without this, optimistic concurrency does not work AT ALL: `update` reads
   * the current revision, compares it and writes, with await points between
   * each step, so ten concurrent updaters all read revision 1, all pass the
   * check and all write - last-write-wins with a revision field bolted on,
   * which is worse than no check because it looks like one. A test caught
   * exactly that.
   *
   * In-process only, and deliberately so. Canvas is one node process serving
   * one household; a second process writing the same directory would need
   * flock, and flock's failure modes on the network filesystems a household
   * might mount (NFS, SMB, a synced folder) are worse than the problem. The
   * atomic rename still guarantees no reader ever sees a partial document in
   * that case - only the revision check would be defeatable, and by a
   * configuration nothing currently creates. */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, options: CanvasStoreOptions = {}) {
    /* A subdirectory rather than the data root: CANVAS_DATA_DIR is a volume
     * that will also hold screens, analytics and whatever comes next, and a
     * flat root would make "which files are canvases" a guess. */
    this.#dir = join(dataDir, 'canvases');
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newCanvasId;
    this.#log = options.log ?? ((line) => console.warn(line));
  }

  get directory(): string {
    return this.#dir;
  }

  /* Idempotent and memoised: every public method awaits it, so an empty data
   * directory is created on first use rather than requiring a setup step.
   * That is what lets the container start on a fresh volume with no
   * configuration. */
  async init(): Promise<void> {
    this.#ready ??= mkdir(this.#dir, {recursive: true}).then(() => undefined);
    return this.#ready;
  }

  #pathFor(id: string): string {
    /* Unreachable for a caller-supplied id because every entry point checks
     * the pattern first; asserted anyway, because the cost of being wrong
     * here is an arbitrary filesystem write. */
    if (!isCanvasId(id)) throw new Error('refusing to build a path from a non-id');
    return join(this.#dir, `${id}.json`);
  }

  async list(): Promise<CanvasSummary[]> {
    await this.init();
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return [];
    }
    const summaries: CanvasSummary[] = [];
    for (const entry of entries) {
      /* Temporary files are dot-prefixed and cannot match this, so a listing
       * taken mid-write never sees a half-written document. */
      if (!CANVAS_FILE_PATTERN.test(entry)) continue;
      const id = entry.slice(0, -'.json'.length);
      const got = await this.get(id);
      if (!got.ok) {
        /* One unreadable file must not take the whole list down. A household
         * with a corrupt canvas should still see the other nine and be told
         * which one to look at. */
        this.#log(`[canvas] skipping unreadable canvas ${id}: ${got.error.code}`);
        continue;
      }
      summaries.push(summarise(got.value));
    }
    /* Most recently touched first: the useful default for a list a person
     * reads, and deterministic (id breaks ties) so the order does not shuffle
     * between reads of an untouched store. */
    summaries.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return summaries;
  }

  async get(id: string): Promise<StoreResult<StoredCanvas>> {
    await this.init();
    if (!isCanvasId(id)) return fail(notFound());
    let text: string;
    try {
      text = await readFile(this.#pathFor(id), 'utf8');
    } catch {
      return fail(notFound());
    }
    const loaded = loadDocument(text);
    if (!loaded.ok) {
      /* A file that exists but will not parse is NOT a 404. Telling a
       * household "no such canvas" about a canvas they can see in their data
       * directory is the kind of answer that sends someone restoring a
       * backup they did not need. */
      return fail({...loaded.error, code: `stored_${loaded.error.code}`});
    }
    const doc = loaded.value;
    if (doc.metadata.uid !== id) {
      return fail({
        code: 'id_mismatch',
        message: 'the stored document does not claim the id of the file holding it',
        path: 'metadata.uid',
      });
    }
    return succeed(asStored(doc));
  }

  async create(input: unknown): Promise<StoreResult<StoredCanvas>> {
    await this.init();
    if (!isRecord(input)) {
      return fail({code: 'not_an_object', message: 'a canvas document must be an object'});
    }
    const at = this.#now().toISOString();
    const id = this.#newId();
    const candidate = stamp(input, {
      id,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      name: nameOf(input.metadata, DEFAULT_CANVAS_NAME),
    });
    const checked = validateDocument(candidate);
    if (!checked.ok) return fail(checked.error);

    const doc = asStored(checked.value);
    /* `wx`: refuse to clobber. With 128 bits of randomness a collision is not
     * a thing that happens, but "not a thing that happens" is how silent data
     * loss gets written, and the flag costs nothing. */
    await writeAtomic(this.#pathFor(id), saveDocument(doc), {exclusive: true});
    return succeed(doc);
  }

  /* Serialises `work` against every other serialised operation on the same
   * id. The chain entry is cleaned up when it is the last one, so a store
   * holding thousands of canvases over a long run does not leak a promise per
   * id ever touched. */
  async #serialise<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(id) ?? Promise.resolve();
    const run = previous.then(work, work);
    /* Swallowed on the CHAIN only: a rejection must not poison the next
     * caller's turn. The real rejection is still returned to this caller. */
    const chained = run.then(() => undefined, () => undefined);
    this.#chains.set(id, chained);
    try {
      return await run;
    } finally {
      if (this.#chains.get(id) === chained) this.#chains.delete(id);
    }
  }

  async update(
    id: string,
    input: unknown,
    expectedRevision: number,
  ): Promise<StoreResult<StoredCanvas>> {
    await this.init();
    if (!isCanvasId(id)) return fail(notFound());
    return this.#serialise(id, () => this.#update(id, input, expectedRevision));
  }

  async #update(
    id: string,
    input: unknown,
    expectedRevision: number,
  ): Promise<StoreResult<StoredCanvas>> {
    const current = await this.get(id);
    if (!current.ok) return current;

    if (!Number.isInteger(expectedRevision)) {
      return fail({
        code: 'invalid_revision',
        message: 'the expected revision must be a whole number',
        actualRevision: current.value.metadata.revision,
      });
    }
    if (expectedRevision !== current.value.metadata.revision) {
      return fail({
        code: 'revision_conflict',
        message:
          'this canvas changed since you read it; re-read it, reapply your change and retry',
        expectedRevision,
        actualRevision: current.value.metadata.revision,
      });
    }
    if (!isRecord(input)) {
      return fail({code: 'not_an_object', message: 'a canvas document must be an object'});
    }

    const candidate = stamp(input, {
      id,
      revision: current.value.metadata.revision + 1,
      createdAt: current.value.metadata.createdAt,
      updatedAt: this.#now().toISOString(),
      name: nameOf(input.metadata, current.value.metadata.name),
    });
    const checked = validateDocument(candidate);
    if (!checked.ok) return fail(checked.error);

    const doc = asStored(checked.value);
    await writeAtomic(this.#pathFor(id), saveDocument(doc));
    return succeed(doc);
  }

  async remove(id: string): Promise<StoreResult<{id: string}>> {
    await this.init();
    if (!isCanvasId(id)) return fail(notFound());
    /* Serialised with updates on the same id, or a delete landing mid-update
     * would be undone by the update's rename and the canvas would come back
     * from the dead. */
    return this.#serialise(id, async () => {
      try {
        await unlink(this.#pathFor(id));
      } catch {
        return fail<{id: string}>(notFound());
      }
      return succeed({id});
    });
  }

  /* screens-and-fleet.md §5, in full: new id, name suffixed, no links of any
   * kind, no local overrides, independent thereafter.
   *
   * `toShareable` does the stripping of `local` because that is already its
   * job and its rule ("emit an allowlist, not a deny list") is the one that
   * keeps working when a new local field is added. */
  async duplicate(id: string): Promise<StoreResult<StoredCanvas>> {
    const current = await this.get(id);
    if (!current.ok) return current;

    const shareable = toShareable(current.value) as Record<string, unknown>;
    const metadata = stripAccess(
      isRecord(shareable.metadata) ? shareable.metadata : {},
    );
    return this.create({
      ...shareable,
      metadata: {...metadata, name: current.value.metadata.name + COPY_SUFFIX},
    });
  }
}

export function summarise(doc: StoredCanvas): CanvasSummary {
  return {
    id: doc.metadata.uid,
    name: doc.metadata.name,
    revision: doc.metadata.revision,
    createdAt: doc.metadata.createdAt,
    updatedAt: doc.metadata.updatedAt,
  };
}

/* A document that came off disk without the store's own fields - hand-written
 * by a household, or written by an older build - is filled in rather than
 * rejected. Refusing to open a canvas because it has no `updatedAt` would
 * punish exactly the hand-editing the file format exists to permit. */
function asStored(doc: CanvasDocument): StoredCanvas {
  const metadata = doc.metadata as Record<string, unknown>;
  const revision = typeof metadata.revision === 'number' && Number.isInteger(metadata.revision)
    ? metadata.revision
    : 1;
  const createdAt = typeof metadata.createdAt === 'string' ? metadata.createdAt : new Date(0).toISOString();
  return {
    ...doc,
    metadata: {
      ...metadata,
      uid: doc.metadata.uid,
      name: nameOf(metadata, DEFAULT_CANVAS_NAME),
      revision,
      createdAt,
      updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : createdAt,
    },
  } as StoredCanvas;
}

/* Write-temp, fsync, rename.
 *
 * Every step earns its place:
 *  - the temp file is in the SAME directory, because rename is only atomic
 *    within a filesystem and /tmp is routinely a different one;
 *  - its name is dot-prefixed and random, so a concurrent list never sees it
 *    and two concurrent writers never collide on it;
 *  - fsync BEFORE rename, or the rename can reach the disk first and a crash
 *    leaves the target pointing at unflushed (zero-filled) blocks - a rename
 *    of unsynced data is exactly the "0-length file after a power cut" bug;
 *  - the DIRECTORY is fsynced after, because the rename itself is metadata
 *    and is not durable until its parent is flushed;
 *  - the temp file is removed on any failure, so a full disk does not leave
 *    litter that accumulates until the volume is full for good.
 */
export async function writeAtomic(
  target: string,
  contents: string,
  options: {exclusive?: boolean} = {},
): Promise<void> {
  const dir = join(target, '..');
  const temp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);

  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (options.exclusive) {
      /* rename(2) silently replaces its destination, so exclusivity needs its
       * own check. Racy in principle; 128 random bits make the race
       * unreachable, and the alternative (link + unlink) fails on filesystems
       * a household might plausibly mount. */
      let exists = true;
      try {
        const probe = await open(target, FS.O_RDONLY);
        await probe.close();
      } catch {
        exists = false;
      }
      if (exists) throw new Error('refusing to overwrite an existing canvas');
    }
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }

  try {
    const dirHandle = await open(dir, FS.O_RDONLY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* Directory fsync is unsupported on some filesystems. The rename has
     * already happened and is atomic regardless; only its durability across a
     * power cut is weakened, which is not worth failing an otherwise
     * successful write over. */
  }
}
