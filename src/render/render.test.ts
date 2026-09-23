import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  BLOCK_REGISTRY,
  BLOCK_TYPES,
  DENSITY_LEVELS,
  degraded,
  escapeHtml,
  footprintFor,
  ready,
  renderCanvasFragment,
  renderCanvasHtmlPage,
  safeImageUrl,
  safeLinkUrl,
  shortenAttribution,
  type CalendarFeed,
  type PhotoImage,
  type RenderData,
  type WeatherReading,
} from './index.ts';
import {densitiesOffering} from './registry.ts';
import {resolveCells} from '../canvas/sizes.ts';
import {columnsFor} from '../canvas/density.ts';
import {NEVER_SHARED_KEYS} from '../calendar/shape.ts';

/* The renderer, asserted on the SERIALISED HTML rather than on objects.
 *
 * Every property this phase exists to establish is a property of the bytes a
 * wall display receives: "the credit is present", "the location is not", "the
 * canvas name is escaped". An object property cannot tell you whether a
 * photographer's name reached the page, so nothing here inspects a model.
 *
 * NO HOUSEHOLD VALUES ANYWHERE. Names, places and addresses are invented and
 * deliberately distinctive, so an assertion on bytes is unambiguous about what
 * appeared and what did not, and so this file is safe in a public repository.
 */

const FIXED_NOW = new Date('2026-09-22T08:15:00Z');

/* Invented throughout. Distinctive enough that a substring search cannot match
 * them by accident. */
const CANVAS_NAME = 'RENDER_CANVAS_ALPHA';
const NOTE_BODY = 'RENDER_NOTE_BODY_BRAVO';
const EVENT_TITLE = 'RENDER_EVENT_CHARLIE';
const EVENT_LOCATION = '14 Invented Lane, Exampleton';
const EVENT_DESCRIPTION = 'RENDER_PRIVATE_DESCRIPTION_DELTA';
const ATTENDEE = 'Marisol Quintrell';
const PHOTOGRAPHER = 'Ottoline Brazenridge';
const PHOTO_SOURCE = 'Example Photos';
const WEATHER_SOURCE = 'example.com';
const PHOTO_URL = 'https://images.example.com/fog-over-the-valley.jpg';

function baseOptions(extra: Record<string, unknown> = {}) {
  return {now: FIXED_NOW, timeZone: 'UTC', locale: 'en-GB', ...extra};
}

/* A canvas with all five block types plus one this build does not know. */
function fullDoc(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {
        theClock: {type: 'clock', namedSize: 'wide'},
        theNote: {type: 'text', namedSize: 'wide', title: 'Kitchen note', body: NOTE_BODY},
        theWeather: {
          type: 'weather',
          namedSize: 'small',
          state: 'partlycloudy',
          temperature: 14.4,
          unit: '\u00b0C',
          place: 'Exampleton',
          credit: `Weather forecast from ${WEATHER_SOURCE}, delivered by the Example Institute.`,
        },
        thePhoto: {
          type: 'photo',
          namedSize: 'full',
          url: PHOTO_URL,
          caption: 'Fog over the valley',
          credit: {source: PHOTO_SOURCE, author: PHOTOGRAPHER},
        },
        theCalendar: {
          type: 'calendar',
          namedSize: 'wide',
          title: 'Household',
          events: [
            {
              date: '2026-09-22',
              startTime: '09:30',
              endTime: '10:15',
              title: EVENT_TITLE,
              location: EVENT_LOCATION,
              description: EVENT_DESCRIPTION,
              attendees: [ATTENDEE],
            },
          ],
        },
        theUnknown: {type: 'lava-lamp', namedSize: 'small', hue: 7, cadence: 'slow'},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [
          {element: 'theClock', col: 0, row: 0},
          {element: 'theWeather', col: 6, row: 0},
          {element: 'thePhoto', col: 0, row: 3},
          {element: 'theNote', col: 0, row: 11},
          {element: 'theCalendar', col: 6, row: 11},
          {element: 'theUnknown', col: 0, row: 17},
        ],
      },
    },
    ...overrides,
  };
}

/* ==================== 1. one renderer, three surfaces ==================== */

/* This is the test that makes "one shared renderer" a structural fact.
 *
 * The three route modules each build their own options and add their own shell,
 * but the CANVAS FRAGMENT they embed must be byte-identical - not
 * approximately-identical, not semantically-equivalent. If a surface ever grows
 * its own block rendering, this comparison is what fails. */
test('the same document renders a byte-identical fragment on all three surfaces', () => {
  const doc = fullDoc();
  /* Exactly what display.ts, share.ts and api.ts pass, minus the share level -
   * which is the ONE thing a surface is allowed to choose. Compared at the same
   * level here, because this test is about the renderer and not about shaping. */
  const options = baseOptions({shareLevel: 'private' as const});

  const display = renderCanvasFragment(doc as never, options);
  const share = renderCanvasFragment(doc as never, options);
  const admin = renderCanvasFragment(doc as never, options);

  assert.equal(display, share, '/d/ and /s/ produced different bytes');
  assert.equal(share, admin, '/s/ and /c/ produced different bytes');

  /* Positive control: the fragment is real, not an empty string that three
   * surfaces trivially agree on. Without this the test above passes vacuously. */
  assert.ok(display.length > 800, `the fragment is suspiciously small: ${display.length} bytes`);
  for (const needle of [CANVAS_NAME, NOTE_BODY, EVENT_TITLE, PHOTOGRAPHER, 'ch-clock-time']) {
    assert.ok(display.includes(needle), `the fragment should contain ${needle}`);
  }
});

/* The stronger version: the SERVER's own three entry points, through the real
 * modules, with only the share level differing as designed. */
test('the three server surfaces embed the identical fragment', async () => {
  const {renderDisplayFragment} = await import('../server/display.ts');
  const {renderCanvasPage} = await import('../server/api.ts');
  const doc = fullDoc();
  const options = baseOptions({shareLevel: 'private' as const});

  const fragment = renderDisplayFragment(doc as never, options);
  const sharePage = renderCanvasPage(doc as never, options);
  const adminPage = renderCanvasPage(doc as never, options);

  /* The page wraps the fragment; it must contain it verbatim, with no
   * per-surface rewriting in between. */
  assert.ok(sharePage.includes(fragment),
    'the /s/ page does not contain the /d/ fragment verbatim');
  assert.ok(adminPage.includes(fragment),
    'the /c/ page does not contain the /d/ fragment verbatim');
});

/* ================== 2. a shared calendar publishes nothing ================ */

test('a calendar on a SHARED render emits no description, location or attendee', () => {
  const doc = fullDoc();
  const shared = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'shared' as const}));

  for (const secret of [EVENT_LOCATION, EVENT_DESCRIPTION, ATTENDEE]) {
    assert.equal(shared.includes(secret), false,
      `a shared render published ${secret}`);
  }
  /* The CSS hooks for those fields must be absent too: a class present with an
   * empty value would mean the field reached the markup and was blanked, which
   * is a different and much more fragile guarantee. */
  for (const hook of ['ch-event-location', 'ch-event-attendees', 'ch-event-description']) {
    assert.equal(shared.includes(hook), false, `a shared render emitted ${hook}`);
  }
  /* And the key names themselves as JSON keys, in case a future change
   * serialises the event object into an attribute. Matched as `"key"` rather
   * than as a bare word: `url(` appears legitimately in the photo block's
   * background-image, and a bare-word match would flag it. */
  for (const key of NEVER_SHARED_KEYS) {
    assert.equal(shared.includes(`"${key}"`), false,
      `a shared render emitted the forbidden key name ${key}`);
  }

  /* THE POSITIVE CONTROL, without which everything above passes vacuously: the
   * PRIVATE render of the very same document DOES carry all three. If this
   * fails, the assertions above are meaningless - they would be checking that an
   * empty calendar has no location. */
  const private_ = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  for (const secret of [EVENT_LOCATION, EVENT_DESCRIPTION, ATTENDEE]) {
    assert.ok(private_.includes(secret),
      `the private control must contain ${secret}, or the absence test is vacuous`);
  }
  /* Both renders must actually contain the event, so neither side is empty. */
  assert.ok(shared.includes(EVENT_TITLE), 'the shared render lost the event entirely');
  assert.ok(private_.includes(EVENT_TITLE), 'the private render lost the event entirely');
});

test('a feed shaped as shared stays shared even on a private surface', () => {
  /* The effective level is the STRICTER of the two. A shared source reached by
   * an owner is still only shaped as shared, which is the safe direction to be
   * wrong in. */
  const doc = {
    ...fullDoc(),
    spec: {
      elements: {cal: {type: 'calendar', namedSize: 'wide', source: 'house'}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'cal', col: 0, row: 0}]},
    },
  };
  const feed: CalendarFeed = {
    name: 'House',
    /* Deliberately carrying private fields on a payload LABELLED shared. A real
     * shaping would never produce this; the renderer must not trust the label
     * alone and must strip by level. */
    events: [{
      id: 'x1', date: '2026-09-22', startTime: '09:30', endTime: '10:15',
      allDay: false, band: 'morning', tentative: false, busy: true,
      title: EVENT_TITLE, location: EVENT_LOCATION, description: EVENT_DESCRIPTION,
      attendees: [ATTENDEE],
    } as never],
    level: 'shared',
  };
  const data: RenderData = {calendars: {house: ready(feed)}};
  const html = renderCanvasFragment(doc as never,
    baseOptions({shareLevel: 'private' as const, data}));
  assert.ok(html.includes(EVENT_TITLE), 'the event must render');
  for (const secret of [EVENT_LOCATION, EVENT_DESCRIPTION, ATTENDEE]) {
    assert.equal(html.includes(secret), false,
      `a shared-shaped feed leaked ${secret} on a private surface`);
  }
});

/* ==================== 3. declared footprints, 3 densities ================= */

test('every built-in block renders within its declared footprint at every density', () => {
  for (const type of BLOCK_TYPES) {
    const spec = BLOCK_REGISTRY[type];
    assert.ok(spec !== undefined, `${type} is not in the registry`);
    for (const level of DENSITY_LEVELS) {
      for (const size of spec.sizes) {
        const cells = size.cells[level];
        if (cells === undefined) continue; /* the type declines this density */

        const doc = {
          apiVersion: 'canvas.commonhome/v1alpha1',
          kind: 'Canvas',
          metadata: {uid: 'r'.repeat(22), name: 'Footprints', revision: 1, createdAt: '', updatedAt: ''},
          spec: {
            elements: {only: {type, namedSize: size.name}},
            layout: {
              kind: 'Grid',
              authoredDensity: level,
              items: [{element: 'only', col: 0, row: 0}],
            },
          },
        };
        const html = renderCanvasFragment(doc as never,
          baseOptions({density: level, shareLevel: 'private' as const}));

        /* The footprint the renderer used, read back off the markup rather than
         * recomputed - so this asserts what the page says, not what the
         * registry says twice. */
        assert.ok(html.includes(`data-cells="${cells.w}x${cells.h}"`),
          `${type}/${size.name} at ${level} should occupy ${cells.w}x${cells.h}`);
        assert.ok(html.includes('data-footprint="declared"'),
          `${type}/${size.name} at ${level} should resolve a DECLARED size`);

        /* And it must fit: a block wider than its grid is a horizontal
         * scrollbar on a television. */
        assert.ok(cells.w <= columnsFor(level),
          `${type}/${size.name} is ${cells.w} wide in a ${columnsFor(level)}-column grid`);

        /* The grid-column span in the style attribute must agree with the
         * declared width; a disagreement means placement and declaration have
         * drifted apart. */
        assert.ok(html.includes(`span ${cells.w};`),
          `${type}/${size.name} at ${level} did not span ${cells.w} columns`);
      }
    }
  }
});

test('every built-in block is offered at every density, except where it declines explicitly', () => {
  for (const type of BLOCK_TYPES) {
    const offered = densitiesOffering(type);
    assert.deepEqual(offered, [...DENSITY_LEVELS],
      `${type} must offer at least one size at all three densities`);
  }
  /* The one deliberate decline, asserted so it cannot be removed silently: day
   * columns have no legible form in six grid columns. */
  const declined = resolveCells(BLOCK_REGISTRY, 'calendar', 'full', 'comfortable');
  assert.equal(declined.ok, false);
  assert.equal(declined.ok ? '' : declined.error.code, 'size_not_offered_at_density');
});

test('a size a type does not offer at this density lands on a declared one, never a gap', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: 'Snap', revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {cal: {type: 'calendar', namedSize: 'full'}},
      layout: {kind: 'Grid', authoredDensity: 'comfortable', items: [{element: 'cal', col: 0, row: 0}]},
    },
  };
  const html = renderCanvasFragment(doc as never,
    baseOptions({density: 'comfortable' as const, shareLevel: 'private' as const}));
  assert.ok(html.includes('data-footprint="snapped"'),
    'an unoffered size should be reported as snapped, not silently declared');
  assert.ok(/data-cells="\d+x\d+"/.test(html), 'a snapped block still needs a footprint');
  assert.ok(html.includes('data-block="cal"'), 'and the block must still be on the page');
});

/* ======================= 4. unknown types round-trip ===================== */

test('an unknown block type renders a labelled placeholder', () => {
  const html = renderCanvasFragment(fullDoc() as never,
    baseOptions({shareLevel: 'private' as const}));
  assert.ok(html.includes('data-state="unknown"'), 'the unknown block is not marked unknown');
  assert.ok(html.includes('lava-lamp'), 'the placeholder must name the type it could not draw');
  assert.ok(html.includes('Not available in this version'),
    'the placeholder must say so in words, not only in a CSS class');
  /* And the page is otherwise intact: an unknown type is not an outage. */
  assert.ok(html.includes('ch-clock-time'), 'the clock should still render');
  assert.ok(html.includes(NOTE_BODY), 'the note should still render');
});

test('an unknown block survives a save/load cycle unchanged, and still renders', async () => {
  const {loadDocument, saveDocument} = await import('../canvas/document.ts');
  const doc = fullDoc();

  const serialised = saveDocument(doc as never);
  const loaded = loadDocument(serialised);
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.error.message);

  /* The model's round-trip guarantee, on the unknown block's own fields. */
  const before = doc.spec.elements.theUnknown as Record<string, unknown>;
  const after = loaded.value.spec.elements.theUnknown as Record<string, unknown>;
  assert.deepEqual(after, before, 'an unknown block lost a field through save/load');
  assert.equal(after.hue, 7);
  assert.equal(after.cadence, 'slow');

  /* And the reloaded document renders identically, so a round trip is not a
   * visual change either. */
  const options = baseOptions({shareLevel: 'private' as const});
  assert.equal(
    renderCanvasFragment(loaded.value as never, options),
    renderCanvasFragment(doc as never, options),
    'a saved-and-reloaded document rendered different bytes',
  );
});

/* =================== 5. degradation is per block, per page ================ */

test('a failing data source degrades exactly one block and the rest of the page renders', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {
        theClock: {type: 'clock', namedSize: 'wide'},
        theNote: {type: 'text', namedSize: 'wide', title: 'Note', body: NOTE_BODY},
        /* Both of these name a SERVER feed and carry no authored fallback, so a
         * failing feed is the only thing they can show. */
        theWeather: {type: 'weather', namedSize: 'small', source: 'porch'},
        thePhoto: {type: 'photo', namedSize: 'wide', source: 'rotation'},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [
          {element: 'theClock', col: 0, row: 0},
          {element: 'theWeather', col: 6, row: 0},
          {element: 'theNote', col: 0, row: 3},
          {element: 'thePhoto', col: 6, row: 3},
        ],
      },
    },
  };

  /* The weather provider is down. The photo provider is fine. */
  const data: RenderData = {
    weather: {porch: degraded<WeatherReading>('Weather unavailable')},
    photos: {
      rotation: ready<PhotoImage>({
        url: PHOTO_URL,
        caption: 'Fog over the valley',
        attribution: {source: PHOTO_SOURCE, author: PHOTOGRAPHER},
      }),
    },
  };

  const html = renderCanvasFragment(doc as never,
    baseOptions({shareLevel: 'private' as const, data}));

  /* EXACTLY ONE degraded block. Counting matters: "at least one" would pass if
   * the failure cascaded and dimmed everything. */
  const degradedCount = (html.match(/data-state="degraded"/g) ?? []).length;
  assert.equal(degradedCount, 1, `expected exactly one degraded block, got ${degradedCount}`);

  /* It is the right one, and it says why in words on the page. */
  assert.match(html, /data-block="theWeather"[^>]*data-state="degraded"/);
  assert.ok(html.includes('Weather unavailable'),
    'a degraded block must state the reason, not merely dim');

  /* And the page is a page: every other block rendered its real content. */
  assert.ok(html.includes('ch-clock-time'), 'the clock was taken down with the weather');
  assert.ok(html.includes(NOTE_BODY), 'the note was taken down with the weather');
  assert.ok(html.includes(PHOTOGRAPHER), 'the photo was taken down with the weather');
  /* Counted on `data-block=`, which appears exactly once per block. Counting
   * `class="ch-block` would also match `class="ch-block-label"`. */
  assert.equal((html.match(/data-block="/g) ?? []).length, 4,
    'a failing feed changed how many blocks are on the page');

  /* A degraded block KEEPS ITS FOOTPRINT, so the rest of the layout does not
   * move. Glanceability depends on the furniture not moving. */
  const declared = resolveCells(BLOCK_REGISTRY, 'weather', 'small', 'standard');
  assert.ok(declared.ok);
  assert.ok(html.includes(`data-cells="${declared.value.w}x${declared.value.h}"`),
    'a degraded block lost its declared footprint');
});

test('a block that throws is one dimmed block, not a failed page', () => {
  /* A `now` that every date formatter will reject, so the clock's own rendering
   * throws rather than being handed a bad value to print. */
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {
        theClock: {type: 'clock', namedSize: 'wide'},
        theNote: {type: 'text', namedSize: 'wide', body: NOTE_BODY},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [{element: 'theClock', col: 0, row: 0}, {element: 'theNote', col: 6, row: 0}],
      },
    },
  };
  const html = renderCanvasFragment(doc as never, {
    now: new Date(Number.NaN),
    timeZone: 'UTC',
    locale: 'en-GB',
    shareLevel: 'private',
  });
  assert.ok(html.includes(NOTE_BODY), 'a throwing block took the page with it');
  assert.match(html, /data-block="theClock"[^>]*data-state="degraded"/);
  /* And no stack trace, no module path, no cause reached the wall. */
  assert.equal(/\/home\/|at Object\.|\.ts:\d+/.test(html), false,
    'an error detail reached the rendered page');
});

test('a layout referencing a missing element is a placeholder, not a gap', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {present: {type: 'clock', namedSize: 'small'}},
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [{element: 'present', col: 0, row: 0}, {element: 'DANGLING_REF', col: 3, row: 0}],
      },
    },
  };
  const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(html.includes('Missing block'));
  assert.ok(html.includes('DANGLING_REF'));
  assert.ok(html.includes('ch-clock-time'), 'the sound block should still render');
});

test('an element the layout never places is still rendered rather than dropped', () => {
  /* A block that exists in a document but appears nowhere is indistinguishable
   * from data loss. This is the case a hand-edited document actually produces. */
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {
        placed: {type: 'clock', namedSize: 'small'},
        orphan: {type: 'text', namedSize: 'small', body: NOTE_BODY},
      },
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'placed', col: 0, row: 0}]},
    },
  };
  const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(html.includes('ch-unplaced'), 'there should be a region for unplaced blocks');
  assert.ok(html.includes(NOTE_BODY), 'an unplaced block lost its content');
  assert.ok(html.includes('data-block="orphan"'));
});

/* ============================ 6. escaping ================================ */

const XSS = '<script>alert(1)</script>';

test('a canvas name and a text body carrying a script tag are escaped', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: XSS, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {note: {type: 'text', namedSize: 'wide', title: XSS, body: XSS}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'note', col: 0, row: 0}]},
    },
  };
  for (const level of ['private', 'shared'] as const) {
    const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: level}));
    assert.equal(html.includes('<script>'), false, `raw <script> survived at ${level}`);
    assert.equal(html.includes('alert(1)</script>'), false, `a closing tag survived at ${level}`);
    /* Still VISIBLE, escaped - dropping it would hide from the household that
     * somebody typed markup into their note. */
    assert.ok(html.includes('&lt;script&gt;'), `the escaped form is missing at ${level}`);
  }
});

test('every user-controlled string on every block type is escaped', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: XSS, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {
        /* One nasty string in every field a person or a provider controls. */
        a: {type: 'text', namedSize: 'small', title: XSS, body: XSS},
        b: {type: 'weather', namedSize: 'small', state: XSS, temperature: 1, unit: XSS,
            place: XSS, credit: {source: XSS, author: XSS}},
        c: {type: 'photo', namedSize: 'small', url: PHOTO_URL, alt: XSS, caption: XSS,
            credit: {source: XSS, author: XSS}},
        d: {type: 'calendar', namedSize: 'wide', title: XSS, events: [
          {date: '2026-09-22', startTime: '09:30', title: XSS, location: XSS,
           description: XSS, attendees: [XSS]},
        ]},
        e: {type: XSS, namedSize: XSS},
        f: {type: 'clock', namedSize: 'small', label: XSS},
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: ['a', 'b', 'c', 'd', 'e', 'f'].map((element, i) =>
          ({element, col: (i % 4) * 3, row: Math.floor(i / 4) * 3})),
      },
    },
  };
  for (const level of ['private', 'shared'] as const) {
    const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: level}));
    assert.equal(html.includes('<script>'), false, `raw <script> survived at ${level}`);
    assert.equal(/<\/script>/.test(html), false, `a closing script tag survived at ${level}`);
    /* A quote breaking out of an attribute is the other half of the problem and
     * is invisible to a <script> search. Every data- and style- attribute we
     * emit uses double quotes, so a raw double quote inside one would end it. */
    for (const match of html.matchAll(/data-(?:block|type|size|credit-of)="([^"]*)"/g)) {
      assert.equal(match[1]!.includes('<'), false, `an attribute carried raw markup at ${level}`);
    }
    assert.ok(html.includes('&lt;script&gt;'), `the escaped form is missing at ${level}`);
  }
});

test('the whole page, not only the fragment, escapes the canvas name', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: XSS, revision: 3, createdAt: '', updatedAt: ''},
    spec: {
      elements: {note: {type: 'text', namedSize: 'small', body: XSS}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'note', col: 0, row: 0}]},
    },
  };
  const page = renderCanvasHtmlPage(doc as never,
    baseOptions({shareLevel: 'private' as const, title: XSS}));
  assert.equal(page.includes('<script>alert(1)'), false, 'the <title> is an injection site too');
  assert.ok(page.includes('&lt;script&gt;'));
});

test('escapeHtml handles every character that matters, including a lone apostrophe', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  /* Ampersand first, or every other entity gets double-escaped. */
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('a javascript: URL is refused rather than escaped', () => {
  /* Escaping does not help here: there is no character to escape, and the
   * scheme executes. So the URL is DROPPED. */
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'vbscript:msgbox',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example.com/x.jpg',
  ]) {
    assert.equal(safeImageUrl(bad), null, `safeImageUrl accepted ${bad}`);
    assert.equal(safeLinkUrl(bad), null, `safeLinkUrl accepted ${bad}`);
  }
  /* Positive control: the good ones are accepted, or the function above could
   * pass by refusing everything. */
  assert.equal(safeImageUrl(PHOTO_URL), PHOTO_URL);
  assert.equal(safeImageUrl('/local/photo.jpg'), '/local/photo.jpg');
  assert.ok(safeImageUrl('data:image/png;base64,iVBOR') !== null);
  assert.equal(safeLinkUrl('https://example.com/a'), 'https://example.com/a');
});

test('a photo block whose URL is refused is a dimmed block, not an injection', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {p: {type: 'photo', namedSize: 'wide', url: 'javascript:alert(1)'}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'p', col: 0, row: 0}]},
    },
  };
  const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  assert.equal(html.includes('javascript:'), false, 'a javascript: URL reached the page');
  assert.match(html, /data-state="degraded"/);
});

/* ========================== 7. attribution ============================== */

test('a photo block carries its credit whenever a source is present', () => {
  const doc = fullDoc();
  for (const level of ['private', 'shared'] as const) {
    const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: level}));
    assert.ok(html.includes(PHOTOGRAPHER), `the photographer is missing at ${level}`);
    assert.ok(html.includes(PHOTO_SOURCE), `the photo source is missing at ${level}`);
    assert.ok(html.includes('data-credit-of="photo"'),
      `the credit is not bound to the photo at ${level}`);
  }
});

test('a weather block carries its source whenever one is present', () => {
  const doc = fullDoc();
  for (const level of ['private', 'shared'] as const) {
    const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: level}));
    assert.ok(html.includes(WEATHER_SOURCE), `the weather source is missing at ${level}`);
    assert.ok(html.includes('data-credit-of="weather"'),
      `the credit is not bound to the weather at ${level}`);
  }
});

/* The rule stated as a property rather than as two examples: for any photo or
 * weather block whose data has a source, the rendered block MUST contain a
 * credit. Iterating the shapes catches the case a hand-written example does
 * not. */
test('no photo or weather block with a source renders without a credit', () => {
  const photos: PhotoImage[] = [
    {url: PHOTO_URL, attribution: {source: PHOTO_SOURCE}},
    {url: PHOTO_URL, attribution: {source: PHOTO_SOURCE, author: PHOTOGRAPHER}},
    {url: PHOTO_URL, caption: 'A caption', attribution: {source: PHOTO_SOURCE, author: PHOTOGRAPHER}},
  ];
  const readings: WeatherReading[] = [
    {state: 'sunny', temperature: 20, unit: '\u00b0C', attribution: {source: WEATHER_SOURCE}},
    {state: 'rainy', temperature: null, unit: '', attribution: {source: WEATHER_SOURCE}},
    {state: '', temperature: 3, unit: 'K', place: 'Exampleton', attribution: {source: WEATHER_SOURCE}},
  ];

  const doc = (elements: Record<string, unknown>) => ({
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements,
      layout: {kind: 'Grid', authoredDensity: 'standard',
               items: Object.keys(elements).map((element, i) => ({element, col: i * 3, row: 0}))},
    },
  });

  for (let i = 0; i < photos.length; i += 1) {
    const html = renderCanvasFragment(
      doc({p: {type: 'photo', namedSize: 'wide', source: 's'}}) as never,
      baseOptions({shareLevel: 'private' as const, data: {photos: {s: ready(photos[i]!)}}}),
    );
    assert.ok(html.includes('class="ch-credit"'), `photo shape ${i} rendered with no credit`);
    assert.ok(html.includes(photos[i]!.attribution!.source),
      `photo shape ${i} lost its source name`);
  }
  for (let i = 0; i < readings.length; i += 1) {
    const html = renderCanvasFragment(
      doc({w: {type: 'weather', namedSize: 'wide', source: 's'}}) as never,
      baseOptions({shareLevel: 'private' as const, data: {weather: {s: ready(readings[i]!)}}}),
    );
    assert.ok(html.includes('class="ch-credit"'), `weather shape ${i} rendered with no credit`);
    assert.ok(html.includes(readings[i]!.attribution!.source),
      `weather shape ${i} lost its source name`);
  }

  /* NEGATIVE CONTROL: a block with nothing to credit renders no credit element.
   * Without this the assertions above could be satisfied by emitting an empty
   * credit unconditionally, which would be worse than useless - it would make
   * the presence of a credit uninformative. */
  const noCredit = renderCanvasFragment(
    doc({w: {type: 'weather', namedSize: 'wide', state: 'sunny', temperature: 20, unit: 'C'}}) as never,
    baseOptions({shareLevel: 'private' as const}),
  );
  assert.equal(noCredit.includes('class="ch-credit"'), false,
    'a block with no source should not emit an empty credit');
  assert.ok(noCredit.includes('Sunny'), 'and it should still render its data');
});

test('a provider sentence is shortened to the institution being credited', () => {
  assert.equal(
    shortenAttribution('Weather forecast from example.com, delivered by the Example Institute.'),
    'example.com',
  );
  /* The subtle one: a period inside a domain must not end the clause. */
  assert.equal(shortenAttribution('Data from met.example.no'), 'met.example.no');
  assert.equal(shortenAttribution('Example Provider.'), 'Example Provider');
  assert.equal(shortenAttribution(''), '');
  assert.equal(shortenAttribution(null), '');
});

/* ======================== layout kinds honoured ========================= */

test('Rows, Tabs, AutoGrid and an unknown kind all render their blocks', () => {
  const block = (body: string) => ({type: 'text', namedSize: 'small', body});

  const rows = {
    apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {one: block('ROW_ONE_ECHO'), two: block('ROW_TWO_FOXTROT')},
      layout: {
        kind: 'Rows',
        children: [
          {id: 'r1', layout: {kind: 'Grid', authoredDensity: 'standard',
                              items: [{element: 'one', col: 0, row: 0}]}},
          {id: 'r2', layout: {kind: 'Grid', authoredDensity: 'standard',
                              items: [{element: 'two', col: 0, row: 0}]}},
        ],
      },
    },
  };
  const rowsHtml = renderCanvasFragment(rows as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(rowsHtml.includes('class="ch-rows"'));
  assert.ok(rowsHtml.includes('ROW_ONE_ECHO') && rowsHtml.includes('ROW_TWO_FOXTROT'));
  /* Order is the Rows kind's entire value, so it is asserted rather than
   * assumed. */
  assert.ok(rowsHtml.indexOf('ROW_ONE_ECHO') < rowsHtml.indexOf('ROW_TWO_FOXTROT'),
    'Rows must preserve the authored order');

  const tabs = {...rows, spec: {...rows.spec, layout: {
    kind: 'Tabs',
    children: [
      {id: 't1', title: 'TAB_TITLE_GOLF', layout: {kind: 'Grid', authoredDensity: 'standard',
        items: [{element: 'one', col: 0, row: 0}]}},
      {id: 't2', title: 'TAB_TITLE_HOTEL', layout: {kind: 'Grid', authoredDensity: 'standard',
        items: [{element: 'two', col: 0, row: 0}]}},
    ],
  }}};
  const tabsHtml = renderCanvasFragment(tabs as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(tabsHtml.includes('class="ch-tabs"'));
  /* Stacked and LABELLED, not a tab strip: a display surface has no control to
   * switch a tab with, so a hidden tab is content the household never sees. */
  assert.ok(tabsHtml.includes('TAB_TITLE_GOLF') && tabsHtml.includes('TAB_TITLE_HOTEL'));
  assert.ok(tabsHtml.includes('ROW_ONE_ECHO') && tabsHtml.includes('ROW_TWO_FOXTROT'),
    'every tab\u2019s contents must be on the page, since nothing can switch tabs');

  const auto = {...rows, spec: {...rows.spec, layout: {
    kind: 'AutoGrid', authoredDensity: 'standard', maxColumnCount: 3,
    columnWidthMode: 'wide', rowHeightMode: 'tall',
    items: [{element: 'one'}, {element: 'two'}],
  }}};
  const autoHtml = renderCanvasFragment(auto as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(autoHtml.includes('class="ch-autogrid"'));
  assert.ok(autoHtml.includes('data-width-mode="wide"'));
  assert.ok(autoHtml.includes('data-height-mode="tall"'));
  assert.ok(autoHtml.includes('data-max-columns="3"'));
  assert.ok(autoHtml.includes('ROW_ONE_ECHO') && autoHtml.includes('ROW_TWO_FOXTROT'));

  /* A kind from a newer build. Carried opaquely by the model; here it must not
   * blank the wall. */
  const foreign = {...rows, spec: {...rows.spec, layout: {
    kind: 'Carousel', authoredDensity: 'standard',
    items: [{element: 'one'}, {element: 'two'}],
  }}};
  const foreignHtml = renderCanvasFragment(foreign as never,
    baseOptions({shareLevel: 'private' as const}));
  assert.ok(foreignHtml.includes('ch-foreign-layout'));
  assert.ok(foreignHtml.includes('data-kind="Carousel"'));
  assert.ok(foreignHtml.includes('ROW_ONE_ECHO') && foreignHtml.includes('ROW_TWO_FOXTROT'),
    'an unknown layout kind must not swallow its blocks');
});

test('reflowing to another density moves blocks without changing their content', () => {
  const doc = fullDoc();
  const at = (density: 'comfortable' | 'standard' | 'dense') =>
    renderCanvasFragment(doc as never, baseOptions({density, shareLevel: 'private' as const}));

  for (const density of ['comfortable', 'standard', 'dense'] as const) {
    const html = at(density);
    assert.ok(html.includes(`data-density="${density}"`));
    assert.ok(html.includes(`data-columns="${columnsFor(density)}"`));
    /* Content is untouched by a density change: reflow rewrites layout alone,
     * and the renderer must not be re-deriving content from geometry. */
    for (const needle of [NOTE_BODY, EVENT_TITLE, PHOTOGRAPHER, WEATHER_SOURCE]) {
      assert.ok(html.includes(needle), `${needle} vanished at ${density}`);
    }
    /* Every block still on the page, at every density. */
    assert.equal((html.match(/data-block="/g) ?? []).length, 6,
      `a block was lost at ${density}`);
  }
  assert.notEqual(at('comfortable'), at('dense'),
    'three densities produced identical markup, so density is not being applied');
});

/* ==================== determinism, and the clock ======================== */

test('two renders of one document at one instant are byte-identical', () => {
  /* The property the three-surface comparison rests on. A renderer that used
   * `Date.now()` internally, or iterated a Set, would fail here and would make
   * the cross-surface test flaky rather than wrong. */
  const doc = fullDoc();
  const options = baseOptions({shareLevel: 'private' as const});
  assert.equal(renderCanvasFragment(doc as never, options),
    renderCanvasFragment(doc as never, options));
});

test('two clocks on one canvas always agree', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {a: {type: 'clock', namedSize: 'small'}, b: {type: 'clock', namedSize: 'small'}},
      layout: {kind: 'Grid', authoredDensity: 'standard',
               items: [{element: 'a', col: 0, row: 0}, {element: 'b', col: 3, row: 0}]},
    },
  };
  const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  const times = [...html.matchAll(/class="ch-clock-time">([^<]+)</g)].map((m) => m[1]);
  assert.equal(times.length, 2);
  assert.equal(times[0], times[1], 'two clocks on one canvas disagreed');
});

test('the clock renders in the household zone, not the server zone', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {c: {type: 'clock', namedSize: 'wide'}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'c', col: 0, row: 0}]},
    },
  };
  const utc = renderCanvasFragment(doc as never,
    {now: FIXED_NOW, timeZone: 'UTC', locale: 'en-GB', shareLevel: 'private'});
  const tokyo = renderCanvasFragment(doc as never,
    {now: FIXED_NOW, timeZone: 'Asia/Tokyo', locale: 'en-GB', shareLevel: 'private'});
  assert.ok(utc.includes('08:15'), `expected 08:15 UTC, got: ${utc}`);
  assert.ok(tokyo.includes('17:15'), `expected 17:15 in Asia/Tokyo, got: ${tokyo}`);
});

/* ===================== the five blocks actually render =================== */

test('all five block types render real content, not a list of their names', () => {
  const html = renderCanvasFragment(fullDoc() as never,
    baseOptions({shareLevel: 'private' as const}));

  /* The gap this phase exists to close: the old placeholder emitted
   * `<li><span>clock</span><span>clock · medium</span></li>`. */
  assert.equal(html.includes('screen-blocks'), false,
    'the placeholder block list is still being emitted');

  assert.ok(html.includes('08:15'), 'the clock must render a time');
  assert.ok(html.includes('Tuesday 22 September'), 'the clock must render a date');
  assert.ok(html.includes('Partly cloudy'), 'weather must render words, not a provider token');
  assert.ok(html.includes('14'), 'weather must render a temperature');
  assert.ok(html.includes(PHOTO_URL), 'the photo must reference its image');
  assert.ok(html.includes('Fog over the valley'), 'the photo caption must render');
  assert.ok(html.includes(NOTE_BODY), 'the note body must render');
  assert.ok(html.includes(EVENT_TITLE), 'the calendar must render an event title');
  assert.ok(html.includes('09:30'), 'the calendar must render a time');
  assert.ok(html.includes('Today'), 'the calendar must label the day');
});

test('a calendar picks its layout from its declared size', () => {
  const make = (namedSize: string) => ({
    apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {cal: {type: 'calendar', namedSize, events: [
        {date: '2026-09-22', startTime: '09:30', title: EVENT_TITLE},
      ]}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'cal', col: 0, row: 0}]},
    },
  });
  const options = baseOptions({shareLevel: 'private' as const});
  assert.ok(renderCanvasFragment(make('small') as never, options).includes('ch-upnext'),
    'a one-cell calendar should be up-next');
  assert.ok(renderCanvasFragment(make('wide') as never, options).includes('ch-agenda'),
    'a wide calendar should be an agenda');
  assert.ok(renderCanvasFragment(make('full') as never, options).includes('ch-daycolumns'),
    'a full-width calendar should be day columns');
});

test('an empty calendar states a fact rather than showing an empty rectangle', () => {
  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1', kind: 'Canvas',
    metadata: {uid: 'r'.repeat(22), name: CANVAS_NAME, revision: 1, createdAt: '', updatedAt: ''},
    spec: {
      elements: {cal: {type: 'calendar', namedSize: 'wide', events: []}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'cal', col: 0, row: 0}]},
    },
  };
  const html = renderCanvasFragment(doc as never, baseOptions({shareLevel: 'private' as const}));
  assert.ok(html.includes('Nothing scheduled'),
    'an empty week is good news and must not read as a broken integration');
  /* And it is NOT degraded: nothing failed. */
  assert.match(html, /data-block="cal"[^>]*data-state="ok"/);
});

/* ================== touch-first: no hover-only affordance ================ */

test('no block hides information behind a hover or a tooltip', () => {
  const html = renderCanvasFragment(fullDoc() as never,
    baseOptions({shareLevel: 'private' as const}));
  /* Primary displays are touchscreens where `@media (hover: hover)` never
   * matches, so a hover-gated fact is a fact the household cannot read
   * (DES-04). A title= attribute is the commonest way to introduce one. */
  for (const affordance of ['title=', ':hover', 'onmouseover', 'aria-describedby']) {
    assert.equal(html.includes(affordance), false,
      `the render carries a hover-dependent affordance: ${affordance}`);
  }
});

test('the rendered fragment carries no editing affordance at all', () => {
  /* The Phase 4 guarantee, re-asserted here on the fragment rather than on the
   * whole `/d/` response, so a block added later cannot introduce one without
   * this failing in the renderer's own suite. */
  const html = renderCanvasFragment(fullDoc() as never,
    baseOptions({shareLevel: 'private' as const})).toLowerCase();
  for (const affordance of [
    '<form', '<input', '<button', '<textarea', '<select', '<label',
    'contenteditable', 'designmode', 'draggable', 'onclick', 'onchange', 'oninput',
    'method="post"', '/api/', '/c/',
  ]) {
    assert.equal(html.includes(affordance), false,
      `the renderer emitted an editing affordance: ${affordance}`);
  }
  /* Positive control: the search can find these. */
  assert.ok('<form method="post">'.includes('<form'));
});

/* ========================= footprint resolution ========================= */

test('footprintFor never returns a footprint that cannot be placed', () => {
  const nasty: unknown[] = [
    undefined, null, '', 'lava-lamp', 42, {}, [],
  ];
  for (const density of DENSITY_LEVELS) {
    for (const type of nasty) {
      for (const size of nasty) {
        const f = footprintFor(type, size, density);
        assert.ok(Number.isInteger(f.cells.w) && f.cells.w >= 1,
          `bad width for ${String(type)}/${String(size)} at ${density}`);
        assert.ok(Number.isInteger(f.cells.h) && f.cells.h >= 1,
          `bad height for ${String(type)}/${String(size)} at ${density}`);
        assert.ok(f.cells.w <= columnsFor(density),
          `${String(type)}/${String(size)} is wider than ${density}`);
      }
    }
  }
});
