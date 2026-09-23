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
/* THE DEFAULT CANVAS: the ambient screen, as a document.
 *
 * This is the artefact that lets the television stop pointing at
 * `spikes/ambient.html`. Everything the spike drew by hand - a full-bleed
 * photograph, the time, the temperature with its source, the day's quote, the
 * photographer's credit - is reproduced here through the FIVE BUILT-IN BLOCKS
 * and nothing else. If it needed a sixth block type or one line of bespoke
 * CSS, the claim "the product renderer matches the spike" would be false.
 *
 * LAYERING, AND WHY THE COORDINATES OVERLAP ON PURPOSE.
 *
 * The photo occupies the whole grid (12x7 at Standard) and the clock, weather
 * and calendar are placed INSIDE those same cells. CSS grid stacks items that
 * share cells in document order, so the photograph paints first and the
 * information sits on top of it - which is the entire visual idea of an
 * ambient screen, and is why the element order in `elements` is not
 * arbitrary. Reflow restores an authored layout exactly at its authored
 * density, so these positions survive; at another density reflow will
 * un-overlap them into a legible stacked arrangement rather than a pile,
 * which is the right behaviour on a phone.
 *
 * NO SECOND CLOCK. The display shell draws no time of its own, so this
 * document carries exactly one clock block. Two clocks on one wall that
 * disagree by a second is the oldest dashboard bug there is, and the renderer
 * gives every block the same `now` precisely so it cannot happen - but only if
 * there is one of them.
 *
 * THE DOCUMENT NAMES NO CREDENTIAL AND NO HOUSEHOLD. There is no URL, no
 * entity id, no coordinate and no name in it. Blocks name the opaque source id
 * `default`, which the server resolves out of its own configuration, so this
 * exact document is portable to any household and is safe to publish.
 */

import {API_VERSION, KIND, type CanvasDocument} from '../canvas/types.ts';

/** Marks the text block whose body the server fills with the day's quote.
 * The document states the INTENT ("the quote of the day goes here") and never
 * the words, so a canvas saved in June does not show June's quote in
 * December. See `withServerBlocks` in render-context.ts. */
export const QUOTE_OF_DAY = 'quoteOfDay';

export const DEFAULT_CANVAS_NAME = 'Ambient';

/* Returned freshly built on every call rather than exported as a frozen
 * constant, because the store stamps ids and timestamps into whatever it is
 * handed and a shared mutable literal would accumulate one household's
 * metadata and then hand it to the next caller. */
export function defaultCanvasDocument(): CanvasDocument {
  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: {
      /* Replaced by the store on create. Present because a document is only
       * valid with one, and this function's output must validate on its own. */
      uid: 'default-canvas-placeholder',
      name: DEFAULT_CANVAS_NAME,
    },
    spec: {
      /* ORDER IS PAINT ORDER. The photograph is first so everything else sits
       * on top of it. */
      elements: {
        photo: {
          type: 'photo',
          namedSize: 'full',
          /* No url: the photograph comes from the server's photo feed under
           * the opaque id `default`. A household with no photo provider
           * configured gets one dimmed block saying so and a complete screen
           * otherwise, which is the per-block degradation rule. */
          source: 'default',
        },
        clock: {
          type: 'clock',
          namedSize: 'wide',
        },
        weather: {
          type: 'weather',
          namedSize: 'small',
          source: 'default',
          /* The block's own fallback label. `renderWeather` prefers the
           * reading's own place when the provider supplies one; this is what a
           * household sees until then, and it names no location. */
          place: 'Outside',
        },
        agenda: {
          type: 'calendar',
          namedSize: 'small',
          source: 'default',
          layout: 'upNext',
          title: 'Next',
        },
        quote: {
          type: 'text',
          namedSize: 'full',
          /* The marker, not the words. */
          [QUOTE_OF_DAY]: true,
        },
      },
      layout: {
        kind: 'Grid',
        authoredDensity: 'standard',
        items: [
          /* The screen. 12x7, from the top-left cell. */
          {element: 'photo', col: 0, row: 0},
          /* Time, top-left, over the photograph. 6x3. */
          {element: 'clock', col: 0, row: 0},
          /* Temperature, top-right, with its source rendered directly beneath
           * it by the block itself. 3x2. */
          {element: 'weather', col: 9, row: 0},
          /* What is next, right-hand side, clear of the weather. 3x3. */
          {element: 'agenda', col: 9, row: 3},
          /* The quote band, full width, BELOW the photograph rather than over
           * it: the photo block already darkens its own bottom edge for the
           * photographer's credit, and stacking a second band of text there
           * would put two pieces of small type in the same 60 pixels. 12x4. */
          {element: 'quote', col: 0, row: 7},
        ],
      },
    },
  };
}
