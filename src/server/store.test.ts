import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, test} from 'node:test';

import {loadDocument} from '../canvas/index.ts';
import {
  CanvasStore,
  COPY_SUFFIX,
  isCanvasId,
  newCanvasId,
  writeAtomic,
} from './store.ts';

/* Storage-layer tests. The HTTP surface is exercised separately in
 * api.test.ts; these assert against the filesystem directly, because the
 * properties that matter here - a rename that is atomic, a temp file that
 * never survives, a revision that cannot be skipped - are invisible from
 * above an HTTP boundary. */

let root = '';
let store: CanvasStore;

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {name: 'Kitchen'},
    spec: {
      elements: {
        clock: {type: 'clock', namedSize: 'small'},
        photo: {type: 'photo', namedSize: 'square'},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [
          {element: 'clock', col: 0, row: 0},
          {element: 'photo', col: 2, row: 0},
        ],
      },
    },
    ...overrides,
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-store-'));
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

beforeEach(async () => {
  const dir = await mkdtemp(join(root, 'case-'));
  store = new CanvasStore(dir);
  await store.init();
});

test('a document round-trips through disk unchanged', async () => {
  /* The acceptance criterion in the plan: created through the API, read back
   * byte-identical. Asserted against the FILE, not an in-memory cache, or the
   * test would pass with no persistence at all. */
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;

  const fromDisk = await readFile(join(store.directory, `${id}.json`), 'utf8');
  const parsed = loadDocument(fromDisk);
  assert.ok(parsed.ok, 'what was written must be a valid canvas document');
  assert.deepEqual(parsed.value, created.value);

  const got = await store.get(id);
  assert.ok(got.ok);
  assert.deepEqual(got.value, created.value);
  assert.equal(got.value.spec.elements.clock.type, 'clock');
  assert.equal(got.value.metadata.revision, 1);
  assert.equal(got.value.metadata.name, 'Kitchen');
});

test('unknown content written by a newer build survives a round trip', async () => {
  /* The model's rule, asserted through the store: nothing is dropped. A
   * storage layer that re-serialised from its own idea of the schema would
   * quietly destroy documents from a newer version. */
  const created = await store.create(doc({
    spec: {
      elements: {
        mystery: {type: 'from-the-future', namedSize: 'enormous', settings: {depth: 3}},
      },
      layout: {kind: 'Hexagons', authoredDensity: 'standard', rings: 2},
      annotations: ['keep me'],
    },
  }));
  assert.ok(created.ok);
  const got = await store.get(created.value.metadata.uid);
  assert.ok(got.ok);
  assert.deepEqual(got.value.spec.elements.mystery, {
    type: 'from-the-future', namedSize: 'enormous', settings: {depth: 3},
  });
  assert.deepEqual(got.value.spec.annotations, ['keep me']);
  assert.equal(got.value.spec.layout.kind, 'Hexagons');
});

test('ids are unpredictable, not sequential', async () => {
  /* /c/<id> is loaded by a display with no credential, so a guessable id is a
   * guessable URL. Three properties, each of which a naive scheme fails:
   * uniqueness, no ordering between successive ids, and enough entropy that
   * enumeration is not a strategy. */
  const ids = new Set<string>();
  const sequence: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    const id = newCanvasId();
    assert.ok(isCanvasId(id), `${id} is not a well-formed canvas id`);
    assert.equal(id.length, 22, '16 random bytes is 22 unpadded base64url characters');
    ids.add(id);
    sequence.push(id);
  }
  assert.equal(ids.size, 400, 'ids collided, which 128 bits of randomness makes impossible');

  /* A counter, a timestamp, or anything monotonic produces a run of ordered
   * ids. Random ones are ordered about half the time, so a long run either
   * way is the signal. */
  let ascending = 0;
  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i] > sequence[i - 1]) ascending += 1;
  }
  assert.ok(ascending > 120 && ascending < 280,
    `successive ids look ordered (${ascending}/399 ascending); an id derived from a counter or clock is enumerable`);

  /* And every character position varies, which a scheme with a fixed prefix
   * or a shared timestamp head would fail. The last character is the
   * exception by arithmetic, not by weakness: 16 bytes is 128 bits and 22
   * base64url characters carry 132, so the final character encodes only the
   * trailing 2 bits and has exactly four possible values. */
  for (let pos = 0; pos < 21; pos += 1) {
    const distinct = new Set(sequence.map((s) => s[pos]));
    assert.ok(distinct.size > 8, `character ${pos} barely varies across 400 ids`);
  }
  assert.equal(new Set(sequence.map((s) => s[21])).size, 4,
    'the final character carries the trailing two bits and must use all four values');

  /* Ids the store itself issues are the same ones. */
  const a = await store.create(doc());
  const b = await store.create(doc());
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value.metadata.uid, b.value.metadata.uid);
  assert.ok(isCanvasId(a.value.metadata.uid));
});

test('a client cannot choose its own id or revision', async () => {
  /* Identity is the store's to assign. A client-chosen uid would let someone
   * pick a guessable id and defeat the whole point of random ones; a
   * client-chosen revision would let them bypass the concurrency check. */
  const created = await store.create(doc({
    metadata: {name: 'Sneaky', uid: 'aaaaaaaaaaaaaaaaaaaaaa', revision: 99, createdAt: '1999-01-01T00:00:00.000Z'},
  }));
  assert.ok(created.ok);
  assert.notEqual(created.value.metadata.uid, 'aaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(created.value.metadata.revision, 1);
  assert.notEqual(created.value.metadata.createdAt, '1999-01-01T00:00:00.000Z');
});

test('update refuses a stale revision and says what both revisions are', async () => {
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;

  const first = await store.update(id, {...doc(), metadata: {name: 'Kitchen v2'}}, 1);
  assert.ok(first.ok);
  assert.equal(first.value.metadata.revision, 2);
  assert.equal(first.value.metadata.name, 'Kitchen v2');
  assert.equal(first.value.metadata.createdAt, created.value.metadata.createdAt,
    'createdAt belongs to the canvas, not to the write');

  /* The second writer read revision 1, just as the first did. It must be
   * told, not silently win. */
  const stale = await store.update(id, {...doc(), metadata: {name: 'Kitchen other'}}, 1);
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, 'revision_conflict');
  assert.equal(stale.error.expectedRevision, 1);
  assert.equal(stale.error.actualRevision, 2);

  const after = await store.get(id);
  assert.ok(after.ok);
  assert.equal(after.value.metadata.name, 'Kitchen v2', 'the loser must not have overwritten the winner');
  assert.equal(after.value.metadata.revision, 2);
});

test('a revision from the future is refused too', async () => {
  const created = await store.create(doc());
  assert.ok(created.ok);
  const ahead = await store.update(created.value.metadata.uid, doc(), 7);
  assert.ok(!ahead.ok);
  assert.equal(ahead.error.code, 'revision_conflict');
  assert.equal(ahead.error.actualRevision, 1);
});

test('a revision check is refused before any write happens', async () => {
  /* Ordering matters: if the document were written and the revision checked
   * afterwards, a conflicting write would already have destroyed the file. */
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;
  const before = await readFile(join(store.directory, `${id}.json`), 'utf8');
  await store.update(id, {...doc(), metadata: {name: 'nope'}}, 42);
  assert.equal(await readFile(join(store.directory, `${id}.json`), 'utf8'), before);
});

test('an invalid document is rejected with the model\'s structured error', async () => {
  /* Not a 500, and not a bare boolean: the caller gets the code, the message
   * and the path that is wrong, which is the difference between "something
   * went wrong" and "spec.elements.clock has no type". */
  const cases: Array<[unknown, string, string | undefined]> = [
    [{...doc(), apiVersion: 'wrong'}, 'unsupported_api_version', 'apiVersion'],
    [{...doc(), kind: 'Dashboard'}, 'unsupported_kind', 'kind'],
    [{...doc(), spec: undefined}, 'missing_spec', 'spec'],
    [{...doc(), spec: {elements: {a: {namedSize: 'small'}}, layout: doc().spec.layout}},
      'missing_element_type', 'spec.elements.a.type'],
    [{...doc(), spec: {elements: {}, layout: {kind: 'Grid', items: []}}},
      'missing_authored_density', 'spec.layout.authoredDensity'],
    ['not an object', 'not_an_object', undefined],
  ];
  for (const [input, code, path] of cases) {
    const result = await store.create(input);
    assert.ok(!result.ok, `${code} should have been rejected`);
    assert.equal(result.error.code, code);
    assert.ok(result.error.message.length > 0, 'an error must say something useful');
    if (path !== undefined) assert.equal(result.error.path, path);
  }
  assert.deepEqual(await readdir(store.directory), [], 'a rejected document must leave no file');
});

test('an invalid update is rejected and leaves the stored document intact', async () => {
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;
  const bad = await store.update(id, {...doc(), kind: 'Dashboard'}, 1);
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, 'unsupported_kind');

  const still = await store.get(id);
  assert.ok(still.ok);
  assert.equal(still.value.metadata.revision, 1, 'a rejected update must not burn a revision');
  assert.equal(still.value.kind, 'Canvas');
});

test('an unknown id and a malformed id are indistinguishable', async () => {
  /* Probing must learn nothing. If a malformed id produced a different code,
   * message or shape, an attacker walking /api/canvases/<guess> would learn
   * which guesses were even well-formed and could narrow the search. */
  const misses = [
    newCanvasId(),                      // well-formed, does not exist
    'short',
    '../../../../etc/passwd',
    'has/a/slash',
    '../' + newCanvasId(),
    'a'.repeat(23),
    '',
    'AAAAAAAAAAAAAAAAAAAA==',
  ];
  const errors = await Promise.all(misses.map(async (id) => (await store.get(id) as {error: unknown}).error));
  for (const error of errors) {
    assert.deepEqual(error, errors[0], 'a miss must have exactly one shape');
  }
  assert.deepEqual(errors[0], {code: 'not_found', message: 'no canvas with that id'});
  /* And nothing echoes the id back, so the response cannot be a reflection
   * oracle either. */
  for (const id of misses) {
    if (id === '') continue;
    assert.ok(!JSON.stringify(errors[0]).includes(id));
  }

  /* remove() answers identically. */
  const removals = await Promise.all(misses.map(async (id) => (await store.remove(id) as {error: unknown}).error));
  for (const error of removals) assert.deepEqual(error, errors[0]);
});

test('a traversal id can never reach a path outside the store', async () => {
  /* A real canary outside the store directory, because a containment test
   * that can only ever miss proves nothing. */
  const canary = join(store.directory, '..', 'canary.json');
  await writeFile(canary, JSON.stringify(doc()));
  for (const attack of ['../canary', '..%2Fcanary', '../canary.json', '%2e%2e/canary']) {
    const got = await store.get(attack);
    assert.ok(!got.ok, `${attack} reached something`);
    assert.equal(got.error.code, 'not_found');
    const removed = await store.remove(attack);
    assert.ok(!removed.ok);
  }
  await readFile(canary, 'utf8');  // throws if the canary was deleted
});

test('duplicate gets a new id, a suffixed name, and carries nothing private', async () => {
  /* screens-and-fleet.md §5. The dangerous failure is a copy that inherits
   * the original's screen token and thereby silently changes what is on
   * someone's wall, so the assertion is on the whole serialised copy, not on
   * three named fields. */
  const created = await store.create(doc({
    metadata: {
      name: 'Living room',
      shareToken: 'SHARE-TOKEN-MUST-NOT-TRAVEL',
      screenToken: 'SCREEN-TOKEN-MUST-NOT-TRAVEL',
      passphrase: 'PASSPHRASE-MUST-NOT-TRAVEL',
      access: {token: 'ACCESS-TOKEN-MUST-NOT-TRAVEL', passphrase: 'NOPE'},
      note: 'an ordinary field that may travel',
    },
    local: {
      densityOverrides: {
        dense: {kind: 'Grid', authoredDensity: 'dense', items: [{element: 'clock', col: 9, row: 9}]},
      },
    },
  }));
  assert.ok(created.ok);
  assert.equal(created.value.metadata.shareToken, 'SHARE-TOKEN-MUST-NOT-TRAVEL',
    'the original keeps its own state');

  const copy = await store.duplicate(created.value.metadata.uid);
  assert.ok(copy.ok);

  assert.notEqual(copy.value.metadata.uid, created.value.metadata.uid, 'a copy needs its own identity');
  assert.equal(copy.value.metadata.name, 'Living room' + COPY_SUFFIX);
  assert.equal(copy.value.metadata.revision, 1, 'a copy starts its own history');

  const serialised = JSON.stringify(copy.value);
  for (const secret of [
    'SHARE-TOKEN-MUST-NOT-TRAVEL',
    'SCREEN-TOKEN-MUST-NOT-TRAVEL',
    'PASSPHRASE-MUST-NOT-TRAVEL',
    'ACCESS-TOKEN-MUST-NOT-TRAVEL',
  ]) {
    assert.ok(!serialised.includes(secret), `a duplicate inherited ${secret}`);
  }
  assert.equal(copy.value.local, undefined, 'local density overrides are instance-local and must not travel');
  assert.equal(copy.value.metadata.note, 'an ordinary field that may travel',
    'stripping must not be so broad that ordinary metadata is lost');

  /* And the same holds of the file, not just the returned object. */
  const onDisk = await readFile(join(store.directory, `${copy.value.metadata.uid}.json`), 'utf8');
  for (const secret of ['SHARE-TOKEN', 'SCREEN-TOKEN', 'PASSPHRASE', 'densityOverrides']) {
    assert.ok(!onDisk.includes(secret), `the duplicate's FILE contains ${secret}`);
  }

  /* Content survives: a duplicate that strips the canvas as well as the
   * tokens is not a duplicate. */
  assert.deepEqual(copy.value.spec.elements, created.value.spec.elements);
  assert.deepEqual(copy.value.spec.layout, created.value.spec.layout);
});

test('a duplicate is fully independent of its original', async () => {
  const created = await store.create(doc());
  assert.ok(created.ok);
  const copy = await store.duplicate(created.value.metadata.uid);
  assert.ok(copy.ok);

  const edited = await store.update(copy.value.metadata.uid, {
    ...doc(), metadata: {name: 'Diverged'},
  }, 1);
  assert.ok(edited.ok);

  const original = await store.get(created.value.metadata.uid);
  assert.ok(original.ok);
  assert.equal(original.value.metadata.name, 'Kitchen');
  assert.equal(original.value.metadata.revision, 1, 'editing a copy must not touch the original');

  /* And deleting the original leaves the copy alone. */
  assert.ok((await store.remove(created.value.metadata.uid)).ok);
  const survivor = await store.get(copy.value.metadata.uid);
  assert.ok(survivor.ok);
  assert.equal(survivor.value.metadata.name, 'Diverged');
});

test('duplicating something that is not there is a uniform miss', async () => {
  const missing = await store.duplicate(newCanvasId());
  assert.ok(!missing.ok);
  assert.deepEqual(missing.error, {code: 'not_found', message: 'no canvas with that id'});
});

test('list summarises, skips unrelated files, and never reports a temp file', async () => {
  const a = await store.create(doc({metadata: {name: 'A'}}));
  const b = await store.create(doc({metadata: {name: 'B'}}));
  assert.ok(a.ok && b.ok);

  /* Litter a real store would accumulate: an editor backup, a crashed
   * writer's temp file, someone's notes. None is a canvas. */
  await writeFile(join(store.directory, 'notes.txt'), 'shopping list');
  await writeFile(join(store.directory, `${newCanvasId()}.json.bak`), '{}');
  await writeFile(join(store.directory, '.abc123.tmp'), '{"half":');

  const listed = await store.list();
  assert.equal(listed.length, 2);
  assert.deepEqual(new Set(listed.map((s) => s.name)), new Set(['A', 'B']));
  for (const summary of listed) {
    assert.deepEqual(Object.keys(summary).sort(),
      ['createdAt', 'id', 'name', 'revision', 'updatedAt']);
    assert.ok(isCanvasId(summary.id));
  }
});

test('an unreadable canvas does not take the whole list down', async () => {
  const good = await store.create(doc({metadata: {name: 'Good'}}));
  assert.ok(good.ok);
  const brokenId = newCanvasId();
  await writeFile(join(store.directory, `${brokenId}.json`), '{ this is not json');

  /* A household with a corrupt canvas should still see the other nine, and be
   * told which one to look at rather than getting an empty screen. */
  const warnings: string[] = [];
  const tolerant = new CanvasStore(join(store.directory, '..'), {log: (l) => warnings.push(l)});
  const listed = await tolerant.list();
  assert.equal(listed.length, 1, 'the readable canvas must still be listed');
  assert.equal(listed[0].name, 'Good');
  assert.ok(warnings.some((w) => w.includes(brokenId)), 'the broken file must be named, not swallowed');

  /* But reading the broken one directly is NOT a 404: telling a household
   * "no such canvas" about a file they can see sends them restoring a backup
   * they did not need. */
  const broken = await store.get(brokenId);
  assert.ok(!broken.ok);
  assert.equal(broken.error.code, 'stored_invalid_json');
});

test('an empty store lists nothing rather than failing', async () => {
  const fresh = new CanvasStore(await mkdtemp(join(root, 'empty-')));
  assert.deepEqual(await fresh.list(), []);
  /* And it creates its directory on demand, which is what lets the container
   * start on a fresh volume with no configuration. */
  const created = await fresh.create(doc());
  assert.ok(created.ok);
  assert.equal((await fresh.list()).length, 1);
});

test('a hand-edited canvas without store metadata still opens', async () => {
  /* The file format is human-editable on purpose. Refusing to open a document
   * because a person deleted `updatedAt` would punish exactly the editing the
   * format exists to permit. */
  const id = newCanvasId();
  await writeFile(join(store.directory, `${id}.json`), JSON.stringify({
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: id},
    spec: doc().spec,
  }, null, 2));
  const got = await store.get(id);
  assert.ok(got.ok);
  assert.equal(got.value.metadata.revision, 1);
  assert.ok(got.value.metadata.name.length > 0, 'a nameless canvas still needs something to call it');
  const updated = await store.update(id, doc(), 1);
  assert.ok(updated.ok, 'and it can be edited afterwards');
});

test('a file whose contents claim a different id is an error, not a silent swap', async () => {
  const id = newCanvasId();
  await writeFile(join(store.directory, `${id}.json`), JSON.stringify({
    ...doc(), metadata: {uid: newCanvasId(), name: 'Impostor'},
  }));
  const got = await store.get(id);
  assert.ok(!got.ok);
  assert.equal(got.error.code, 'id_mismatch');
});

/* ---------- atomicity ---------- */

test('writeAtomic leaves no temp file behind on success', async () => {
  const dir = await mkdtemp(join(root, 'atomic-'));
  await writeAtomic(join(dir, 'a.json'), '{"a":1}');
  assert.deepEqual(await readdir(dir), ['a.json']);
  assert.equal(await readFile(join(dir, 'a.json'), 'utf8'), '{"a":1}');
});

test('writeAtomic leaves no partial file when the write fails', async () => {
  /* The power-cut case, simulated by making the rename impossible: the
   * target path is a directory. The property is that the failure leaves the
   * store exactly as it was, with no temp litter accumulating toward a full
   * volume. */
  const dir = await mkdtemp(join(root, 'atomic-fail-'));
  const {mkdir} = await import('node:fs/promises');
  await mkdir(join(dir, 'blocked.json'));

  await assert.rejects(() => writeAtomic(join(dir, 'blocked.json'), 'x'.repeat(4096)));
  const left = (await readdir(dir)).filter((e) => e !== 'blocked.json');
  assert.deepEqual(left, [], `a failed write left litter: ${left.join(', ')}`);
});

test('a replacing write is never observed half-done', async () => {
  /* The property the plan asks for, tested at the point it can actually be
   * observed: a reader that samples the file while a much larger document
   * replaces a smaller one must see one or the other, never a truncation or a
   * blend. Write-in-place fails this test; rename does not. */
  const dir = await mkdtemp(join(root, 'replace-'));
  const target = join(dir, 'c.json');
  const small = JSON.stringify({size: 'small', pad: 'a'.repeat(64)});
  const large = JSON.stringify({size: 'large', pad: 'b'.repeat(512 * 1024)});
  await writeAtomic(target, small);

  let stop = false;
  let reads = 0;
  const reader = (async () => {
    while (!stop) {
      const text = await readFile(target, 'utf8');
      reads += 1;
      /* Parse, don't pattern-match: a truncated JSON document is exactly what
       * a non-atomic write produces and exactly what JSON.parse refuses. */
      const parsed = JSON.parse(text);
      assert.ok(parsed.size === 'small' || parsed.size === 'large');
      assert.equal(text.length, parsed.size === 'small' ? small.length : large.length,
        'a reader observed a document of the wrong length');
    }
  })();

  for (let i = 0; i < 25; i += 1) {
    await writeAtomic(target, i % 2 === 0 ? large : small);
  }
  stop = true;
  await reader;
  assert.ok(reads > 10, `the reader barely sampled (${reads} reads); the test proved little`);
});

test('concurrent writers never let a reader see a partial document', async () => {
  /* The crash-safety test the plan asks for. Eight writers hammer one canvas
   * while four readers parse it continuously. Every read must yield a whole,
   * valid canvas document - never a truncated one, never an empty one, never
   * a mix of two writes.
   *
   * Writers go through writeAtomic rather than the store, because the store's
   * revision check would serialise them and the thing under test here is the
   * durability primitive, not the concurrency control. */
  const dir = await mkdtemp(join(root, 'concurrent-'));
  const target = join(dir, 'busy.json');
  const payloads = Array.from({length: 8}, (_, i) => JSON.stringify({
    ...doc(),
    metadata: {uid: newCanvasId(), name: `writer-${i}`, revision: i + 1,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()},
    /* Wildly different sizes, so a non-atomic write would leave a tail of the
     * previous document behind and be caught. */
    padding: randomBytes(1024 * (i + 1)).toString('hex'),
  }, null, 2));
  await writeAtomic(target, payloads[0]);

  let stop = false;
  let observations = 0;
  const seen = new Set<string>();

  const readers = Array.from({length: 4}, () => (async () => {
    while (!stop) {
      let text: string;
      try {
        text = await readFile(target, 'utf8');
      } catch (cause) {
        /* ENOENT would itself be a failure: rename never unlinks the target. */
        assert.fail(`a reader found no file at all: ${(cause as Error).message}`);
      }
      assert.notEqual(text.length, 0, 'a reader observed a zero-length canvas');
      const parsed = loadDocument(text);
      assert.ok(parsed.ok, `a reader observed an unloadable document: ${text.slice(0, 80)}`);
      assert.ok(payloads.includes(text), 'a reader observed a blend of two writes');
      seen.add(parsed.value.metadata.name as string);
      observations += 1;
    }
  })());

  const writers = Array.from({length: 8}, (_, i) => (async () => {
    for (let round = 0; round < 40; round += 1) {
      await writeAtomic(target, payloads[(i + round) % payloads.length]);
    }
  })());

  await Promise.all(writers);
  stop = true;
  await Promise.all(readers);

  assert.ok(observations > 50, `too few observations (${observations}) to have proved anything`);
  assert.ok(seen.size > 1, 'the readers never saw the file change; the race was not exercised');
  /* Nothing was left behind by 320 concurrent writes. */
  assert.deepEqual(await readdir(dir), ['busy.json']);

  /* And the final state is a whole, valid document. */
  const final = loadDocument(await readFile(target, 'utf8'));
  assert.ok(final.ok);
});

test('concurrent store updates serialise through the revision check', async () => {
  /* The complement to the test above: at the STORE level, concurrency is not
   * supposed to be last-write-wins at all. Ten writers all read revision 1;
   * exactly one may win, and the other nine must be told. */
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;

  const results = await Promise.all(
    Array.from({length: 10}, (_, i) =>
      store.update(id, {...doc(), metadata: {name: `writer-${i}`}}, 1)),
  );
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'exactly one writer may win a race on the same revision');
  for (const loser of results.filter((r) => !r.ok)) {
    assert.equal((loser as {error: {code: string}}).error.code, 'revision_conflict');
  }

  const final = await store.get(id);
  assert.ok(final.ok);
  assert.equal(final.value.metadata.revision, 2, 'revisions must not be skipped or doubled');
  assert.deepEqual(await readdir(store.directory), [`${id}.json`]);
});

test('remove deletes the file and is a uniform miss the second time', async () => {
  const created = await store.create(doc());
  assert.ok(created.ok);
  const id = created.value.metadata.uid;
  assert.ok((await store.remove(id)).ok);
  assert.deepEqual(await readdir(store.directory), []);
  const again = await store.remove(id);
  assert.ok(!again.ok);
  assert.deepEqual(again.error, {code: 'not_found', message: 'no canvas with that id'});
});
