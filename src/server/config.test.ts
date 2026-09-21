import assert from 'node:assert/strict';
import {test} from 'node:test';

import {describeConfig, loadConfig} from './config.ts';

/* Every test passes an explicit env object rather than mutating process.env,
 * so the suite is order-independent and cannot leak state between cases. */

test('an empty environment still yields a runnable configuration', () => {
  /* The headline property: Canvas with nothing configured must boot. If this
   * fails, the project is undeployable for anyone who has not first set up a
   * home automation server and a photo account. */
  const {config, problems} = loadConfig({});
  assert.equal(problems.length, 0, 'a bare environment must not be an error');
  assert.equal(config.port, 4174);
  assert.equal(config.homeAssistant, null);
  assert.equal(config.photos, null);
  assert.ok(config.dataDir, 'a data directory must always resolve');
});

test('no household value survives as a default', () => {
  /* Guards the reason this module exists. These literals were previously in
   * source: a LAN address, a VPN address, a calendar entity and a person
   * entity. A default that names one household is a privacy leak in a public
   * repository and useless to everyone else. */
  const {config} = loadConfig({});
  const serialised = JSON.stringify(config);
  /* Generic patterns, not this household's actual entity names: a leak
   * detector that spells out the private value publishes it. */
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a person entity', /person\.\w/],
    ['a calendar entity', /calendar\.\w/],
    ['a weather entity', /weather\.\w/],
  ];
  for (const [label, pattern] of forbidden) {
    const hit = pattern.exec(serialised);
    assert.equal(hit, null, `default config still contains ${label}: ${hit?.[0]}`);
  }
  assert.equal(config.homeAssistant, null);
});

test('Home Assistant needs both url and token, and says so when half set', () => {
  const urlOnly = loadConfig({HOMEASSISTANT_URL: 'http://ha.example:8123'});
  assert.equal(urlOnly.config.homeAssistant, null);
  assert.equal(urlOnly.problems.length, 1, 'half-configured must be reported, not silent');

  const tokenOnly = loadConfig({HOMEASSISTANT_TOKEN: 'secret'});
  assert.equal(tokenOnly.config.homeAssistant, null);
  assert.equal(tokenOnly.problems.length, 1);

  const both = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.example:8123/',
    HOMEASSISTANT_TOKEN: 'secret',
  });
  assert.equal(both.problems.length, 0);
  assert.equal(both.config.homeAssistant?.url, 'http://ha.example:8123',
    'a trailing slash must be normalised away or every joined path doubles it');
});

test('legacy HA_URL and HA_TOKEN names still work', () => {
  /* The prototype used these names. Breaking them would break the display
   * currently running on the wall for no benefit. */
  const {config} = loadConfig({HA_URL: 'http://ha.example:8123', HA_TOKEN: 'secret'});
  assert.equal(config.homeAssistant?.url, 'http://ha.example:8123');
});

test('entity ids are configurable and absent by default', () => {
  const {config} = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.example:8123',
    HOMEASSISTANT_TOKEN: 'secret',
    CANVAS_WEATHER_ENTITY: 'weather.somewhere',
    CANVAS_PERSON_ENTITIES: 'person.a, person.b ,, person.c',
  });
  assert.equal(config.homeAssistant?.weatherEntity, 'weather.somewhere');
  assert.equal(config.homeAssistant?.calendarEntity, null, 'unset entity means omit the element');
  assert.deepEqual(config.homeAssistant?.personEntities, ['person.a', 'person.b', 'person.c'],
    'blank entries from a trailing comma must not become empty entity ids');
});

test('an invalid port is reported rather than silently accepted', () => {
  for (const bad of ['0', '70000', 'http', '-1', '80.5']) {
    const {config, problems} = loadConfig({CANVAS_PORT: bad});
    assert.equal(problems.length, 1, `${bad} should be rejected`);
    assert.equal(config.port, 4174, 'a rejected port must fall back, not crash');
  }
  assert.equal(loadConfig({CANVAS_PORT: '8080'}).config.port, 8080);
});

test('the base URL is validated and normalised', () => {
  assert.equal(loadConfig({CANVAS_BASE_URL: 'https://canvas.example.com/'}).config.baseUrl,
    'https://canvas.example.com');
  assert.equal(loadConfig({CANVAS_BASE_URL: 'https://example.com/canvas/'}).config.baseUrl,
    'https://example.com/canvas');

  for (const bad of ['not a url', 'ftp://example.com', 'javascript:alert(1)']) {
    const {config, problems} = loadConfig({CANVAS_BASE_URL: bad});
    assert.equal(config.baseUrl, null, `${bad} must not become a base URL`);
    assert.equal(problems.length, 1);
  }
});

test('the base URL host is allowed automatically', () => {
  /* Making someone state their own domain twice produces a 403 that looks
   * like a bug in the software rather than a gap in their config. */
  const {config} = loadConfig({CANVAS_BASE_URL: 'https://canvas.example.com'});
  assert.ok(config.allowedHosts.includes('canvas.example.com'));
  assert.ok(config.allowedHosts.includes('127.0.0.1'), 'loopback must always be reachable');
});

test('extra allowed hosts merge without duplicating loopback', () => {
  const {config} = loadConfig({
    CANVAS_ALLOWED_HOSTS: 'tv.example.com, 127.0.0.1 , tablet.example.com',
    CANVAS_BASE_URL: 'https://canvas.example.com',
  });
  const counts = new Map<string, number>();
  for (const h of config.allowedHosts) counts.set(h, (counts.get(h) ?? 0) + 1);
  assert.ok([...counts.values()].every((n) => n === 1), 'allowed hosts must be unique');
  for (const h of ['tv.example.com', 'tablet.example.com', 'canvas.example.com', '127.0.0.1']) {
    assert.ok(config.allowedHosts.includes(h), `${h} missing`);
  }
});

test('analytics default on, accept off, and reject anything else', () => {
  assert.equal(loadConfig({}).config.analytics, 'on');
  assert.equal(loadConfig({CANVAS_ANALYTICS: 'OFF'}).config.analytics, 'off');
  const {problems} = loadConfig({CANVAS_ANALYTICS: 'maybe'});
  assert.equal(problems.length, 1);
});

test('describeConfig never reveals a secret value', () => {
  /* The startup banner and health endpoint both call this. A token printed
   * once into a log outlives every rotation policy. */
  const config = loadConfig({
    HOMEASSISTANT_URL: 'http://ha.example:8123',
    HOMEASSISTANT_TOKEN: 'super-secret-ha-token',
    UNSPLASH_ACCESS_KEY: 'super-secret-photo-key',
  }).config;
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes('super-secret-ha-token'), 'HA token leaked into describeConfig');
  assert.ok(!described.includes('super-secret-photo-key'), 'photo key leaked into describeConfig');
  assert.ok(described.includes('token set'), 'presence should still be reported');
  assert.ok(described.includes('enabled (key set)'));
});

test('photos are optional and carry attribution identity', () => {
  assert.equal(loadConfig({}).config.photos, null);
  const {config} = loadConfig({UNSPLASH_ACCESS_KEY: 'k'});
  assert.ok(config.photos?.topicId, 'a topic must always resolve when photos are enabled');
  assert.ok(config.photos?.appName, 'the app name is part of the attribution obligation');
});

test('the configuration is a value, not a read of ambient state', () => {
  /* Two loads of the same environment must agree, and neither may consult
   * process.env when given an explicit one - otherwise tests pass locally and
   * behave differently in a container. */
  const env = {CANVAS_PORT: '9999', CANVAS_BASE_URL: 'https://a.example.com'};
  assert.deepEqual(loadConfig(env).config, loadConfig(env).config);
  assert.equal(loadConfig(env).config.port, 9999);
});
