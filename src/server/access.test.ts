import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';

import {
  ACCESS_LEVELS,
  AccessStore,
  AttemptLimiter,
  ATTEMPT_GRACE,
  ATTEMPT_BASE_DELAY_MS,
  DEFAULT_ACCESS_LEVEL,
  SCRYPT_PARAMS,
  describeAccess,
  hashPassphrase,
  isAccessLevel,
  isShareToken,
  newShareToken,
  parseSessionTimeout,
  tokenFingerprint,
  verifyPassphrase,
} from './access.ts';
import {CanvasStore, newCanvasId} from './store.ts';

/* The credential half of Phase 3, tested without HTTP. The route-level
 * guarantees (a locked body containing no canvas, byte-identical 404s) live in
 * share.test.ts, because they are properties of a RESPONSE and must be
 * asserted on bytes. */

let root = '';
let store: CanvasStore;

function doc(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: id, name: 'Hallway'},
    spec: {
      elements: {clock: {type: 'clock', namedSize: 'small'}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'clock', col: 0, row: 0}]},
    },
    ...overrides,
  };
}

async function freshCanvas(): Promise<string> {
  const created = await store.create(doc('ignored'));
  assert.ok(created.ok);
  return created.value.metadata.uid;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-access-'));
  store = new CanvasStore(root);
  await store.init();
});

after(async () => {
  await rm(root, {recursive: true, force: true});
});

/* ------------------------------------------------------------ the levels -- */

test('there are exactly three levels and the default is the closed one', () => {
  assert.deepEqual([...ACCESS_LEVELS], ['private', 'link', 'passphrase']);
  assert.equal(DEFAULT_ACCESS_LEVEL, 'private');
  for (const level of ACCESS_LEVELS) assert.ok(isAccessLevel(level));
  for (const bad of ['public', 'PRIVATE', '', null, 0, {}]) {
    assert.equal(isAccessLevel(bad), false, `${String(bad)} must not be a level`);
  }
});

test('a canvas nobody has configured is private', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  assert.equal(await access.levelOf(id), 'private');
  assert.equal(await access.read(id), null);
  /* ...and an unknown id is private too, never "unset therefore open". */
  assert.equal(await access.levelOf(newCanvasId()), 'private');
});

/* ------------------------------------------------------------- the token -- */

test('tokens are 32 random bytes, never repeat, and are not derived from the id', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i += 1) {
    const token = newShareToken();
    assert.ok(isShareToken(token), `${token} is not a well-formed token`);
    /* base64url of 32 bytes: 43 unpadded characters, 256 bits. */
    assert.equal(token.length, 43);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(seen.has(token), false, 'a token repeated across 2000 generations');
    seen.add(token);
  }

  /* Not a function of the id: the same canvas issued two tokens must get two
   * different ones, or the token is an encoding rather than a capability. */
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const first = await access.set(id, {level: 'link'});
  assert.ok(first.ok);
  const rotated = await access.rotate(id);
  assert.ok(rotated);
  assert.notEqual(rotated.shareToken, first.record.shareToken);
  for (const token of [first.record.shareToken!, rotated.shareToken!]) {
    assert.equal(token.includes(id), false, 'the token contains the canvas id');
    assert.equal(id.includes(token), false);
  }
});

test('a malformed token is never even a candidate', () => {
  for (const bad of [
    '', 'short', 'a'.repeat(42), 'a'.repeat(44),
    '../../../etc/passwd', 'a'.repeat(42) + '/', 'a'.repeat(42) + '.',
    'a'.repeat(42) + '%', 'a'.repeat(42) + '\0', null, undefined, 42, {},
  ]) {
    assert.equal(isShareToken(bad), false, `${String(bad)} accepted as a token`);
  }
});

test('a fingerprint is what a log gets, and it is not the token', () => {
  const token = newShareToken();
  const print = tokenFingerprint(token);
  assert.equal(print.length, 12);
  assert.equal(token.includes(print), false, 'the fingerprint is a substring of the token');
  assert.equal(tokenFingerprint(token), print, 'a fingerprint must be stable');
  assert.notEqual(tokenFingerprint(newShareToken()), print);
});

/* -------------------------------------------------------------- scrypt --- */

test('scrypt verifies the right passphrase and rejects a near-miss', async () => {
  const credential = await hashPassphrase('otter lantern brisk cobble');
  assert.equal(credential.algorithm, 'scrypt');
  assert.equal(await verifyPassphrase(credential, 'otter lantern brisk cobble'), true);

  /* Near misses, each one character away, plus the empty string. A hash that
   * accepted any of these would be a hash of something other than what was
   * typed. */
  for (const near of [
    'otter lantern brisk cobbl',
    'otter lantern brisk cobble ',
    ' otter lantern brisk cobble',
    'Otter lantern brisk cobble',
    'otter lantern brisk cobbles',
    'otter lantern brisk cobbie',
    '',
  ]) {
    assert.equal(await verifyPassphrase(credential, near), false, `accepted near-miss: ${JSON.stringify(near)}`);
  }
});

test('a stored credential contains no plaintext and records its own parameters', async () => {
  const passphrase = 'PLAINTEXT-MUST-NOT-BE-STORED';
  const credential = await hashPassphrase(passphrase);
  const serialised = JSON.stringify(credential);
  assert.equal(serialised.includes(passphrase), false, 'the passphrase is in the record');
  /* Not even a fast-hash of it, which would be brute-forceable offline. */
  const {createHash} = await import('node:crypto');
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const digest = createHash(algorithm).update(passphrase).digest();
    assert.equal(serialised.includes(digest.toString('hex')), false, `${algorithm} hex digest stored`);
    assert.equal(serialised.includes(digest.toString('base64')), false, `${algorithm} base64 digest stored`);
  }
  assert.deepEqual(credential.params, SCRYPT_PARAMS);
  assert.equal(Buffer.from(credential.salt, 'base64').length, 16);
  assert.equal(Buffer.from(credential.hash, 'base64').length, SCRYPT_PARAMS.keyLength);
});

test('the salt is per canvas, never shared or derived', async () => {
  const salts = new Set<string>();
  const hashes = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const credential = await hashPassphrase('the same passphrase everywhere');
    salts.add(credential.salt);
    hashes.add(credential.hash);
  }
  assert.equal(salts.size, 8, 'a salt repeated');
  assert.equal(hashes.size, 8, 'the same passphrase produced the same hash twice - the salt is not being used');
});

test('parameters recorded beside the hash can be raised without invalidating old passphrases', async () => {
  /* The property that makes recorded parameters worth the bytes: a credential
   * written under weaker parameters still verifies after the default is
   * raised, because verification honours the record, not the constant. */
  const weak = {N: 1024, r: 8, p: 1, keyLength: 32};
  const old = await hashPassphrase('four word household phrase', {params: weak});
  assert.deepEqual(old.params, weak);
  assert.equal(await verifyPassphrase(old, 'four word household phrase'), true);
  const fresh = await hashPassphrase('four word household phrase');
  assert.deepEqual(fresh.params, SCRYPT_PARAMS);
  assert.equal(await verifyPassphrase(fresh, 'four word household phrase'), true);
});

test('a credential with parameters this build cannot honour fails closed', async () => {
  const credential = await hashPassphrase('anything at all');
  for (const broken of [
    {...credential, algorithm: 'sha256' as unknown as 'scrypt'},
    {...credential, params: {...credential.params, keyLength: 64}},
    {...credential, params: {...credential.params, N: 1.5}},
    {...credential, hash: 'not base64 at all !!!'},
  ]) {
    assert.equal(await verifyPassphrase(broken, 'anything at all'), false);
  }
});

/* ---------------------------------------------------------- the sidecar -- */

test('credentials live in a sidecar, not in the canvas document', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'SIDECAR-ONLY-PHRASE'});
  assert.ok(set.ok);

  /* The canvas FILE must contain no token, no hash and no salt. */
  const canvasFile = await readFile(join(store.directory, `${id}.json`), 'utf8');
  for (const secret of [set.record.shareToken!, set.record.credentials[0].hash, set.record.credentials[0].salt]) {
    assert.equal(canvasFile.includes(secret), false, 'a credential reached the canvas document');
  }
  assert.equal(canvasFile.includes('SIDECAR-ONLY-PHRASE'), false);

  /* ...and the sidecar is a separate file under access/. */
  const entries = await readdir(join(root, 'access'));
  assert.ok(entries.includes(`${id}.json`), 'no sidecar was written');
});

test('credentials are a list with one entry, so per-person revocation is an addition', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'one entry please'});
  assert.ok(set.ok);
  assert.ok(Array.isArray(set.record.credentials), 'credentials must be a list, not a scalar');
  assert.equal(set.record.credentials.length, 1);
  assert.ok(set.record.credentials[0].id, 'each credential needs its own id to be revocable alone');
  assert.ok(set.record.credentials[0].label);
});

test('a corrupt or unreadable sidecar is treated as private, never as open', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  await access.set(id, {level: 'link'});
  const {writeFile} = await import('node:fs/promises');

  await writeFile(join(root, 'access', `${id}.json`), 'not json at all', 'utf8');
  assert.equal(await access.read(id), null);
  assert.equal(await access.levelOf(id), 'private');

  await writeFile(join(root, 'access', `${id}.json`),
    JSON.stringify({version: 1, canvasId: id, level: 'wide-open', shareToken: null,
      credentials: [], sessionTimeout: {kind: 'session'}, sessions: [],
      createdAt: '', updatedAt: ''}), 'utf8');
  assert.equal((await access.read(id))?.level, 'private', 'an unrecognised level must close, not open');
});

test('describeAccess reveals the link but never a hash, a salt or a session', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'described phrase'});
  assert.ok(set.ok);
  const record = (await access.resolve(set.record.shareToken))!;
  const unlocked = await access.unlock(record, 'described phrase');
  assert.ok(unlocked.ok);

  const described = JSON.stringify(describeAccess((await access.read(id))!));
  assert.ok(described.includes(set.record.shareToken!), 'the owner must be told their own link');
  assert.equal(described.includes(set.record.credentials[0].hash), false, 'hash leaked');
  assert.equal(described.includes(set.record.credentials[0].salt), false, 'salt leaked');
  assert.equal(described.includes(unlocked.sessionId), false, 'a live session id leaked');
  assert.equal(described.includes('described phrase'), false);
  assert.ok(described.includes('"hasPassphrase":true'));
});

/* --------------------------------------------------------- level changes -- */

test('passphrase level refuses to be set without a passphrase', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const attempt = await access.set(id, {level: 'passphrase'});
  assert.equal(attempt.ok, false);
  assert.equal((attempt as {code: string}).code, 'passphrase_required');
  /* Nothing was written: a half-configured protected canvas must not exist. */
  assert.equal(await access.read(id), null);
});

test('changing link -> passphrase keeps the link the household already sent', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const linked = await access.set(id, {level: 'link'});
  assert.ok(linked.ok);
  const upgraded = await access.set(id, {level: 'passphrase', passphrase: 'now protected'});
  assert.ok(upgraded.ok);
  assert.equal(upgraded.record.shareToken, linked.record.shareToken,
    'adding a passphrase is not a rotation and must not silently break the link');
});

test('going private destroys the token, the credentials and the sessions', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const shared = await access.set(id, {level: 'passphrase', passphrase: 'going away'});
  assert.ok(shared.ok);
  const token = shared.record.shareToken!;
  assert.ok(await access.resolve(token));

  const back = await access.set(id, {level: 'private'});
  assert.ok(back.ok);
  assert.equal(back.record.shareToken, null);
  assert.equal(back.record.credentials.length, 0);
  assert.equal(await access.resolve(token), null, 'the old token still resolves after going private');
  assert.equal(await access.read(id), null, 'the sidecar should be gone entirely');
});

test('changing the passphrase is a revocation: it ends every existing unlock', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'first phrase'});
  assert.ok(set.ok);
  const record = (await access.resolve(set.record.shareToken))!;
  const unlocked = await access.unlock(record, 'first phrase');
  assert.ok(unlocked.ok);
  assert.equal(await access.hasSession((await access.read(id))!, unlocked.sessionId), true);

  await access.set(id, {level: 'passphrase', passphrase: 'second phrase'});
  const after = (await access.read(id))!;
  assert.equal(await access.hasSession(after, unlocked.sessionId), false,
    'a passphrase change that leaves old sessions alive is an edit, not a revocation');
  assert.equal(await verifyPassphrase(after.credentials[0], 'first phrase'), false);
  assert.equal(await verifyPassphrase(after.credentials[0], 'second phrase'), true);
});

/* ------------------------------------------------------------- sessions -- */

test('sessions are per canvas: unlocking one does not unlock another', async () => {
  const access = new AccessStore(root);
  const photos = await freshCanvas();
  const finances = await freshCanvas();
  const a = await access.set(photos, {level: 'passphrase', passphrase: 'photos phrase'});
  const b = await access.set(finances, {level: 'passphrase', passphrase: 'finances phrase'});
  assert.ok(a.ok && b.ok);

  const unlocked = await access.unlock((await access.resolve(a.record.shareToken))!, 'photos phrase');
  assert.ok(unlocked.ok);
  assert.equal(await access.hasSession((await access.read(photos))!, unlocked.sessionId), true);
  assert.equal(await access.hasSession((await access.read(finances))!, unlocked.sessionId), false,
    'a session minted for one canvas opened another');
});

test('the session id is random, and neither the passphrase nor a hash of it', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const passphrase = 'session material check';
  const set = await access.set(id, {level: 'passphrase', passphrase});
  assert.ok(set.ok);
  const {createHash} = await import('node:crypto');

  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const unlocked = await access.unlock((await access.resolve(set.record.shareToken))!, passphrase);
    assert.ok(unlocked.ok);
    assert.notEqual(unlocked.sessionId, passphrase);
    for (const algorithm of ['sha256', 'sha1', 'md5']) {
      const digest = createHash(algorithm).update(passphrase).digest();
      assert.notEqual(unlocked.sessionId, digest.toString('hex'));
      assert.notEqual(unlocked.sessionId, digest.toString('base64url'));
    }
    assert.notEqual(unlocked.sessionId, set.record.credentials[0].hash);
    ids.add(unlocked.sessionId);
  }
  assert.equal(ids.size, 5, 'session ids repeated');

  /* The stored half is a hash: reading the file must not yield a live cookie. */
  const sidecar = await readFile(join(root, 'access', `${id}.json`), 'utf8');
  for (const sessionId of ids) {
    assert.equal(sidecar.includes(sessionId), false, 'a live session id is stored in plaintext');
  }
});

test('a timeout of days expires; session-lifetime never expires server-side', async () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const access = new AccessStore(root, {now: () => clock});
  const id = await freshCanvas();
  const set = await access.set(id, {
    level: 'passphrase', passphrase: 'timed phrase', sessionTimeout: {kind: 'days', days: 30},
  });
  assert.ok(set.ok);
  const unlocked = await access.unlock((await access.resolve(set.record.shareToken))!, 'timed phrase');
  assert.ok(unlocked.ok);
  assert.ok(unlocked.expiresAt);
  assert.equal(unlocked.expiresAt.toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(await access.hasSession((await access.read(id))!, unlocked.sessionId), true);

  clock = new Date('2026-01-30T23:59:00.000Z');
  assert.equal(await access.hasSession((await access.read(id))!, unlocked.sessionId), true);
  clock = new Date('2026-02-01T00:00:01.000Z');
  assert.equal(await access.hasSession((await access.read(id))!, unlocked.sessionId), false,
    'a 30-day session outlived 30 days');

  /* "No timeout" means session-lifetime: no server-side expiry, and the
   * cookie carries no Expires so the browser drops it when it closes. */
  clock = new Date('2026-03-01T00:00:00.000Z');
  const forever = await access.set(id, {
    level: 'passphrase', passphrase: 'forever phrase', sessionTimeout: {kind: 'session'},
  });
  assert.ok(forever.ok);
  const open = await access.unlock((await access.resolve(forever.record.shareToken))!, 'forever phrase');
  assert.ok(open.ok);
  assert.equal(open.expiresAt, null);
  clock = new Date('2099-01-01T00:00:00.000Z');
  assert.equal(await access.hasSession((await access.read(id))!, open.sessionId), true);
});

test('sessionTimeout parses the shapes a person or a client would send', () => {
  assert.deepEqual(parseSessionTimeout('session'), {kind: 'session'});
  assert.deepEqual(parseSessionTimeout(30), {kind: 'days', days: 30});
  assert.deepEqual(parseSessionTimeout('7'), {kind: 'days', days: 7});
  assert.deepEqual(parseSessionTimeout({kind: 'days', days: 90}), {kind: 'days', days: 90});
  assert.deepEqual(parseSessionTimeout({kind: 'session'}), {kind: 'session'});
  for (const bad of [0, -1, 1.5, 100000, 'forever', 'never', true, [], undefined, null]) {
    assert.equal(parseSessionTimeout(bad), null, `${String(bad)} must not parse`);
  }
});

test('sessions survive a restart, because a 30-day promise must outlive a container update', async () => {
  const id = await freshCanvas();
  const first = new AccessStore(root);
  const set = await first.set(id, {level: 'passphrase', passphrase: 'durable phrase'});
  assert.ok(set.ok);
  const unlocked = await first.unlock((await first.resolve(set.record.shareToken))!, 'durable phrase');
  assert.ok(unlocked.ok);

  const restarted = new AccessStore(root);
  const record = await restarted.resolve(set.record.shareToken);
  assert.ok(record, 'the token index must be rebuilt from disk on start');
  assert.equal(await restarted.hasSession(record, unlocked.sessionId), true);
});

/* ------------------------------------------------------------- rotation -- */

test('rotation invalidates the old token AND every existing session', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'rotate me'});
  assert.ok(set.ok);
  const oldToken = set.record.shareToken!;
  const unlocked = await access.unlock((await access.resolve(oldToken))!, 'rotate me');
  assert.ok(unlocked.ok);

  const rotated = await access.rotate(id);
  assert.ok(rotated);
  assert.notEqual(rotated.shareToken, oldToken);
  assert.equal(await access.resolve(oldToken), null, 'the old token still resolves after rotation');
  const fresh = await access.resolve(rotated.shareToken);
  assert.ok(fresh, 'the new token must work immediately');
  assert.equal(await access.hasSession(fresh, unlocked.sessionId), false,
    'a session survived rotation - the old link would still show the canvas');

  /* The passphrase itself is unchanged: rotation revokes the LINK. */
  assert.equal(await verifyPassphrase(rotated.credentials[0], 'rotate me'), true);
});

test('rotating a private canvas is refused rather than quietly minting a link', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  assert.equal(await access.rotate(id), null);
  assert.equal(await access.rotate(newCanvasId()), null);
  assert.equal(await access.rotate('not-an-id'), null);
});

/* -------------------------------------------------------- rate limiting -- */

test('failed attempts earn a growing delay; a success clears it', () => {
  let clock = 1_000_000;
  const limiter = new AttemptLimiter(() => clock);
  const token = newShareToken();

  assert.deepEqual(limiter.check(token), {allowed: true, retryAfterMs: 0});
  const delays: number[] = [];
  for (let i = 0; i < 8; i += 1) delays.push(limiter.fail(token).retryAfterMs);

  /* A person mistyping their own passphrase is not punished... */
  for (let i = 0; i < ATTEMPT_GRACE; i += 1) {
    assert.equal(delays[i], 0, `attempt ${i + 1} should be free`);
  }
  /* ...and then it grows, doubling, from the base. */
  assert.equal(delays[ATTEMPT_GRACE], ATTEMPT_BASE_DELAY_MS);
  for (let i = ATTEMPT_GRACE + 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `delay shrank at attempt ${i + 1}`);
    if (delays[i] < 30_000) assert.equal(delays[i], delays[i - 1] * 2);
  }
  assert.ok(delays.at(-1)! >= 4 * ATTEMPT_BASE_DELAY_MS, 'the delay never meaningfully grew');

  assert.equal(limiter.check(token).allowed, false, 'the caller should be waiting');
  clock += 1_000_000;
  assert.equal(limiter.check(token).allowed, true, 'the delay must eventually pass');

  limiter.fail(token);
  limiter.succeed(token);
  assert.deepEqual(limiter.check(token), {allowed: true, retryAfterMs: 0},
    'a correct passphrase must clear the penalty');
});

test('the limiter is per token: one link under attack does not lock out another', () => {
  const limiter = new AttemptLimiter();
  const attacked = newShareToken();
  const innocent = newShareToken();
  for (let i = 0; i < 10; i += 1) limiter.fail(attacked);
  assert.equal(limiter.check(attacked).allowed, false);
  assert.equal(limiter.check(innocent).allowed, true);
});

test('unlock refuses while throttled without even consulting the passphrase', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'throttle me'});
  assert.ok(set.ok);
  const record = (await access.resolve(set.record.shareToken))!;

  for (let i = 0; i <= ATTEMPT_GRACE; i += 1) {
    const wrong = await access.unlock(record, 'not it');
    assert.equal(wrong.ok, false);
  }
  const blocked = await access.unlock(record, 'throttle me');
  assert.equal(blocked.ok, false);
  assert.equal((blocked as {reason: string}).reason, 'throttled',
    'the correct passphrase must still be refused while a penalty is outstanding');
});

/* ------------------------------------------------------ store interaction -- */

test('a duplicate of a protected canvas is unprotected and not reachable by the original token', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'original only'});
  assert.ok(set.ok);
  const token = set.record.shareToken!;

  const copy = await store.duplicate(id);
  assert.ok(copy.ok);
  const copyId = copy.value.metadata.uid;
  assert.notEqual(copyId, id);

  /* screens-and-fleet.md §5: the copy gets no links. */
  assert.equal(await access.levelOf(copyId), 'private');
  assert.equal(await access.read(copyId), null, 'the duplicate inherited an access record');

  /* And the original token still points at the ORIGINAL, never the copy -
   * a duplicate that took over the original's link is the hijack §5 calls the
   * single most dangerous possible behaviour. */
  const resolved = await access.resolve(token);
  assert.equal(resolved?.canvasId, id);
  assert.notEqual(resolved?.canvasId, copyId);
});

test('a share export of a protected canvas carries no token, hash or salt', async () => {
  /* The regression test for the leak that was MEASURED before this phase was
   * designed: the same three values placed under metadata.access all survived
   * toShareable(). They live in a sidecar now, so the export cannot reach
   * them - which is why this test asserts on the serialised export rather
   * than on a stripping rule. */
  const {saveDocument, toShareable} = await import('../canvas/index.ts');
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'passphrase', passphrase: 'EXPORT-MUST-NOT-CARRY-THIS'});
  assert.ok(set.ok);

  const stored = await store.get(id);
  assert.ok(stored.ok);
  const exported = saveDocument(toShareable(stored.value));
  for (const secret of [
    set.record.shareToken!,
    set.record.credentials[0].hash,
    set.record.credentials[0].salt,
    'EXPORT-MUST-NOT-CARRY-THIS',
  ]) {
    assert.equal(exported.includes(secret), false, `a share export carried ${secret.slice(0, 12)}...`);
  }
});

test('an access record for a deleted canvas can be cleared and stops resolving', async () => {
  const access = new AccessStore(root);
  const id = await freshCanvas();
  const set = await access.set(id, {level: 'link'});
  assert.ok(set.ok);
  await store.remove(id);
  await access.clear(id);
  assert.equal(await access.resolve(set.record.shareToken), null);
});

test('resolve answers malformed, unknown and private identically: null', async () => {
  const access = new AccessStore(root);
  const privateCanvas = await freshCanvas();
  await access.set(privateCanvas, {level: 'private'});
  for (const candidate of [
    null, undefined, '', 'nope', randomBytes(31).toString('base64url'),
    randomBytes(33).toString('base64url'), newShareToken(), '../'.repeat(14) + 'x',
  ]) {
    assert.equal(await access.resolve(candidate), null, `resolve accepted ${String(candidate)}`);
  }
});
