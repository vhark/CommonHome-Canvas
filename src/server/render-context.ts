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
/* The seam between the server's configuration and the pure renderer.
 *
 * The renderer knows nothing about config, env vars, tokens or fetching. This
 * one small module turns a CanvasConfig into the options the renderer takes, so
 * `/d/`, `/s/` and `/c/` cannot pick different locales or time zones by accident
 * - the surface chooses only its SHARE LEVEL, and everything else is the
 * household's single setting.
 *
 * THE SHARE LEVEL IS THE ONLY DIFFERENCE BETWEEN THE SURFACES, and it is chosen
 * by the ROUTE, never read from a request or a document: a viewer arriving over
 * a share link must not be able to ask for the private shaping. See
 * `handleCalendarRequest` in calendar-route.ts, which decides the same thing the
 * same way for the JSON path.
 *
 * THIS IS ALSO WHERE LIVE DATA ENTERS, AND IT ENTERS ALREADY FETCHED.
 * `feeds.dataFor(level)` is a synchronous read of whatever the FeedCache's
 * timers last produced. Nothing on this path awaits a network call, which is
 * what keeps `renderCanvasFragment` pure and what stops six screens polling
 * `/view` from becoming six provider requests a minute. If this function ever
 * needs to become async, that property has been lost - treat it as a
 * regression, not a refactor.
 *
 * The share level is not merely passed down: the FeedCache holds calendars
 * SHAPED TWICE, and `dataFor('shared')` returns the set that was shaped shared
 * at the source. The renderer is handed data that never contained the private
 * fields, rather than data it is trusted to omit.
 */

import type {ShareLevel} from '../calendar/shape.ts';
import type {Block, CanvasDocument} from '../canvas/types.ts';
import type {RenderOptions} from '../render/index.ts';
import {DEFAULT_LOCALE, DEFAULT_TIME_ZONE} from '../render/index.ts';
import {EXPERIMENTAL_FIELD, EXPERIMENTAL_MARKER, governingType} from './blocks.ts';
import type {CanvasConfig} from './config.ts';
import {QUOTE_OF_DAY} from './default-canvas.ts';
import type {FeedCache} from './feeds.ts';
import {blockEnabled, DEFAULT_SETTINGS, type Settings} from './settings.ts';
import {quoteBody, quoteOfDay} from '../quotes/index.ts';

/** Everything a route needs to render. Optional feeds so every existing caller
 * and every test that builds a server without integrations keeps working and
 * simply renders with no live data - which is the same path a household with
 * nothing configured takes. */
export type RenderContext = {
  readonly config: CanvasConfig;
  readonly feeds?: FeedCache;
  /* Optional for the same reason, and defaulted to DEFAULT_SETTINGS rather
   * than to "everything off": a caller that does not know about settings gets
   * the product's defaults, which is every built-in on and no experiments. */
  readonly settings?: {readonly current: Settings};
  /* The experimental outlook's text, already fetched. Synchronous like every
   * other datum on this path: the refresh loop produced it, and a render
   * cannot await. */
  readonly experimentalText?: {readonly [kind: string]: string};
};

export function renderOptionsFor(
  config: CanvasConfig,
  shareLevel: ShareLevel,
  now: Date = new Date(),
  feeds?: FeedCache,
): RenderOptions {
  return {
    now,
    /* A null zone means the household never set one. UTC rather than the
     * server's own zone: a container's zone is an accident of its image, and a
     * clock that is silently wrong by an hour is worse than one that is
     * obviously in UTC. */
    timeZone: config.timeZone ?? DEFAULT_TIME_ZONE,
    locale: config.locale === '' ? DEFAULT_LOCALE : config.locale,
    shareLevel,
    /* ALREADY FETCHED. One refresh loop per source produced this; a render
     * never causes a request. An unconfigured server passes `{}` and every
     * block falls back to whatever the document itself carries, which is why a
     * household with no integrations still gets a canvas. */
    data: feeds === undefined ? {} : feeds.dataFor(shareLevel),
  };
}

/* ------------------------------------------------------- server-side blocks -- */

/* THE QUOTE BLOCK, AND THE ONE HONEST THING TO SAY ABOUT IT.
 *
 * There is no `quote` entry in BLOCK_TYPES, and adding one would mean editing
 * `src/render/`, which this phase exists to prove is unnecessary. So the quote
 * is a TEXT block that the document marks with `quoteOfDay: true` and the
 * server fills in here, immediately before the render.
 *
 * That split is the correct one rather than a workaround. The document states
 * an intent - "the quote of the day belongs here" - and carries no words, so a
 * canvas saved in June does not show June's quote in December, and the same
 * document is portable to a household with a different quote library. The
 * renderer still receives a plain string and is still pure; the date-to-quote
 * decision lives on the server side of the seam with every other resolution.
 *
 * Deterministic from the CIVIL date in the render's zone, so every screen in
 * the house shows the same quote all day and changes it at the household's
 * midnight rather than UTC's.
 *
 * Returns the document UNCHANGED, by identity, when there is nothing to fill -
 * which is every canvas that does not use the marker, so the common path
 * allocates nothing. */
export function withServerBlocks<T extends CanvasDocument>(
  doc: T,
  options: {readonly now?: Date; readonly timeZone?: string} = {},
): T {
  const elements = doc.spec?.elements;
  if (elements === undefined || elements === null) return doc;

  const names = Object.keys(elements).filter((name) => {
    const block = elements[name] as Block | undefined;
    return block !== undefined && block[QUOTE_OF_DAY] === true && block.type === 'text';
  });
  if (names.length === 0) return doc;

  const now = options.now ?? new Date();
  const zone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const quote = quoteOfDay(now, zone);
  const body = quoteBody(quote);

  const next: {[name: string]: Block} = {...elements};
  for (const name of names) {
    /* Rebuilt rather than mutated: the caller's document is a stored value
     * another request may be holding, and a render must not write into it. */
    next[name] = {
      ...(elements[name] as Block),
      /* `body` is what renderText reads, and it escapes it. A quote's text and
       * its author are library data, not markup, and they are not trusted here
       * any more than anywhere else. */
      body,
      /* Said plainly rather than left blank: a household with an empty quote
       * library should see why the band is dim, not an empty rectangle. */
      ...(body === '' ? {title: 'No quote available'} : {}),
    };
  }
  return {...doc, spec: {...doc.spec, elements: next}} as T;
}

/* ------------------------------------------------ disabled and experimental -- */

/* A DISABLED BLOCK TYPE DOES NOT RENDER, AND IT IS REMOVED RATHER THAN
 * HIDDEN.
 *
 * Hiding it with CSS would leave its content in the HTML, which on a shared
 * surface means a household that switched calendars off has still published
 * its calendar to anyone who views source. So the element is dropped from the
 * table AND from the layout before the renderer ever sees it - and the
 * renderer is untouched, which is the point.
 *
 * The layout item is removed too, not just the element. A layout referencing
 * a missing element renders a "Missing block" placeholder by design (it is
 * how a dangling reference stays visible to an author), and a switched-off
 * block type should leave a gap, not a labelled complaint.
 */
export function withEnabledBlocks<T extends CanvasDocument>(doc: T, settings: Settings): T {
  const elements = doc.spec?.elements;
  if (elements === undefined || elements === null) return doc;

  const dropped = Object.keys(elements).filter((name) => {
    const block = elements[name] as Block | undefined;
    if (block === undefined) return false;
    return !blockEnabled(settings, governingType(block as {[key: string]: unknown}));
  });
  /* Identity return on the common path: every block enabled is what almost
   * every household has, and it must allocate nothing. */
  if (dropped.length === 0) return doc;

  const next: {[name: string]: Block} = {};
  for (const [name, block] of Object.entries(elements)) {
    if (!dropped.includes(name)) next[name] = block as Block;
  }

  const layout = doc.spec?.layout as {items?: unknown} | undefined;
  const nextLayout = Array.isArray(layout?.items)
    ? {
        ...layout,
        items: layout.items.filter((item) => {
          const name = (item as {element?: unknown})?.element;
          return typeof name !== 'string' || !dropped.includes(name);
        }),
      }
    : layout;

  return {
    ...doc,
    spec: {...doc.spec, elements: next, ...(nextLayout === undefined ? {} : {layout: nextLayout})},
  } as T;
}

/* AN ENABLED EXPERIMENT SAYS SO ON THE SCREEN.
 *
 * Nobody should stand in a hallway six months from now wondering why one
 * panel looks odd. The marker is the block's TITLE, prefixed - rendered as a
 * plain label by the text renderer, visible without hovering (DES-04) and
 * without a single byte of new CSS or a change to src/render/**.
 *
 * NO SETTINGS ARGUMENT, deliberately: `withEnabledBlocks` has already removed
 * every experiment that is not switched on, so anything reaching here is
 * enabled and the marker is unconditional. Re-checking would be a second
 * place for the two gates to disagree.
 *
 * The body is filled from whatever the refresh loop produced for that
 * experiment's kind. An experiment with no data yet says so rather than
 * rendering an empty band, which is the same per-block degradation rule
 * everything else follows. */
export function withExperimentalBlocks<T extends CanvasDocument>(
  doc: T,
  text: {readonly [kind: string]: string} = {},
): T {
  const elements = doc.spec?.elements;
  if (elements === undefined || elements === null) return doc;

  const names = Object.keys(elements).filter((name) => {
    const block = elements[name] as Block | undefined;
    return typeof block?.[EXPERIMENTAL_FIELD] === 'string';
  });
  if (names.length === 0) return doc;

  const next: {[name: string]: Block} = {...elements};
  for (const name of names) {
    const block = elements[name] as Block;
    const body = text[String(block[EXPERIMENTAL_FIELD])] ?? '';
    next[name] = {
      ...block,
      title: typeof block.title === 'string' && block.title !== ''
        ? `${block.title} · ${EXPERIMENTAL_MARKER}`
        : EXPERIMENTAL_MARKER,
      body: body === '' ? 'This experiment has no data yet.' : body,
    };
  }
  return {...doc, spec: {...doc.spec, elements: next}} as T;
}

/** The pair, for a route that wants both in one line: the document with its
 * server-side blocks filled and the options to render it with, agreeing on a
 * single `now`. Two calls with two `new Date()`s would let a canvas render a
 * quote from one day and a date from the next, once a year, at midnight. */
export function prepareRender<T extends CanvasDocument>(
  doc: T,
  ctx: RenderContext,
  shareLevel: ShareLevel,
  now: Date = new Date(),
): {readonly doc: T; readonly options: RenderOptions} {
  const options = renderOptionsFor(ctx.config, shareLevel, now, ctx.feeds);
  const settings = ctx.settings?.current ?? DEFAULT_SETTINGS;
  /* ORDER MATTERS, and this is the order:
   *   1. drop what the household switched off - so nothing downstream can
   *      fill in content for a block that should not exist;
   *   2. mark and fill the experiments that survived;
   *   3. fill the quote, which is neither.
   * Filling before dropping would compute a quote and an outlook for blocks
   * about to be deleted, which is wasted work at best and, for the outlook,
   * a provider request for a block nobody asked for. */
  const enabled = withEnabledBlocks(doc, settings);
  const marked = withExperimentalBlocks(
    enabled,
    /* From the cache when the caller did not supply one: the refresh loop is
     * where experimental data comes from, and a route should not have to
     * remember to plumb it through. Synchronous read, like `dataFor`. */
    ctx.experimentalText ?? ctx.feeds?.experimentalText,
  );
  return {
    doc: withServerBlocks(marked, {now, timeZone: options.timeZone}),
    options,
  };
}
