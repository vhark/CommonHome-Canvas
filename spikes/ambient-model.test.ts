import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  type Photo,
  type Snapshot,
  type Weather,
  authorKey,
  conditionText,
  creditText,
  eventTime,
  focal,
  greeting,
  healthText,
  photoCredit,
  quoteOfDay,
  shortenAttribution,
  spacedOrder,
  weatherCredit,
} from './ambient-model.ts';
import {QUOTES} from './quotes.ts';

const LOCALE = 'en-US';

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    weather: null,
    events: [],
    peopleHome: [],
    generatedAt: new Date().toISOString(),
    degraded: [],
    ...over,
  };
}

const weather = (state: string, temperature: number | null = 70) => ({
  state, temperature, unit: '°F', attribution: 'met.no',
});

/* ------------------------------------------------ condition naming rules */

test('known Home Assistant slugs render as English, not identifiers', () => {
  assert.equal(conditionText('partlycloudy'), 'Partly cloudy');
  assert.equal(conditionText('clear-night'), 'Clear');
  assert.equal(conditionText('lightning-rainy'), 'Thunderstorms');
  assert.equal(conditionText('pouring'), 'Heavy rain');
  assert.equal(conditionText('snowy-rainy'), 'Sleet');
  assert.equal(conditionText('exceptional'), 'Severe weather');
});

test('no mapped condition leaks a raw separator to the wall', () => {
  for (const slug of ['clear-night', 'lightning-rainy', 'snowy-rainy',
                      'windy-variant', 'partlycloudy']) {
    const text = conditionText(slug);
    assert.ok(!text.includes('-'), `${slug} -> ${text} still contains a hyphen`);
    assert.ok(!text.includes('_'), `${slug} -> ${text} still contains an underscore`);
    assert.notEqual(text, slug, `${slug} was passed through unmapped`);
  }
});

test('an unknown future slug degrades to readable text, never a raw slug', () => {
  // HA adds conditions over time; the display must not start showing
  // developer strings the day that happens.
  assert.equal(conditionText('meteor_shower'), 'Meteor shower');
  assert.equal(conditionText('some-new-condition'), 'Some new condition');
});

test('an empty or missing condition produces empty text, not "Undefined"', () => {
  assert.equal(conditionText(''), '');
  assert.equal(conditionText(undefined as unknown as string), '');
});

/* ------------------------------------------------------ focal slot rules */

test('the focal slot holds exactly one element or nothing', () => {
  const result = focal(snapshot({
    weather: weather('sunny'),
    events: [{summary: 'Dentist', start: '2099-01-01T10:00:00Z', allDay: false}],
  }), new Date('2099-01-01T08:00:00Z'), LOCALE);
  assert.ok(result);
  assert.deepEqual(Object.keys(result!).sort(), ['label', 'value']);
});

test('an event fills the slot even when weather data is present', () => {
  // The slot belongs to commitments alone; weather present in the snapshot
  // must not affect it either way.
  const result = focal(snapshot({
    weather: weather('sunny'),
    events: [{summary: 'Dentist', start: '2099-01-01T10:00:00Z', allDay: false}],
  }), new Date('2099-01-01T08:00:00Z'), LOCALE);
  assert.equal(result!.value, 'Dentist');
  assert.ok(result!.label.startsWith('Next'));
});

test('weather never occupies the focal slot', () => {
  // Weather renders once, top-right, with its credit. Repeating it in the
  // centre made the screen text-heavy; an empty slot is the calm outcome.
  const result = focal(snapshot({weather: weather('partlycloudy', 70)}),
    new Date(), LOCALE);
  assert.equal(result, null);
});

test('a past event never occupies the slot', () => {
  // Showing this morning's appointment at 5pm is worse than showing nothing,
  // because a glance reads it as current.
  const result = focal(snapshot({
    events: [{summary: 'This morning', start: '2099-01-01T06:00:00Z', allDay: false}],
  }), new Date('2099-01-01T18:00:00Z'), LOCALE);
  assert.equal(result, null);
});

test('the soonest upcoming event wins regardless of input order', () => {
  const result = focal(snapshot({
    events: [
      {summary: 'Later', start: '2099-01-01T15:00:00Z', allDay: false},
      {summary: 'Sooner', start: '2099-01-01T09:00:00Z', allDay: false},
    ],
  }), new Date('2099-01-01T08:00:00Z'), LOCALE);
  assert.equal(result!.value, 'Sooner');
});

test('all-day events stay eligible and are labelled as such', () => {
  const result = focal(snapshot({
    events: [{summary: 'Birthday', start: '2099-01-01', allDay: true}],
  }), new Date('2099-01-01T18:00:00Z'), LOCALE);
  assert.equal(result!.value, 'Birthday');
  assert.equal(result!.label, 'Next · All day');
});

test('a malformed event date cannot occupy the slot', () => {
  const result = focal(snapshot({
    events: [{summary: 'Broken', start: 'not-a-date', allDay: false}],
    weather: weather('sunny'),
  }), new Date(), LOCALE);
  // A garbage date must not render as a commitment; with weather barred from
  // the slot, the correct outcome is an empty slot.
  assert.equal(result, null);
});

test('weather without a temperature cannot fill the slot', () => {
  // A condition with no reading is not worth a focal slot.
  assert.equal(focal(snapshot({weather: weather('sunny', null)}), new Date(), LOCALE), null);
});

test('an empty snapshot yields no focal element rather than a placeholder', () => {
  assert.equal(focal(snapshot(), new Date(), LOCALE), null);
});

test('fractional temperatures are never eligible for the focal slot either', () => {
  // Rounding now happens in the weather corner's render path; focal() must
  // simply refuse weather entirely, fractional or not.
  assert.equal(focal(snapshot({weather: weather('sunny', 69.6)}), new Date(), LOCALE), null);
});

/* ----------------------------------------------------------- event times */

test('all-day events report "All day" instead of a midnight time', () => {
  assert.equal(eventTime({summary: 'x', start: '2099-01-01', allDay: true}, LOCALE), 'All day');
});

test('an unparseable start yields empty text, not "Invalid Date"', () => {
  assert.equal(eventTime({summary: 'x', start: 'nope', allDay: false}, LOCALE), '');
});

/* -------------------------------------------------------------- greeting */

test('greeting follows the hour', () => {
  const at = (h: number) => greeting(new Date(2099, 0, 1, h, 0), []);
  assert.equal(at(2), 'Good night');
  assert.equal(at(9), 'Good morning');
  assert.equal(at(14), 'Good afternoon');
  assert.equal(at(19), 'Good evening');
  assert.equal(at(23), 'Good night');
});

test('greeting names whoever is home, in readable English', () => {
  const noon = new Date(2099, 0, 1, 9, 0);
  assert.equal(greeting(noon, []), 'Good morning');
  /* Placeholder names, not this household's. A test fixture is shipped
   * source: real family names in one would be published on every clone. */
  assert.equal(greeting(noon, ['Ada']), 'Good morning, Ada');
  assert.equal(greeting(noon, ['Ada', 'Grace']), 'Good morning, Ada and Grace');
  assert.equal(greeting(noon, ['Ada', 'Grace', 'Lin']),
    'Good morning, Ada, Grace and Lin');
});

/* ------------------------------------------------- staleness disclosure */

test('a healthy snapshot shows no health text at all', () => {
  assert.equal(healthText(snapshot(), new Date()), '');
});

test('no snapshot at all is disclosed rather than left blank', () => {
  assert.equal(healthText(null, new Date()), 'Waiting for data');
});

test('a fresh partial snapshot names what is missing', () => {
  const now = new Date('2099-01-01T12:00:00Z');
  const text = healthText(snapshot({
    degraded: ['calendar'],
    generatedAt: '2099-01-01T11:59:30Z',
  }), now);
  assert.equal(text, 'Partial: calendar');
});

test('a stale snapshot discloses its age instead of passing as current', () => {
  // Never-blank must not become silently-wrong.
  const now = new Date('2099-01-01T12:00:00Z');
  const text = healthText(snapshot({
    degraded: ['weather'],
    generatedAt: '2099-01-01T11:30:00Z',
  }), now);
  assert.equal(text, 'Showing last known good · 30 min old');
});

test('an unparseable timestamp still discloses degradation', () => {
  const text = healthText(snapshot({degraded: ['weather'], generatedAt: 'nope'}), new Date());
  assert.equal(text, 'Partial: weather');
});

/* ---------------------------------------------------------- attribution */

const metno = 'Weather forecast from met.no, delivered by the Norwegian Meteorological Institute.';

const photo: Photo = {
  url: 'https://images.unsplash.com/photo-1?ixid=abc&w=1920',
  color: '#f3f3f3',
  blurHash: 'L,ONB}t7tRj@',
  photographer: 'Marek Piwnicki',
  photographerUrl: 'https://unsplash.com/@marekpiwnicki?utm_source=commonhome_canvas&utm_medium=referral',
  source: 'Unsplash',
  sourceUrl: 'https://unsplash.com/?utm_source=commonhome_canvas&utm_medium=referral',
};

const creditWeather: Weather = {
  state: 'partlycloudy', temperature: 68, unit: '\u00b0F', attribution: metno,
};

test("met.no's full sentence is shortened to the institution credited", () => {
  // Rendered verbatim this is a paragraph in a corner of a television.
  assert.equal(shortenAttribution(metno), 'met.no');
});

test('an attribution with no "from" clause is preserved rather than dropped', () => {
  assert.equal(shortenAttribution('Data by NOAA'), 'Data by NOAA');
});

test('a source that cannot be identified yields no credit rather than an empty label', () => {
  assert.equal(weatherCredit({...creditWeather, attribution: ''}), null);
  assert.equal(weatherCredit(null), null);
});

test('weather credit is bound to the weather it describes', () => {
  const c = weatherCredit(creditWeather);
  assert.equal(c?.of, 'weather');
  assert.equal(c?.source, 'met.no');
});

test("photo credit uses Unsplash's required wording", () => {
  // The API guidelines require "Photo by <name> on Unsplash".
  assert.equal(creditText(photoCredit(photo)), 'Photo by Marek Piwnicki on Unsplash');
});

test('photo credit carries the required UTM attribution links', () => {
  const c = photoCredit(photo);
  assert.match(c!.authorUrl!, /utm_source=commonhome_canvas/);
  assert.match(c!.authorUrl!, /utm_medium=referral/);
  assert.match(c!.sourceUrl!, /utm_source=commonhome_canvas/);
});

test('an incomplete photo record yields no credit rather than crediting nobody', () => {
  assert.equal(photoCredit({...photo, photographer: ''}), null);
  assert.equal(photoCredit(null), null);
});

test('credit text is empty for no credit, never the string "null"', () => {
  assert.equal(creditText(null), '');
});

/* ---------------------------------------------------------------- quotes */

test('the built-in library holds at least 100 attributed quotes', () => {
  assert.ok(QUOTES.length >= 100, `only ${QUOTES.length} quotes`);
});

test('every quote names an author - attribution applies to words too', () => {
  for (const q of QUOTES) {
    assert.ok(q.text.trim().length > 0, 'empty quote text');
    assert.ok(q.author.trim().length > 0, `unattributed quote: "${q.text.slice(0, 40)}"`);
  }
});

test('no quote is duplicated', () => {
  const texts = QUOTES.map((q) => q.text.toLowerCase().replace(/\W/g, ''));
  assert.equal(new Set(texts).size, texts.length);
});

test('quotes are sized for a wall, not a page', () => {
  // The centre column wraps a 58px serif at ~1150px; past ~300 characters a
  // quote becomes a paragraph and the composition stops being image-focused.
  for (const q of QUOTES) {
    assert.ok(q.text.length <= 300, `quote too long (${q.text.length}): "${q.text.slice(0, 40)}"`);
  }
});

test('the same local date always yields the same quote', () => {
  const a = quoteOfDay(new Date('2026-09-21T06:00:00'));
  const b = quoteOfDay(new Date('2026-09-21T23:59:00'));
  assert.deepEqual(a, b);
});

test('every quote gets exactly one day before the library repeats', () => {
  /* Was 'consecutive days yield consecutive library entries', asserting a
   * walk through storage order. That behaviour was the bug: the library is
   * grouped thematically, so neighbouring entries share an author and the
   * same person appeared two days running. The guarantee worth keeping is
   * COVERAGE - every quote gets its day, nothing repeats early - which this
   * asserts without pinning the order. */
  const start = new Date('2026-09-21T12:00:00');
  const seen = new Set<string>();
  for (let d = 0; d < QUOTES.length; d++) {
    const day = new Date(start);
    day.setDate(start.getDate() + d);
    seen.add(quoteOfDay(day)!.text);
  }
  assert.equal(seen.size, QUOTES.length,
    'a full cycle must show every quote exactly once');

  /* And the cycle closes: day N+1 returns to day 1's quote. */
  const wrapped = new Date(start);
  wrapped.setDate(start.getDate() + QUOTES.length);
  assert.equal(quoteOfDay(wrapped)!.text, quoteOfDay(start)!.text);
});

test('an empty custom library yields null rather than a crash', () => {
  assert.equal(quoteOfDay(new Date(), []), null);
});

test('a household library substitutes for the built-in one', () => {
  // The signature takes the quote list as a parameter because Phase 2
  // persistence will let a family maintain its own database; the built-in
  // set is a default, not a limit.
  const mine = [{text: 'Blob is the correct pancake shape.', author: 'Migs'}];
  assert.deepEqual(quoteOfDay(new Date(), mine), mine[0]);
});

/* -------------------------------------------- quote author spacing (regression)
 *
 * The reported symptom was two Marcus Aurelius quotes on consecutive days. The
 * cause was the ORDER, not the library size, so these tests assert the order
 * property directly - a larger library would not have satisfied them. */

test('no two consecutive days share an author, across the whole library', () => {
  const order = spacedOrder(QUOTES);
  assert.equal(order.length, QUOTES.length, 'ordering must be a permutation');
  assert.equal(new Set(order).size, QUOTES.length, 'ordering must not repeat or drop a quote');
  const clashes: string[] = [];
  for (let i = 1; i < order.length; i++) {
    const a = authorKey(QUOTES[order[i - 1]].author);
    const b = authorKey(QUOTES[order[i]].author);
    if (a === b) clashes.push(`slot ${i - 1}/${i}: ${a}`);
  }
  assert.deepEqual(clashes, [], `consecutive same-author days: ${clashes.join(', ')}`);
});

test('the sequence wraps without repeating an author at the library boundary', () => {
  const order = spacedOrder(QUOTES);
  const first = authorKey(QUOTES[order[0]].author);
  const last = authorKey(QUOTES[order[order.length - 1]].author);
  assert.notEqual(first, last, 'last day and first day share an author when the cycle wraps');
});

test('walking the raw library order would have failed - the bug was real', () => {
  /* Guards the premise: if the library is ever reordered so storage order is
   * already spaced, this test tells us the regression tests above stopped
   * proving anything. */
  let adjacent = 0;
  for (let i = 1; i < QUOTES.length; i++) {
    if (authorKey(QUOTES[i - 1].author) === authorKey(QUOTES[i].author)) adjacent++;
  }
  assert.ok(adjacent > 0,
    'storage order no longer clusters authors, so spacedOrder is untested by the real library');
});

test('hedged attributions count as the same author as their bare form', () => {
  assert.equal(authorKey('Attributed to Eleanor Roosevelt'), authorKey('Eleanor Roosevelt'));
  assert.equal(authorKey('Often attributed to Mark Twain'), authorKey('Mark Twain'));
  assert.equal(authorKey('Traditional; often attributed to Churchill'), 'churchill');
  assert.notEqual(authorKey('Maya Angelou'), authorKey('Toni Morrison'));
});

test('spacing holds for a deliberately lopsided library', () => {
  const lopsided = [
    {text: 'a', author: 'Repeat'}, {text: 'b', author: 'Repeat'},
    {text: 'c', author: 'Repeat'}, {text: 'd', author: 'Repeat'},
    {text: 'e', author: 'One'}, {text: 'f', author: 'Two'},
    {text: 'g', author: 'Three'}, {text: 'h', author: 'Four'},
  ];
  const order = spacedOrder(lopsided);
  for (let i = 1; i < order.length; i++) {
    assert.notEqual(authorKey(lopsided[order[i - 1]].author),
                    authorKey(lopsided[order[i]].author),
                    `slot ${i} repeats an author in the lopsided case`);
  }
});

test('an impossible library still returns every quote rather than throwing', () => {
  /* One author holding more than half cannot be spaced. A wall display must
   * still render, so this degrades rather than failing. */
  const impossible = [
    {text: 'a', author: 'Dominant'}, {text: 'b', author: 'Dominant'},
    {text: 'c', author: 'Dominant'}, {text: 'd', author: 'Other'},
  ];
  const order = spacedOrder(impossible);
  assert.equal(order.length, 4);
  assert.equal(new Set(order).size, 4, 'every quote still appears exactly once');
});

test('quoteOfDay is stable within a day and advances across days', () => {
  const day1 = new Date('2026-03-01T08:00:00');
  const day1later = new Date('2026-03-01T21:30:00');
  const day2 = new Date('2026-03-02T08:00:00');
  assert.deepEqual(quoteOfDay(day1), quoteOfDay(day1later),
    'the quote must not change as the day passes - a wall display re-renders often');
  assert.notDeepEqual(quoteOfDay(day1), quoteOfDay(day2));
});

test('consecutive real days never show the same author, over a full cycle', () => {
  /* The end-to-end version of the complaint: step real dates through a whole
   * library cycle and assert no repeat, rather than trusting the ordering. */
  const start = new Date('2026-01-01T12:00:00');
  let previous = '';
  for (let d = 0; d < QUOTES.length + 1; d++) {
    const day = new Date(start);
    day.setDate(start.getDate() + d);
    const q = quoteOfDay(day)!;
    const key = authorKey(q.author);
    assert.notEqual(key, previous, `day ${d} repeats author ${key}`);
    previous = key;
  }
});
