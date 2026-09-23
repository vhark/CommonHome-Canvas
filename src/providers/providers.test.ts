/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* What this file proves, and what it deliberately does NOT.
 *
 * Every test here is OFFLINE. The providers are exercised against fixture
 * payloads captured from the real services, so this file behaves identically
 * on a machine with no network - which is the only kind of test worth having
 * about code whose job is to make network requests correctly.
 *
 * The live check that a real temperature comes back is a separate, explicit
 * act (see the phase verification), not something every `npm test` performs
 * against somebody else's free service.
 *
 * Coordinates are the DOCUMENTED SAMPLE values from the providers' own
 * documentation, never a household's. This repository is exported with
 * `git ls-files`, so a real coordinate in a fixture is a permanent
 * publication of a home address.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  conditionFromSymbol,
  conditionFromWmo,
  DEFAULT_WEATHER_PROVIDER_ID,
  declaredCredentialIds,
  geocode,
  homeAssistant,
  metNo,
  metNoUserAgent,
  openMeteo,
  ProviderError,
  weatherProvider,
  weatherProviderOrDefault,
  WEATHER_PROVIDERS,
  type Location,
  type ProviderFetch,
  type WeatherRequest,
} from './index.ts';

/* Berlin, from Open-Meteo's own documentation examples. Not a household. */
const SAMPLE: Location = {
  name: 'Berlin',
  latitude: 52.52,
  longitude: 13.41,
  region: 'State of Berlin',
  countryCode: 'DE',
  timeZone: 'Europe/Berlin',
};

/* Invented. Never a real token. */
const TOKEN = 'ha-token-DO-NOT-LEAK-7b3e';

function fakeFetch(
  handler: (url: string, init?: {headers?: Record<string, string>}) => unknown,
): ProviderFetch & {calls: Array<{url: string; headers: Record<string, string>}>} {
  const calls: Array<{url: string; headers: Record<string, string>}> = [];
  const impl = (async (url: string, init?: {headers?: Record<string, string>}) => {
    calls.push({url, headers: init?.headers ?? {}});
    const result = handler(url, init);
    if (typeof result === 'number') {
      return {ok: result >= 200 && result < 300, status: result, json: async () => ({})};
    }
    return {ok: true, status: 200, json: async () => result};
  }) as ProviderFetch & {calls: typeof calls};
  impl.calls = calls;
  return impl;
}

function request(overrides: Partial<WeatherRequest> = {}): WeatherRequest {
  return {
    location: SAMPLE,
    units: 'metric',
    fetch: fakeFetch(() => ({})),
    credential: null,
    options: {},
    contact: '',
    timeoutMs: 1000,
    ...overrides,
  };
}

/* ------------------------------------------------------------- 1. registry -- */

test('the default provider needs no credential at all', () => {
  const provider = weatherProviderOrDefault(undefined);
  assert.equal(provider.id, DEFAULT_WEATHER_PROVIDER_ID);
  assert.equal(
    provider.credential.kind,
    'none',
    'the DEFAULT provider requires a credential, which makes zero-config weather impossible',
  );
});

test('a settings file naming a provider this build removed falls back to the keyless default', () => {
  /* The safe direction to be wrong in: a wall that shows a temperature from
   * a keyless service beats a wall that shows nothing because a provider was
   * renamed between versions. */
  assert.equal(weatherProviderOrDefault('a-provider-that-was-deleted').id, DEFAULT_WEATHER_PROVIDER_ID);
  assert.equal(weatherProviderOrDefault(null).credential.kind, 'none');
  assert.equal(weatherProvider('a-provider-that-was-deleted'), null);
});

test('at least two providers need no credential, so a household always has a keyless choice', () => {
  const keyless = WEATHER_PROVIDERS.filter((p) => p.credential.kind === 'none');
  assert.ok(keyless.length >= 2, `only ${keyless.length} keyless providers`);
  assert.ok(keyless.every((p) => !p.advanced), 'a keyless provider should not be marked advanced');
});

test('every provider answers all four help questions, and the keyless ones name no steps', () => {
  for (const provider of WEATHER_PROVIDERS) {
    assert.notEqual(provider.help.whatItIs.trim(), '', `${provider.id} has no "what is this"`);
    assert.notEqual(provider.help.ifItLeaks.trim(), '', `${provider.id} has no leak scope`);
    assert.notEqual(
      provider.help.ifYouWouldRatherNot.trim(),
      '',
      `${provider.id} names no alternative`,
    );
    if (provider.credential.kind === 'none') {
      assert.equal(
        provider.help.howToMakeOne.length,
        0,
        `${provider.id} needs no credential but lists steps for making one`,
      );
    } else {
      assert.ok(
        provider.help.howToMakeOne.length >= 3,
        `${provider.id} needs a credential but does not say how to make one`,
      );
    }
  }
});

test('only providers that declare a credential contribute a credential id', () => {
  const ids = declaredCredentialIds();
  assert.deepEqual(ids, ['home-assistant-token']);
});

/* ------------------------------------------------------- 2. condition maps -- */

test('WMO codes map onto the vocabulary the renderer already speaks', () => {
  assert.equal(conditionFromWmo(0), 'sunny');
  assert.equal(conditionFromWmo(0, true), 'clear-night', 'a clear sky at night is not "Sunny"');
  assert.equal(conditionFromWmo(2), 'partlycloudy');
  assert.equal(conditionFromWmo(3), 'cloudy');
  assert.equal(conditionFromWmo(65), 'pouring');
  assert.equal(conditionFromWmo(95), 'lightning');
  assert.equal(conditionFromWmo(96), 'lightning-rainy');
  /* An unmapped code teaches something true rather than saying "unknown". */
  assert.equal(conditionFromWmo(123), 'wmo-123');
  assert.equal(conditionFromWmo(undefined), '');
});

test('met.no symbol codes resolve thunder before rain', () => {
  assert.equal(conditionFromSymbol('clearsky_day'), 'sunny');
  assert.equal(conditionFromSymbol('clearsky_night'), 'clear-night');
  assert.equal(conditionFromSymbol('partlycloudy_night'), 'partlycloudy');
  assert.equal(conditionFromSymbol('heavyrain'), 'pouring');
  /* The one that matters: lightning outside must not be reported as rain. */
  assert.equal(conditionFromSymbol('heavyrainandthunder_day'), 'lightning-rainy');
  assert.equal(conditionFromSymbol('sleetshowers_day'), 'snowy-rainy');
  assert.equal(conditionFromSymbol(''), '');
});

/* ------------------------------------------------------------ 3. Open-Meteo -- */

/* Field-for-field the shape the live endpoint returned when this was
 * measured. A fixture whose shape is invented makes correct code look broken. */
function openMeteoPayload(): unknown {
  return {
    latitude: 52.52,
    longitude: 13.419998,
    current_units: {time: 'iso8601', temperature_2m: '\u00b0C', weather_code: 'wmo code'},
    current: {time: '2026-09-23T03:00', interval: 900, temperature_2m: 9.3, weather_code: 3, is_day: 0},
  };
}

test('open-meteo maps its payload into the existing WeatherReading and asks for no key', async () => {
  const fetchImpl = fakeFetch(() => openMeteoPayload());
  const reading = await openMeteo.read(request({fetch: fetchImpl}));

  assert.equal(reading.temperature, 9.3);
  assert.equal(reading.unit, '\u00b0C');
  assert.equal(reading.state, 'cloudy');
  assert.equal(reading.place, 'Berlin');
  assert.equal(reading.attribution?.source, 'Open-Meteo');

  const call = fetchImpl.calls[0]!;
  /* No Authorization header, no key parameter, no account. THE claim. */
  assert.deepEqual(call.headers, {});
  assert.doesNotMatch(call.url, /key|token|appid|apikey/i);
  assert.match(call.url, /latitude=52\.5200/);
  assert.match(call.url, /temperature_unit=celsius/);
});

test('open-meteo asks for the unit the household chose and trusts the unit reported back', async () => {
  const fetchImpl = fakeFetch(() => ({
    ...(openMeteoPayload() as object),
    current_units: {temperature_2m: '\u00b0F'},
    current: {temperature_2m: 48.8, weather_code: 1, is_day: 1},
  }));
  const reading = await openMeteo.read(request({fetch: fetchImpl, units: 'imperial'}));
  assert.match(fetchImpl.calls[0]!.url, /temperature_unit=fahrenheit/);
  assert.equal(reading.unit, '\u00b0F');
  assert.equal(reading.temperature, 48.8);
});

test('coordinates are rounded before they leave the machine', async () => {
  /* A geocoder returns more precision than a weather model has, and the extra
   * digits are house-number precision on a home address. */
  const fetchImpl = fakeFetch(() => openMeteoPayload());
  await openMeteo.read(request({
    fetch: fetchImpl,
    location: {name: 'Sample', latitude: 52.5243712345, longitude: 13.4105398765},
  }));
  assert.match(fetchImpl.calls[0]!.url, /latitude=52\.5244&longitude=13\.4105/);
  assert.doesNotMatch(fetchImpl.calls[0]!.url, /52\.52437/, 'full geocoder precision was sent');
});

test('no location is an explainable state, not a crash, and causes no request', async () => {
  const fetchImpl = fakeFetch(() => openMeteoPayload());
  await assert.rejects(
    () => openMeteo.read(request({fetch: fetchImpl, location: null})),
    (error: ProviderError) => {
      assert.equal(error.code, 'unconfigured');
      assert.match(error.message, /settings page/i);
      return true;
    },
  );
  /* And - the property that keeps a whole test suite from becoming a client
   * of someone's free service - nothing was fetched. */
  assert.equal(fetchImpl.calls.length, 0);
});

test('a provider outage is a household sentence, never an upstream body', async () => {
  const fetchImpl = fakeFetch(() => 503);
  await assert.rejects(
    () => openMeteo.read(request({fetch: fetchImpl})),
    (error: ProviderError) => {
      assert.equal(error.code, 'unreachable');
      assert.match(error.message, /no account/i);
      return true;
    },
  );
});

test('the outlook maps daily fields and never reports a clear night for a whole day', async () => {
  const fetchImpl = fakeFetch(() => ({
    daily_units: {temperature_2m_max: '\u00b0C'},
    daily: {
      time: ['2026-09-23', '2026-09-24'],
      temperature_2m_max: [18.9, 14.2],
      temperature_2m_min: [8.3, 12.3],
      weather_code: [0, 61],
    },
  }));
  const days = await openMeteo.forecast!(request({fetch: fetchImpl}), 2);
  assert.equal(days.length, 2);
  assert.deepEqual(days[0], {date: '2026-09-23', high: 18.9, low: 8.3, state: 'sunny', unit: '\u00b0C'});
  assert.equal(days[1]!.state, 'rainy');
});

/* --------------------------------------------------------------- 4. met.no -- */

function metNoPayload(): unknown {
  return {
    properties: {
      timeseries: [
        {
          time: '2026-09-23T03:00:00Z',
          data: {
            instant: {details: {air_temperature: 8.7, relative_humidity: 93.4}},
            next_1_hours: {summary: {symbol_code: 'clearsky_night'}},
            next_6_hours: {summary: {symbol_code: 'clearsky_day'}},
          },
        },
      ],
    },
  };
}

test('met.no always sends an identifying User-Agent, because their terms require one', async () => {
  const fetchImpl = fakeFetch(() => metNoPayload());
  await metNo.read(request({fetch: fetchImpl}));
  const agent = fetchImpl.calls[0]!.headers['User-Agent'];
  assert.ok(agent !== undefined && agent !== '', 'met.no was called with no User-Agent');
  assert.match(agent, /CommonHomeCanvas/);
});

test('an empty contact falls back to the project address rather than demanding a personal one', () => {
  assert.match(metNoUserAgent(''), /github\.com/);
  assert.match(metNoUserAgent('canvas@example.com'), /canvas@example\.com$/);
  /* Header injection: a newline in a configured value must not become two
   * headers. */
  assert.doesNotMatch(metNoUserAgent('a\r\nX-Evil: 1'), /[\r\n]/);
});

test('met.no reports celsius, so an imperial household gets the conversion at the edge', async () => {
  const metric = await metNo.read(request({fetch: fakeFetch(() => metNoPayload())}));
  assert.equal(metric.temperature, 8.7);
  assert.equal(metric.unit, '\u00b0C');

  const imperial = await metNo.read(request({
    fetch: fakeFetch(() => metNoPayload()),
    units: 'imperial',
  }));
  assert.equal(imperial.unit, '\u00b0F');
  assert.ok(Math.abs(imperial.temperature! - 47.66) < 0.01, `got ${imperial.temperature}`);
});

test('the condition comes from the forecast summary, not from the instant', async () => {
  /* An instantaneous reading has a temperature and a humidity but no notion
   * of "rain" - reading the condition off `instant` would always be empty. */
  const reading = await metNo.read(request({fetch: fakeFetch(() => metNoPayload())}));
  assert.equal(reading.state, 'clear-night');
  assert.equal(reading.attribution?.source, 'MET Norway');
});

test('a 403 from met.no explains the contact requirement rather than saying "forbidden"', async () => {
  await assert.rejects(
    () => metNo.read(request({fetch: fakeFetch(() => 403)})),
    (error: ProviderError) => {
      assert.match(error.message, /identifying contact/i);
      return true;
    },
  );
});

/* ------------------------------------------------------- 5. Home Assistant -- */

test('home assistant is advanced, needs no location, and reads the entity it is given', async () => {
  assert.equal(homeAssistant.advanced, true);
  assert.equal(homeAssistant.needsLocation, false);

  const fetchImpl = fakeFetch(() => ({
    state: 'partlycloudy',
    attributes: {
      temperature: 17.4,
      temperature_unit: '\u00b0C',
      friendly_name: 'Porch',
      attribution: 'Weather forecast from Example Met Service, delivered by Home Assistant.',
    },
  }));
  const reading = await homeAssistant.read(request({
    fetch: fetchImpl,
    location: null,
    credential: TOKEN,
    options: {url: 'https://ha.example.com', weatherEntity: 'weather.sample'},
  }));

  assert.equal(reading.temperature, 17.4);
  assert.equal(reading.state, 'partlycloudy');
  assert.equal(reading.place, 'Porch');
  /* The whole sentence shortened to the institution, which is what the
   * licences ask for and what fits under a number on a wall. */
  assert.equal(reading.attribution?.source, 'Example Met Service');
  assert.match(fetchImpl.calls[0]!.headers.Authorization!, /^Bearer /);
});

test('a rejected token produces a human sentence that does not echo one character of it', async () => {
  await assert.rejects(
    () => homeAssistant.read(request({
      fetch: fakeFetch(() => 401),
      credential: TOKEN,
      options: {url: 'https://ha.example.com', weatherEntity: 'weather.sample'},
    })),
    (error: ProviderError) => {
      assert.equal(error.code, 'unauthorised');
      assert.equal(error.message, 'That token was rejected by Home Assistant.');
      /* Not the token, not a prefix of it, not its length. */
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes(TOKEN.slice(0, 6)));
      assert.ok(!error.message.includes(TOKEN.slice(-4)));
      assert.ok(!/\d{2,}/.test(error.message), 'the message carries a number that could be a length');
      return true;
    },
  );
});

test('a network failure against Home Assistant never puts the LAN address in the message', async () => {
  const lanish = 'https://homeassistant.example.com';
  await assert.rejects(
    () => homeAssistant.read(request({
      fetch: (async () => {
        throw new Error(`connect ECONNREFUSED ${lanish}/api/states/weather.sample`);
      }) as unknown as ProviderFetch,
      credential: TOKEN,
      options: {url: lanish, weatherEntity: 'weather.sample'},
    })),
    (error: ProviderError) => {
      assert.ok(!error.message.includes('example.com'), `the message carried the address: ${error.message}`);
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message, /could not be reached/i);
      return true;
    },
  );
});

test('a half-configured Home Assistant says which half is missing and fetches nothing', async () => {
  const fetchImpl = fakeFetch(() => ({}));
  await assert.rejects(
    () => homeAssistant.read(request({
      fetch: fetchImpl,
      credential: null,
      options: {url: 'https://ha.example.com', weatherEntity: 'weather.sample'},
    })),
    (error: ProviderError) => {
      assert.equal(error.code, 'unconfigured');
      assert.match(error.message, /token/i);
      return true;
    },
  );
  await assert.rejects(
    () => homeAssistant.read(request({
      fetch: fetchImpl,
      credential: TOKEN,
      options: {url: 'https://ha.example.com'},
    })),
    (error: ProviderError) => {
      assert.match(error.message, /entity/i);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0, 'an unconfigured provider made a request anyway');
});

/* ------------------------------------------------------------ 6. geocoding -- */

test('geocoding is keyless and returns several candidates rather than guessing', async () => {
  const fetchImpl = fakeFetch(() => ({
    results: [
      {name: 'Springfield', latitude: 39.8017, longitude: -89.6437, admin1: 'Illinois', country_code: 'US'},
      {name: 'Springfield', latitude: 42.1015, longitude: -72.5898, admin1: 'Massachusetts', country_code: 'US'},
    ],
  }));
  const places = await geocode('Springfield', {fetch: fetchImpl, count: 5});
  assert.equal(places.length, 2, '"Springfield" is a real ambiguity a server must not resolve for you');
  assert.equal(places[0]!.region, 'Illinois');
  assert.deepEqual(fetchImpl.calls[0]!.headers, {}, 'the geocoder was sent a header');
  assert.doesNotMatch(fetchImpl.calls[0]!.url, /key|token|apikey/i);
});

test('geocoding an empty string does nothing at all', async () => {
  const fetchImpl = fakeFetch(() => ({}));
  assert.deepEqual(await geocode('   ', {fetch: fetchImpl}), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a geocoder result missing coordinates is dropped rather than rendered as 0,0', async () => {
  const places = await geocode('Nowhere', {
    fetch: fakeFetch(() => ({results: [{name: 'Nowhere'}, {latitude: 1, longitude: 2}]})),
  });
  assert.deepEqual(places, [], 'a half-formed result became a location at the equator');
});

/* --------------------------------------------------- 7. no household values -- */

test('no provider source carries a household value or a real credential', async () => {
  /* Generic patterns, never this household's actual values: a detector that
   * spells out the private value publishes it in the repository it guards. */
  const {readFile, readdir} = await import('node:fs/promises');
  const here = new URL('.', import.meta.url);
  const forbidden: Array<[string, RegExp]> = [
    ['a private LAN address', /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ['a VPN address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['a hardcoded person entity', /['"`]person\.\w/],
    ['a hardcoded calendar entity', /['"`]calendar\.\w/],
    ['a developer home directory', /\/home\/\w/],
  ];
  for (const file of await readdir(here)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const content = await readFile(new URL(file, here), 'utf8');
    for (const [label, pattern] of forbidden) {
      const hit = pattern.exec(content);
      assert.equal(hit, null, `${file} contains ${label}: ${hit?.[0]}`);
    }
  }
});
