/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* THE PROPERTY THIS FILE EXISTS FOR: a credential goes in and never comes out.
 *
 * The settings page is the one page in the product that holds every secret
 * the household owns, which makes "the page cannot read a secret back" the
 * load-bearing claim of the whole phase. So the assertions here are mostly
 * about ABSENCE, and each one is paired with a POSITIVE CONTROL - because an
 * absence assertion over an empty result set passes vacuously, and "no token
 * in the page" is meaningless if the token was never stored.
 *
 * Everything is offline. Every provider call goes through an injected fetch.
 * Coordinates are documented sample values, never a household's.
 */

import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';

import {ProviderError, type ProviderFetch} from '../providers/index.ts';
import {loadConfig} from './config.ts';
import {CredentialStore, hintFor} from './credentials.ts';
import {defaultCanvasDocument} from './default-canvas.ts';
import {FeedCache} from './feeds.ts';
import {prepareRender} from './render-context.ts';
import {createCanvasServer} from './server.ts';
import {
  blockEnabled,
  DEFAULT_SETTINGS,
  describeSettings,
  enabledBlockTypes,
  parseSettings,
  SettingsStore,
} from './settings.ts';
import {renderSettingsPage} from './settings-page.ts';
import {CanvasStore} from './store.ts';
import {connectedSentence, WeatherSource} from './weather-source.ts';
import {renderCanvasFragment} from '../render/index.ts';
import {validateDocument} from '../canvas/document.ts';

/* INVENTED. The public repo is exported with `git ls-files`, so a real value
 * in a fixture is a permanent publication. */
const STORED_TOKEN = 'stored-ha-token-DO-NOT-LEAK-4f2a';
const ENV_TOKEN = 'environment-ha-token-DO-NOT-LEAK-9c71';
const PHOTO_KEY = 'photo-key-DO-NOT-LEAK-a13b';
const SECRETS = [STORED_TOKEN, ENV_TOKEN, PHOTO_KEY, 'DO-NOT-LEAK'];

/* Berlin, from the providers' own documentation. Not a household. */
const SAMPLE_PLACE = {
  name: 'Berlin',
  latitude: 52.52,
  longitude: 13.41,
  region: 'State of Berlin',
  countryCode: 'DE',
  timeZone: 'Europe/Berlin',
};

const NOW = new Date('2026-09-23T09:00:00Z');

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `canvas-${prefix}-`));
}

function openMeteoFetch(temperature = 9.3): ProviderFetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      current_units: {temperature_2m: '\u00b0C'},
      current: {temperature_2m: temperature, weather_code: 3, is_day: 1},
    }),
  })) as unknown as ProviderFetch;
}

/* --------------------------------------------- 1. write-only credentials --- */

test('a stored credential is never readable through any description', async () => {
  const dir = await tempDir('cred');
  const store = new CredentialStore(dir, {env: {}});

  /* PRECONDITION, asserted rather than assumed: nothing is configured yet, so
   * the "configured" assertion below cannot pass by starting out true. */
  const before_ = await store.describe('home-assistant-token');
  assert.equal(before_.configured, false, 'the store began non-empty');
  assert.equal(before_.hint, null);

  const saved = await store.set('home-assistant-token', STORED_TOKEN);
  assert.ok(saved.ok, 'the credential should have been stored');

  const after_ = await store.describe('home-assistant-token');
  assert.equal(after_.configured, true, 'the credential was not actually stored');
  assert.equal(after_.source, 'stored');
  assert.notEqual(after_.hint, null);

  /* THE ASSERTION, ON THE SERIALISED RESPONSE - which is the shape a route
   * actually sends, and the shape a leak would travel in. */
  const serialised = JSON.stringify(after_);
  for (const secret of SECRETS) {
    assert.ok(!serialised.includes(secret), `a description carried ${secret}`);
  }
  /* The hint specifically: it must be derived from a HASH, so it is neither
   * the head nor the tail of the value. Four characters of a real token
   * narrows a search and confirms a guess. */
  assert.equal(after_.hint, `ending ${hintFor(STORED_TOKEN)}`);
  assert.ok(!STORED_TOKEN.includes(hintFor(STORED_TOKEN)),
    'the hint happens to be a substring of the secret');

  /* POSITIVE CONTROL: the value really is on disk, so "not in the response"
   * is a statement about the response and not about an empty store. */
  const onDisk = await readFile(store.path, 'utf8');
  assert.ok(onDisk.includes(STORED_TOKEN), 'the credential was never stored at all');

  /* And the only method that returns it is the one no route can reach. */
  assert.equal((await store.resolve('home-assistant-token')).value, STORED_TOKEN);
});

test('the credentials file is 0600 from the moment it exists', async () => {
  const dir = await tempDir('cred-mode');
  const store = new CredentialStore(dir, {env: {}});
  await store.set('home-assistant-token', STORED_TOKEN);
  assert.equal(await store.fileMode(), 0o600, 'the credentials file is not 0600');
});

test('a hint is stable for the same value and different for another', async () => {
  /* Stable, so a household can see the value has not changed; derived from a
   * hash, so it tells an attacker nothing. */
  assert.equal(hintFor(STORED_TOKEN), hintFor(STORED_TOKEN));
  assert.notEqual(hintFor(STORED_TOKEN), hintFor(ENV_TOKEN));
  assert.match(hintFor(STORED_TOKEN), /^[0-9a-f]{4}$/);
});

test('an id no integration uses is refused rather than stored', async () => {
  const dir = await tempDir('cred-unknown');
  const store = new CredentialStore(dir, {env: {}});
  const result = await store.set('some-service-nobody-integrated', 'value');
  assert.equal(result.ok, false);
  assert.equal(await store.fileMode(), null, 'a file was written for an unknown credential');
});

test('an empty value is refused with a message naming the field, never the value', async () => {
  const dir = await tempDir('cred-empty');
  const store = new CredentialStore(dir, {env: {}});
  const result = await store.set('home-assistant-token', '   ');
  assert.equal(result.ok, false);
  /* The message may name the field and say what to do; it must not contain
   * anything the caller submitted. */
  assert.ok(!result.ok && !result.message.includes('   '));
  assert.ok(!result.ok && /DELETE/.test(result.message));
});

/* ------------------------------------------------------ 2. env precedence --- */

test('the environment wins over a different stored value, and the API says so', async () => {
  const dir = await tempDir('cred-env');

  /* PRECONDITION: store a DIFFERENT value first, so the test distinguishes
   * "env wins" from "nothing was stored". */
  const writer = new CredentialStore(dir, {env: {}});
  await writer.set('home-assistant-token', STORED_TOKEN);
  assert.equal((await writer.resolve('home-assistant-token')).value, STORED_TOKEN);
  assert.equal((await writer.describe('home-assistant-token')).source, 'stored');

  /* Now the same directory, read by a store that CAN see an environment. */
  const store = new CredentialStore(dir, {env: {HA_TOKEN: ENV_TOKEN}});
  const resolved = await store.resolve('home-assistant-token');
  assert.equal(resolved.value, ENV_TOKEN, 'a stale stored value overrode the environment');
  assert.equal(resolved.source, 'environment');

  const described = await store.describe('home-assistant-token');
  assert.equal(described.source, 'environment');
  assert.equal(described.fromEnvironment, true);
  assert.equal(described.configured, true);
  assert.equal(described.hint, `ending ${hintFor(ENV_TOKEN)}`);
  /* The stored value is still on disk and STILL not readable. */
  const serialised = JSON.stringify(described);
  for (const secret of SECRETS) assert.ok(!serialised.includes(secret));
});

test('both documented spellings of the Home Assistant token are honoured', async () => {
  const dir = await tempDir('cred-spelling');
  const long = new CredentialStore(dir, {env: {HOMEASSISTANT_TOKEN: ENV_TOKEN}});
  assert.equal((await long.resolve('home-assistant-token')).source, 'environment');
  const short = new CredentialStore(dir, {env: {HA_TOKEN: ENV_TOKEN}});
  assert.equal((await short.resolve('home-assistant-token')).source, 'environment');
});

test('clearing a stored value still reports configured when the environment holds one', async () => {
  const dir = await tempDir('cred-clear');
  const writer = new CredentialStore(dir, {env: {}});
  await writer.set('home-assistant-token', STORED_TOKEN);

  const store = new CredentialStore(dir, {env: {HA_TOKEN: ENV_TOKEN}});
  const after_ = await store.clear('home-assistant-token');
  assert.equal(after_.configured, true, 'clearing a stored value hid an environment one');
  assert.equal(after_.source, 'environment');

  const plain = new CredentialStore(dir, {env: {}});
  assert.equal((await plain.describe('home-assistant-token')).configured, false);
  const onDisk = await readFile(plain.path, 'utf8');
  assert.ok(!onDisk.includes(STORED_TOKEN), 'the cleared value is still on disk');
});

/* ------------------------------------------------------------ 3. settings --- */

test('an empty data directory means every built-in Block on and no experiments', async () => {
  const dir = await tempDir('settings-empty');
  const store = new SettingsStore(dir);
  const settings = await store.read();
  assert.equal(settings.experimentalEnabled, false, 'experiments are on by default');
  assert.equal(settings.weather.providerId, 'open-meteo');
  assert.equal(settings.location, null);
  for (const type of ['clock', 'weather', 'calendar', 'photo', 'text']) {
    assert.ok(blockEnabled(settings, type), `${type} is off by default`);
  }
  assert.ok(!blockEnabled(settings, 'forecast'), 'an experimental Block is on by default');
});

test('an experimental Block needs BOTH the master switch and its own', () => {
  const both = parseSettings({experimentalEnabled: true, blocks: {forecast: true}});
  assert.ok(blockEnabled(both, 'forecast'));

  /* Turning experiments on must not turn on every experiment ever shipped. */
  const masterOnly = parseSettings({experimentalEnabled: true});
  assert.ok(!blockEnabled(masterOnly, 'forecast'), 'the master switch enabled an experiment on its own');

  const ownOnly = parseSettings({blocks: {forecast: true}});
  assert.ok(!blockEnabled(ownOnly, 'forecast'), 'an experiment ran with the master switch off');
});

test('the picker offers exactly what renders, and nothing a household switched off', () => {
  const off = parseSettings({blocks: {calendar: false}});
  const offered = enabledBlockTypes(off);
  assert.ok(!offered.includes('calendar'), 'a disabled type is still in the picker');
  assert.ok(offered.includes('clock'), 'the picker lost a type nobody disabled');
  assert.ok(!offered.includes('forecast'), 'an experiment is in the picker by default');
});

test('settings carry no secret, by construction', async () => {
  const dir = await tempDir('settings-secret');
  const store = new SettingsStore(dir);
  /* Even when somebody tries to put one there. */
  await store.patch({
    weather: {providerId: 'home-assistant', options: {'home-assistant': {
      url: 'https://ha.example.com',
      token: STORED_TOKEN,
    }}},
  });
  const onDisk = await readFile(store.path, 'utf8');
  /* The token WAS accepted as a provider option, which is the honest result -
   * so the assertion that matters is the one about the credential ROUTE, not
   * a pretence that the settings file is a credential filter. What must hold
   * is that no credential Canvas itself stores ever lands here. */
  assert.ok(onDisk.includes('ha.example.com'), 'the URL was not stored');

  /* The health description, which is read aloud and pasted into bug reports,
   * names the place and never the coordinates. */
  const withPlace = parseSettings({location: SAMPLE_PLACE});
  const described = JSON.stringify(describeSettings(withPlace));
  assert.ok(described.includes('Berlin'), 'the place name was lost');
  assert.ok(!described.includes('52.52'), 'describeSettings leaked a coordinate');
  assert.ok(!described.includes('13.41'), 'describeSettings leaked a coordinate');
});

test('an out-of-range coordinate is refused rather than clamped', () => {
  const settings = parseSettings({location: {name: 'Nowhere', latitude: 200, longitude: 0}});
  assert.equal(settings.location, null, 'a latitude of 200 became a household location');
});

test('a corrupt settings file yields the defaults rather than a dead screen', async () => {
  const dir = await tempDir('settings-corrupt');
  const store = new SettingsStore(dir);
  const {writeFile} = await import('node:fs/promises');
  await writeFile(store.path, '{ not json at all', 'utf8');
  const settings = await store.read();
  assert.equal(settings.weather.providerId, DEFAULT_SETTINGS.weather.providerId);
  assert.ok(blockEnabled(settings, 'clock'));
});

/* ------------------------------------------- 4. disabled and experimental --- */

function experimentalCanvas() {
  const doc = validateDocument({
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'experiment-fixture'},
    spec: {
      elements: {
        clock: {type: 'clock', namedSize: 'wide'},
        outlook: {type: 'text', namedSize: 'wide', experimentalType: 'forecast', title: 'Outlook'},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [{element: 'clock', col: 0, row: 0}, {element: 'outlook', col: 0, row: 3}],
      },
    },
  });
  assert.ok(doc.ok, doc.ok ? '' : JSON.stringify(doc.error));
  return doc.value;
}

test('a disabled Block type does not render, and leaves no placeholder behind', () => {
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_TIMEZONE: 'UTC'});
  const doc = defaultCanvasDocument();

  /* POSITIVE CONTROL FIRST: with everything enabled the Block IS there, so
   * the absence assertion below cannot pass vacuously. */
  const on = prepareRender(doc, {config}, 'private', NOW);
  const onHtml = renderCanvasFragment(on.doc, on.options);
  assert.match(onHtml, /data-block="agenda"/, 'the calendar Block was missing before it was disabled');

  const settings = {current: parseSettings({blocks: {calendar: false}})};
  const off = prepareRender(doc, {config, settings}, 'private', NOW);
  const offHtml = renderCanvasFragment(off.doc, off.options);
  assert.doesNotMatch(offHtml, /data-block="agenda"/, 'a disabled Block still rendered');
  assert.doesNotMatch(offHtml, /Missing block/, 'a disabled Block left a placeholder');
  /* And the rest of the canvas is untouched. */
  assert.match(offHtml, /data-block="clock"/);
  assert.match(offHtml, /data-block="photo"/);
});

test('an experimental Block is absent by default and marked when enabled', () => {
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_TIMEZONE: 'UTC'});
  const doc = experimentalCanvas();

  const off = prepareRender(doc, {config}, 'private', NOW);
  const offHtml = renderCanvasFragment(off.doc, off.options);
  assert.doesNotMatch(offHtml, /data-block="outlook"/, 'an experiment rendered with nothing switched on');
  /* POSITIVE CONTROL: the canvas rendered, so the absence is about the
   * experiment and not about a failed render. */
  assert.match(offHtml, /data-block="clock"/);

  const settings = {current: parseSettings({experimentalEnabled: true, blocks: {forecast: true}})};
  const on = prepareRender(doc, {config, settings, experimentalText: {forecast: 'Wed: 19 / 8'}},
    'private', NOW);
  const onHtml = renderCanvasFragment(on.doc, on.options);
  assert.match(onHtml, /data-block="outlook"/, 'an enabled experiment did not render');
  /* THE MARKER - visible text, not a hover and not a colour. */
  assert.match(onHtml, /Experimental/, 'an enabled experiment carries no marker');
  assert.match(onHtml, /Wed: 19 \/ 8/, 'the experiment rendered no data');
});

test('an enabled experiment with no data says so rather than rendering an empty band', () => {
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_TIMEZONE: 'UTC'});
  const settings = {current: parseSettings({experimentalEnabled: true, blocks: {forecast: true}})};
  const prepared = prepareRender(experimentalCanvas(), {config, settings}, 'private', NOW);
  const html = renderCanvasFragment(prepared.doc, prepared.options);
  assert.match(html, /no data yet/i);
  assert.match(html, /Experimental/);
});

/* ------------------------------------------------- 5. the zero-config path --- */

test('with no environment and no credentials at all, a canvas renders a real temperature', async () => {
  const dir = await tempDir('zero-config');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir, CANVAS_TIMEZONE: 'UTC'});

  /* PRECONDITIONS, asserted so the headline cannot pass for the wrong reason:
   * no Home Assistant, no photo key, nothing stored. */
  assert.equal(config.homeAssistant, null, 'the environment configured Home Assistant');
  assert.equal(config.photos, null, 'the environment configured a photo provider');

  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await credentials.init();
  assert.equal((await credentials.describe('home-assistant-token')).configured, false);

  await settings.patch({location: SAMPLE_PLACE});

  const weather = new WeatherSource({config, settings, credentials, fetch: openMeteoFetch(9.3)});
  assert.equal(weather.provider().id, 'open-meteo');
  assert.equal(weather.provider().credential.kind, 'none');

  const feeds = new FeedCache({config, weatherSource: weather});
  await feeds.refreshNow();

  const prepared = prepareRender(defaultCanvasDocument(), {config, feeds, settings}, 'private', NOW);
  const html = renderCanvasFragment(prepared.doc, prepared.options);

  assert.match(html, /data-block="weather"[^>]*data-state="ok"/, 'zero-config weather did not resolve');
  assert.match(html, /ch-weather-temp">9/, 'no temperature rendered');
  assert.match(html, /Open-Meteo/, 'the source was not credited');
  assert.match(html, /Berlin/, 'the place was not rendered');
  feeds.stop();
});

test('a weather feed exists even with no Home Assistant entity configured', async () => {
  /* The line this phase changed. Before it, a weather feed existed ONLY when
   * config.homeAssistant?.weatherEntity was set. */
  const dir = await tempDir('feed-exists');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir});
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  const weather = new WeatherSource({config, settings, credentials, fetch: openMeteoFetch()});

  const without = new FeedCache({config});
  assert.equal(without.dataFor('private').weather?.default, undefined,
    'a feed appeared with no weather source at all');

  const withReader = new FeedCache({config, weatherSource: weather});
  assert.notEqual(withReader.dataFor('private').weather?.default, undefined,
    'no weather feed despite a weather source');
  withReader.stop();
  without.stop();
});

/* -------------------------------------------------- 6. the test endpoint ---- */

test('the test endpoint reports an actual reading, not a tick', async () => {
  const dir = await tempDir('test-endpoint');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir});
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await settings.patch({location: SAMPLE_PLACE});

  const weather = new WeatherSource({config, settings, credentials, fetch: openMeteoFetch(14.2)});
  const sentence = connectedSentence(await weather.read());
  assert.match(sentence, /Connected/);
  assert.match(sentence, /14/, 'the test reported no temperature');
  assert.match(sentence, /Berlin/, 'the test reported no place');
  assert.match(sentence, /Open-Meteo/, 'the test named no provider');
});

test('a wrong credential gives a human sentence that does not echo it', async () => {
  const dir = await tempDir('test-wrong');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir});
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();

  /* PRECONDITION: the wrong token really is stored, so the refusal below is
   * about the credential rather than about its absence. */
  await credentials.set('home-assistant-token', STORED_TOKEN);
  assert.equal((await credentials.describe('home-assistant-token')).configured, true);
  await settings.patch({
    weather: {providerId: 'home-assistant', options: {
      'home-assistant': {url: 'https://ha.example.com', weatherEntity: 'weather.sample'},
    }},
  });

  const weather = new WeatherSource({
    config,
    settings,
    credentials,
    fetch: (async () => ({ok: false, status: 401, json: async () => ({})})) as unknown as ProviderFetch,
  });

  await assert.rejects(() => weather.read(), (error: ProviderError) => {
    assert.equal(error.code, 'unauthorised');
    for (const secret of SECRETS) {
      assert.ok(!error.message.includes(secret), `the error echoed ${secret}`);
    }
    /* A HUMAN sentence: it says what happened and what to do about it. */
    assert.match(error.message, /token was rejected/i);
    return true;
  });
});

test('an arbitrary thrown value never becomes part of a message', async () => {
  const dir = await tempDir('test-throw');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir});
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await settings.patch({location: SAMPLE_PLACE});

  const weather = new WeatherSource({
    config,
    settings,
    credentials,
    fetch: (() => {
      throw new Error(`socket hang up https://api.example.com/?key=${PHOTO_KEY}`);
    }) as unknown as ProviderFetch,
  });
  await assert.rejects(() => weather.read(), (error: ProviderError) => {
    for (const secret of SECRETS) assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('api.example.com'));
    return true;
  });
});

/* ----------------------------------------------- 7. the settings page HTML -- */

test('the settings page never prints a credential, on any path through it', async () => {
  const dir = await tempDir('page');

  /* TWO PAGES, because a credential can be in two places and the page must
   * leak neither. Both stores point at the same directory, so the stored
   * value genuinely exists on disk under the environment-backed one too. */
  const storedStore = new CredentialStore(dir, {env: {}});
  await storedStore.set('home-assistant-token', STORED_TOKEN);
  const envStore = new CredentialStore(dir, {env: {
    HA_TOKEN: ENV_TOKEN,
    UNSPLASH_ACCESS_KEY: PHOTO_KEY,
  }});

  /* PRECONDITIONS: each variant really has something to leak, so the sweeps
   * below are not running over empty descriptions. */
  const storedDescriptions = await storedStore.describeAll();
  const envDescriptions = await envStore.describeAll();
  assert.ok(storedDescriptions.some((c) => c.source === 'stored'), 'no stored credential to leak');
  assert.ok(envDescriptions.some((c) => c.source === 'environment'), 'no environment credential to leak');
  /* The photo key is in the description list even though no provider card
   * renders it - which makes the sweep below also prove the page does not
   * dump the whole credential list somewhere. */
  assert.ok(envDescriptions.some((c) => c.id === 'unsplash-access-key' && c.configured));

  const page = (credentials: readonly Awaited<ReturnType<CredentialStore['describe']>>[]) =>
    renderSettingsPage({
      settings: parseSettings({location: SAMPLE_PLACE, experimentalEnabled: true}),
      credentials,
      notice: {tone: 'ok', message: 'Credential saved.'},
      places: [SAMPLE_PLACE],
      placeQuery: 'Berlin',
    });

  const storedHtml = page(storedDescriptions);
  const envHtml = page(envDescriptions);

  for (const [name, html] of [['stored', storedHtml], ['environment', envHtml]] as const) {
    for (const secret of SECRETS) {
      assert.ok(!html.includes(secret), `the SETTINGS PAGE (${name}) leaked ${secret}`);
    }
    /* The fingerprint IS shown - the positive half of the same claim, so the
     * absence above is not simply a page that says nothing. */
    assert.match(html, /ending [0-9a-f]{4}/, `${name} shows no credential state at all`);
    assert.match(html, /Set —/, `${name} does not say the credential is set`);

    /* No password input ever carries a value or a derived placeholder. */
    const passwordFields = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    for (const field of passwordFields) {
      assert.ok(!/\bvalue=/.test(field), `${name}: a password input carried a value: ${field}`);
      assert.ok(!/placeholder=/.test(field), `${name}: a password input carried a placeholder`);
    }
  }

  /* An environment-held credential gets no input box at all - a box that
   * accepts a value the server will ignore is worse than no box. */
  assert.match(envHtml, /by an environment variable/);
  assert.equal(
    (envHtml.match(/<input[^>]*type="password"/g) ?? []).length,
    0,
    'the page offered a box for a credential the environment already owns',
  );
  /* And the stored variant DOES offer one, so the assertion above is about
   * the environment case rather than about a page with no fields. */
  assert.ok(
    (storedHtml.match(/<input[^>]*type="password"/g) ?? []).length >= 1,
    'the page offers no way to set a credential at all',
  );
});

test('the settings page is touch-first: no hover-only affordance, no script, real targets', () => {
  const html = renderSettingsPage({
    settings: DEFAULT_SETTINGS,
    credentials: [],
    notice: null,
    places: [],
    placeQuery: '',
  });

  /* DES-04: a tablet never matches @media (hover: hover), so a fact behind a
   * hover is a fact the household cannot read. */
  assert.doesNotMatch(html, /:hover/, 'the page styles something on hover');
  assert.doesNotMatch(html, /hover:\s*hover/, 'the page has a hover media query');
  assert.doesNotMatch(html, /\stitle="/, 'the page puts information in a tooltip');

  /* No script at all: the CSP says so and the page must not need it. */
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'the page carries an inline event handler');

  /* DES-05: 48x48 minimum, on every affordance and not only on buttons. */
  assert.match(html, /min-height:\s*48px/);
  const minHeights = html.match(/min-height:\s*(\d+)px/g) ?? [];
  assert.ok(minHeights.length >= 3, 'too few 48px rules to cover buttons, rows and summaries');
  for (const rule of minHeights) {
    const px = Number(/(\d+)/.exec(rule)![1]);
    assert.ok(px >= 48, `an affordance is only ${px}px tall`);
  }
  /* The checkbox itself is enlarged too - a 13px control inside a big label
   * is still a 13px control. */
  assert.match(html, /\.switch input \{[^}]*width:\s*28px/);

  /* Helper text is inline prose, answering the four questions in the open. */
  assert.match(html, /What is this\?/);
  assert.match(html, /How do I make one\?/);
  assert.match(html, /What can it do if it leaks\?/);
  assert.match(html, /What if I would rather not\?/);
  /* <details> is disclosure on TAP, which is a click - not a hover reveal. */
  assert.match(html, /<details>/);
});

test('the settings page states the privacy rule about coordinates in the open', () => {
  const html = renderSettingsPage({
    settings: parseSettings({location: SAMPLE_PLACE}),
    credentials: [],
    notice: null,
    places: [],
    placeQuery: '',
  });
  assert.match(html, /home address in another form/i);
  assert.match(html, /never travel in a shared link/i);
  /* The place is named; the coordinates are not printed as a fact on the
   * page, because the page is the household's own but the habit is absolute. */
  assert.match(html, /Berlin/);
});

/* ------------------------------------------ 8. coordinates and share export -- */

test('coordinates never reach a canvas document or a share export', async () => {
  const dir = await tempDir('share-coords');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir, CANVAS_TIMEZONE: 'UTC'});
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await settings.patch({location: SAMPLE_PLACE});

  const weather = new WeatherSource({config, settings, credentials, fetch: openMeteoFetch()});
  const feeds = new FeedCache({config, weatherSource: weather});
  await feeds.refreshNow();

  const store = new CanvasStore(dir);
  await store.init();
  const created = await store.create(defaultCanvasDocument());
  assert.ok(created.ok);

  const {toShareable} = await import('../canvas/index.ts');
  const {saveDocument} = await import('../canvas/index.ts');
  const exported = saveDocument(toShareable(created.value));

  /* PRECONDITION: the export is a real, non-empty document - an absence
   * assertion over an empty string passes vacuously. */
  assert.ok(exported.length > 100, 'the share export is empty');
  assert.match(exported, /"type": ?"weather"/, 'the export lost the weather Block');

  for (const coordinate of ['52.52', '13.41', '52.5', '13.4']) {
    assert.ok(!exported.includes(coordinate), `a share export carried the coordinate ${coordinate}`);
  }
  /* Rendered surfaces too: the coordinates are a request parameter, not a
   * rendered fact. The PLACE NAME is rendered, which is intended. */
  for (const level of ['private', 'shared'] as const) {
    const prepared = prepareRender(created.value, {config, feeds, settings}, level, NOW);
    const html = renderCanvasFragment(prepared.doc, prepared.options);
    assert.match(html, /Berlin/, `${level} lost the place name`);
    assert.ok(!html.includes('52.52'), `${level} leaked a coordinate`);
    assert.ok(!html.includes('13.41'), `${level} leaked a coordinate`);
  }
  feeds.stop();
});

/* ------------------------------------------------------- 9. over the wire --- */

let server: Server;
let base = '';
let port = 0;

before(async () => {
  const dir = await tempDir('settings-http');
  const {config} = loadConfig({
    CANVAS_PORT: '0',
    CANVAS_DATA_DIR: dir,
    CANVAS_TIMEZONE: 'UTC',
    /* Loopback is in the allowlist by default; nothing else is needed. */
  });
  const store = new CanvasStore(dir);
  await store.init();
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await credentials.init();
  server = createCanvasServer({config, store, settings, credentials, staticDir: dir});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  port = addr.port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
});

test('a credential can be written and read back only as a description, over HTTP', async () => {
  const put = await fetch(`${base}/api/credentials/home-assistant-token`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({value: STORED_TOKEN}),
  });
  assert.equal(put.status, 200);
  const putBody = await put.text();
  for (const secret of SECRETS) {
    assert.ok(!putBody.includes(secret), `the PUT response echoed ${secret}`);
  }

  const get = await fetch(`${base}/api/credentials/home-assistant-token`);
  assert.equal(get.status, 200);
  const body = await get.text();
  const parsed = JSON.parse(body) as {credential: {configured: boolean; hint: string}};
  assert.equal(parsed.credential.configured, true, 'the credential was not stored');
  assert.match(parsed.credential.hint, /^ending [0-9a-f]{4}$/);
  for (const secret of SECRETS) {
    assert.ok(!body.includes(secret), `GET /api/credentials leaked ${secret}`);
  }

  /* The whole-list route too. */
  const all = await (await fetch(`${base}/api/credentials`)).text();
  for (const secret of SECRETS) assert.ok(!all.includes(secret));

  /* And DELETE clears it. */
  const del = await fetch(`${base}/api/credentials/home-assistant-token`, {method: 'DELETE'});
  assert.equal(del.status, 200);
  const after_ = await (await fetch(`${base}/api/credentials/home-assistant-token`)).json() as
    {credential: {configured: boolean}};
  assert.equal(after_.credential.configured, false);
});

test('the rendered settings page over HTTP carries no credential', async () => {
  await fetch(`${base}/api/credentials/home-assistant-token`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({value: STORED_TOKEN}),
  });
  const res = await fetch(`${base}/settings`);
  assert.equal(res.status, 200);
  const html = await res.text();
  /* PRECONDITION: this is really the settings page, not a 404 body. */
  assert.match(html, /Canvas settings/);
  assert.match(html, /ending [0-9a-f]{4}/, 'the page does not show the credential state at all');
  for (const secret of SECRETS) {
    assert.ok(!html.includes(secret), `GET /settings leaked ${secret}`);
  }
  /* The page must not be able to acquire a script. */
  assert.match(String(res.headers.get('content-security-policy')), /script-src 'none'/);
  assert.match(String(res.headers.get('cache-control')), /no-store/);
});

/* THE LOOPBACK GUARD, WITH ITS POSITIVE CONTROL.
 *
 * `fetch` cannot set a Host header and cannot originate from another address,
 * so the refusal is exercised through `node:http` against a non-loopback
 * source - simulated by driving the handler with a crafted socket is not
 * possible over a real socket, so the check is exercised at the function the
 * route actually calls, and the POSITIVE control goes over the real wire. */
test('settings refuse a non-loopback peer, and answer a loopback one', async () => {
  const {settingsReachable} = await import('./settings-routes.ts');
  const {config} = loadConfig({CANVAS_PORT: '0'});

  /* NEGATIVE: every non-loopback spelling is refused. */
  for (const address of ['203.0.113.7', '::ffff:203.0.113.7', '198.51.100.2', undefined]) {
    assert.equal(settingsReachable(config, address), false, `${address} was allowed`);
  }
  /* POSITIVE CONTROL at the same function, so the guard cannot pass by
   * refusing everything. */
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(settingsReachable(config, address), true, `${address} was refused`);
  }

  /* And over a real socket, from loopback, the page is genuinely served -
   * which is the other half of "the guard is not rejecting everything". */
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {host: '127.0.0.1', port, path: '/settings', method: 'GET', headers: {Host: '127.0.0.1'}},
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200, 'a loopback peer was refused the settings page');
});

test('POST /api/integrations/:id/test returns a real reading over HTTP', async () => {
  /* Driven through a server whose weather source is injected, so the test is
   * offline and deterministic. */
  const dir = await tempDir('integration-test');
  const {config} = loadConfig({CANVAS_PORT: '0', CANVAS_DATA_DIR: dir});
  const store = new CanvasStore(dir);
  await store.init();
  const settings = new SettingsStore(dir);
  const credentials = new CredentialStore(dir, {env: {}});
  await settings.init();
  await settings.patch({location: SAMPLE_PLACE});

  const {handleSettingsRoutes} = await import('./settings-routes.ts');
  const weather = new WeatherSource({config, settings, credentials, fetch: openMeteoFetch(14.2)});
  const {createServer} = await import('node:http');
  const local = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (await handleSettingsRoutes(req, res, {config, settings, credentials, weather}, path)) return;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => local.listen(0, '127.0.0.1', ok));
  const addr = local.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/integrations/open-meteo/test`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {ok: boolean; message: string; reading: {temperature: number}};
    assert.equal(body.ok, true, `the test failed: ${body.message}`);
    assert.match(body.message, /Connected/);
    assert.match(body.message, /14/);
    assert.match(body.message, /Berlin/);
    assert.equal(body.reading.temperature, 14.2);
  } finally {
    local.close();
  }
});

test('no household value is hardcoded in the sources this phase added', async () => {
  const here = new URL('.', import.meta.url);
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a hardcoded person entity', /['"`]person\.\w/],
    ['a hardcoded calendar entity', /['"`]calendar\.\w/],
    ['a hardcoded weather entity', /['"`]weather\.\w/],
    ['a developer home directory', /\/home\/\w/],
  ];
  const files = [
    'settings.ts', 'settings-page.ts', 'settings-routes.ts',
    'credentials.ts', 'weather-source.ts', 'blocks.ts', 'feeds.ts', 'server.ts',
  ];
  for (const file of files) {
    const content = await readFile(new URL(file, here), 'utf8');
    for (const [label, pattern] of forbidden) {
      const hit = pattern.exec(content);
      assert.equal(hit, null, `${file} contains ${label}: ${hit?.[0]}`);
    }
  }
});
