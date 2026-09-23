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
/* The block CATALOGUE: what a household may switch on, and what is
 * experimental.
 *
 * WHY THIS IS NOT IN src/render/registry.ts. The renderer's registry is the
 * set of things this build can DRAW, and it is a constant of the build - the
 * same five types on every household, validated at module load. This file is
 * the set of things a household has CHOSEN to see, which is per-installation
 * and lives next to the settings that decide it. Conflating them would make
 * one household's switch a property of the renderer, and the renderer is the
 * thing three surfaces share.
 *
 * HOW AN EXPERIMENTAL BLOCK RENDERS WITHOUT TOUCHING THE RENDERER.
 *
 * The precedent already exists and is deliberate: `quoteOfDay` is not a block
 * type. It is a TEXT block the document marks, which the server fills in
 * immediately before the render (see `withServerBlocks` in
 * render-context.ts). The document states an intent and carries no words; the
 * renderer still receives a plain string and is still pure.
 *
 * Experimental blocks work exactly the same way. A `forecast` block is a
 * `text` block carrying `experimentalType: 'forecast'`, whose body the server
 * fills from the selected provider's outlook. That is the correct shape
 * rather than a workaround: it means an experiment cannot break the renderer
 * that three surfaces depend on, cannot introduce a footprint the reflow has
 * never validated, and disappears cleanly when it is switched off - and it is
 * what lets `src/render/**` be untouched by this entire phase, which is the
 * seam this phase is meant to prove.
 *
 * THE MARKER IS NOT DECORATION. An enabled experiment renders a visible
 * "Experimental" label, so nobody stands in a hallway six months from now
 * wondering why one panel looks odd and behaves differently from the rest.
 */

import {BLOCK_TYPES} from '../render/registry.ts';

/** How an experimental block reaches the screen: which built-in renderer
 * draws it, and where its content comes from. */
export type ExperimentalKind = 'forecast';

export type BlockDescriptor = {
  readonly type: string;
  readonly label: string;
  /** One line, shown inline on the settings page - never in a tooltip, since
   * a tablet user cannot hover to reveal one (DES-04). */
  readonly description: string;
  readonly experimental: boolean;
  /** For an experimental block: the built-in type that actually draws it. */
  readonly rendersAs?: string;
  readonly experimentalKind?: ExperimentalKind;
  /** Said plainly on the settings page, because "experimental" means
   * different things in different products. */
  readonly caveat?: string;
};

/* The five built-ins, in the order the settings page lists them: the ones a
 * household recognises first. */
const BUILT_IN: readonly BlockDescriptor[] = [
  {
    type: 'clock',
    label: 'Clock',
    description: 'The time and the date, at a glance.',
    experimental: false,
  },
  {
    type: 'weather',
    label: 'Weather',
    description: 'The current temperature and conditions, with the source named beneath it.',
    experimental: false,
  },
  {
    type: 'calendar',
    label: 'Calendar',
    description: 'What is coming up, from the calendars you have subscribed to.',
    experimental: false,
  },
  {
    type: 'photo',
    label: 'Photograph',
    description: 'A full-bleed photograph, credited to whoever took it.',
    experimental: false,
  },
  {
    type: 'text',
    label: 'Note',
    description: 'A note you type, or the quote of the day.',
    experimental: false,
  },
];

/** The marker a document uses to declare a block experimental. Named once so
 * the settings page, the filter and the renderer's filler cannot disagree. */
export const EXPERIMENTAL_FIELD = 'experimentalType';

/** What an enabled experiment says on screen. */
export const EXPERIMENTAL_MARKER = 'Experimental';

const EXPERIMENTAL: readonly BlockDescriptor[] = [
  {
    type: 'forecast',
    label: 'Outlook',
    description: 'The next few days, from whichever weather provider you have chosen.',
    experimental: true,
    /* Drawn by the text renderer, filled by the server. No new footprint, no
     * new renderer, no change to src/render/**. */
    rendersAs: 'text',
    experimentalKind: 'forecast',
    caveat:
      'Not every provider can supply an outlook — Home Assistant reads a single '
      + 'sensor, so this Block will say so rather than guess. The layout is likely '
      + 'to change and this Block may be replaced in a later version.',
  },
];

export const BLOCK_DESCRIPTORS: readonly BlockDescriptor[] = [...BUILT_IN, ...EXPERIMENTAL];

export const ALL_BLOCK_TYPES: readonly string[] = BLOCK_DESCRIPTORS.map((d) => d.type);

export const EXPERIMENTAL_BLOCK_TYPES: readonly string[] =
  EXPERIMENTAL.map((d) => d.type);

/* Every built-in the renderer knows must have a descriptor here, or a
 * household could not switch it off and the settings page would silently omit
 * it. Checked at module load, in the same spirit as the registry's own
 * validation: a mismatch is a build error in a test, not a missing row on a
 * page somebody notices months later. */
for (const type of BLOCK_TYPES) {
  if (!ALL_BLOCK_TYPES.includes(type)) {
    throw new Error(`the block catalogue is missing the built-in type "${type}"`);
  }
}

export function blockDescriptor(type: unknown): BlockDescriptor | null {
  if (typeof type !== 'string') return null;
  return BLOCK_DESCRIPTORS.find((d) => d.type === type) ?? null;
}

export function isKnownBlockType(value: unknown): value is string {
  return blockDescriptor(value) !== null;
}

/** The block type a settings switch governs for a given block.
 *
 * An experimental block's `type` in the document is the BUILT-IN it renders
 * as, so the renderer can draw it; its experimental identity is the marker
 * field. This function is what makes a switch labelled "Outlook" actually
 * govern those blocks rather than every note on the canvas. */
export function governingType(block: {readonly [key: string]: unknown}): string {
  const marker = block[EXPERIMENTAL_FIELD];
  if (typeof marker === 'string' && isKnownBlockType(marker)) return marker;
  return typeof block.type === 'string' ? block.type : '';
}
