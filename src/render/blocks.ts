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
/* The five built-in Blocks, as HTML strings.
 *
 * FIVE RULES CARRY THIS FILE.
 *
 * 1. EVERY INTERPOLATION IS ESCAPED, through the one shared escaper. A canvas
 *    name, a note's body, a calendar title and a photographer's name are all
 *    user- or provider-controlled, and they land on a URL a wall display loads
 *    automatically with nobody watching. There is no "trusted" string here.
 *
 * 2. ATTRIBUTION IS PART OF THE CONTRACT. A photo block whose photo has a
 *    source and no rendered credit is incorrect output, not an unstyled one.
 *    The credit is emitted immediately beneath the thing it credits, so the
 *    relationship needs no explaining and no legend.
 *
 * 3. A SHARED CALENDAR EMITS NO DESCRIPTION, LOCATION OR ATTENDEE. shape.ts
 *    already guarantees this by construction upstream; it is re-enforced here
 *    because this is the layer at which bytes become visible to a visitor in
 *    the hallway, and a second enforcement point where the output lives is
 *    worth having. The private path DOES emit them, which is what stops the
 *    absence assertion from being vacuous.
 *
 * 4. A BLOCK DEGRADES ALONE. Every renderer is wrapped so that a missing feed,
 *    an unparseable field or a thrown error produces one dimmed block carrying
 *    a short reason. There is no code path here that can fail a page.
 *
 * 5. NOTHING IS INTERACTIVE AND NOTHING IS HOVER-ONLY. These blocks are
 *    display-only: no form, no button, no title= tooltip carrying information
 *    that is not also on the screen. Primary displays are touchscreens where
 *    `@media (hover: hover)` never matches, so a hover-revealed fact is a fact
 *    the household cannot read (DES-04).
 */

import {agenda, dayColumns, upNext, type LayoutOptions} from '../calendar/blocks.ts';
import {bandFor, NEVER_SHARED_KEYS, type ShapedEvent, type ShareLevel} from '../calendar/shape.ts';
import type {Block} from '../canvas/types.ts';
import {
  attributionFrom,
  conditionText,
  creditText,
  feedFor,
  type Attribution,
  type CalendarFeed,
  type Feed,
  type PhotoImage,
  type RenderData,
  type WeatherReading,
} from './data.ts';
import {escapeHtml, safeImageUrl} from './escape.ts';
import {isBuiltInBlockType} from './registry.ts';

/** Everything a block needs that is not in the block itself. */
export type BlockContext = {
  /** The instant the whole page is rendered at. One value for the entire
   * render, so two clocks on one canvas can never disagree by a second. */
  readonly now: Date;
  readonly timeZone: string;
  readonly locale: string;
  /* The level THIS SURFACE is entitled to, decided by the route and never read
   * from the document or the request. `/s/` passes 'shared'; an owner's own
   * preview passes 'private'. The effective level is the STRICTER of this and
   * the feed's own, so a private source reached through a share link is
   * rendered as shared and a shared source reached by an owner stays shared -
   * which is the safe direction to be wrong in. */
  readonly shareLevel: ShareLevel;
  readonly data: RenderData;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* ------------------------------------------------------------ attribution -- */

/* Rendered as a <p>, never as a title= attribute or a hover reveal. A credit
 * that only appears on hover is a credit a television never shows. */
function creditHtml(credit: Attribution | null, of: string): string {
  const text = creditText(credit);
  if (text === '') return '';
  return `<p class="ch-credit" data-credit-of="${escapeHtml(of)}">${escapeHtml(text)}</p>`;
}

/* ------------------------------------------------------------------ clock -- */

/* Server-rendered, at minute resolution, from the page's single `now`.
 *
 * Minute resolution rather than seconds is a deliberate product choice, not a
 * limitation: a ticking seconds display on an ambient screen is the loudest
 * thing in the room, and it would also make every render of the same document
 * differ, which is exactly the property the single-renderer guarantee is
 * asserted on. */
function renderClock(block: Block, ctx: BlockContext): string {
  const time = new Intl.DateTimeFormat(ctx.locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ctx.timeZone,
  }).format(ctx.now);
  const date = new Intl.DateTimeFormat(ctx.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: ctx.timeZone,
  }).format(ctx.now);
  const label = str(block.label);
  return [
    label === '' ? '' : `<p class="ch-block-label">${escapeHtml(label)}</p>`,
    `<p class="ch-clock-time">${escapeHtml(time)}</p>`,
    `<p class="ch-clock-date">${escapeHtml(date)}</p>`,
  ].filter((part) => part !== '').join('\n');
}

/* ---------------------------------------------------------------- weather -- */

/* An authored reading: the household typed a number into the document, or a
 * template shipped with one. This is what makes a canvas self-sufficient - a
 * document renders fully with no integration configured and no network, which is
 * also how the renderer is testable without either. A server feed, when there is
 * one, always wins. */
function inlineWeather(block: Block): WeatherReading | null {
  const state = str(block.state) !== '' ? str(block.state) : str(block.condition);
  const temperature = typeof block.temperature === 'number' && Number.isFinite(block.temperature)
    ? block.temperature
    : null;
  if (state === '' && temperature === null) return null;
  return {
    state,
    temperature,
    unit: str(block.unit),
    ...(str(block.place) === '' ? {} : {place: str(block.place)}),
    attribution: attributionFrom(block.credit ?? block.attribution ?? block.source_name),
  };
}

function renderWeather(block: Block, ctx: BlockContext): string {
  const feed = feedFor<WeatherReading>(ctx.data.weather, block.source);
  const inline = inlineWeather(block);
  if (feed === null && inline === null) return degradedBody('No weather source configured');
  if (feed !== null && !feed.ok && inline === null) return degradedBody(feed.reason);

  const reading = feed !== null && feed.ok ? feed.value : inline!;
  const credit = reading.attribution ?? null;
  const temperature = reading.temperature === null
    ? ''
    : `${Math.round(reading.temperature)}${reading.unit === '' ? '' : `\u00a0${reading.unit}`}`;
  const place = reading.place ?? str(block.place);
  const condition = conditionText(reading.state);

  return [
    place === '' ? '' : `<p class="ch-block-label">${escapeHtml(place)}</p>`,
    temperature === '' ? '' : `<p class="ch-weather-temp">${escapeHtml(temperature)}</p>`,
    condition === '' ? '' : `<p class="ch-weather-condition">${escapeHtml(condition)}</p>`,
    /* RULE 2. The source sits directly beneath the number it produced. */
    creditHtml(credit, 'weather'),
  ].filter((part) => part !== '').join('\n');
}

/* ------------------------------------------------------------------ photo -- */

/* Full-bleed: the image is a background on the block's own element rather than
 * an <img>, so it crops to the declared footprint at any aspect ratio without a
 * layout shift, and the caption band sits over it. A background-image is the
 * reason the CSP keeps `img-src https: data:` - the URL still goes through the
 * scheme allowlist before it is emitted.
 *
 * The photograph carries the colour, so the caption band is a non-uniform dark
 * scrim rather than a flat wash: it darkens the bottom edge, where photos tend
 * to render brightest and where the credit sits, and leaves the rest of the
 * image alone. */
function renderPhoto(block: Block, ctx: BlockContext): string {
  const feed = feedFor<PhotoImage>(ctx.data.photos, block.source);
  const inlineUrl = safeImageUrl(block.url);

  let photo: PhotoImage | null = null;
  if (feed !== null && feed.ok) {
    photo = feed.value;
  } else if (inlineUrl !== null) {
    /* An authored photo: a household pasted a URL into the block. Its credit
     * is authored too, and rule 2 applies to it identically. */
    photo = {
      url: str(block.url),
      alt: str(block.alt),
      caption: str(block.caption),
      color: typeof block.color === 'string' ? block.color : null,
      attribution: attributionFrom(block.credit ?? block.attribution),
    };
  }

  if (photo === null) {
    return degradedBody(feed !== null && !feed.ok ? feed.reason : 'No photograph available');
  }

  const url = safeImageUrl(photo.url);
  if (url === null) return degradedBody('Photograph address was refused');

  const caption = photo.caption ?? '';
  const credit = photo.attribution ?? null;
  /* An empty alt is CORRECT for a decorative ambient photograph: a screen
   * reader announcing a stock landscape on every poll is noise. When the
   * household authored a description, it is used. */
  const alt = photo.alt ?? '';

  return [
    `<div class="ch-photo-image" role="img" aria-label="${escapeHtml(alt)}"`
      + ` style="background-image:url(&quot;${url}&quot;)"></div>`,
    '<div class="ch-photo-band">',
    caption === '' ? '' : `<p class="ch-photo-caption">${escapeHtml(caption)}</p>`,
    /* RULE 2 again, and the licences of every photo provider we can use say
     * so explicitly: the photographer is named wherever the photo is used. */
    creditHtml(credit, 'photo'),
    '</div>',
  ].filter((part) => part !== '').join('\n');
}

/* ------------------------------------------------------------------- text -- */

/* A household note. The block that makes duplication useful: "same canvas,
 * different text" was the original fleet requirement, so this is the one block
 * whose entire content is a string somebody typed - which makes it the single
 * most important escape site in the product. */
function renderText(block: Block, _ctx: BlockContext): string {
  const title = str(block.title);
  const body = str(block.body) !== '' ? str(block.body) : str(block.text);
  if (title === '' && body === '') return degradedBody('This note is empty');
  /* Paragraph per blank-line-separated block, so a multi-line note reads as
   * one. Split on the ESCAPED text would be wrong; split first, escape each. */
  const paragraphs = body.split(/\n{2,}/).map((part) => part.trim()).filter((part) => part !== '');
  return [
    title === '' ? '' : `<p class="ch-block-label">${escapeHtml(title)}</p>`,
    ...paragraphs.map((part) =>
      `<p class="ch-text-body">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`),
  ].filter((part) => part !== '').join('\n');
}

/* --------------------------------------------------------------- calendar -- */

type CalendarLayoutName = 'agenda' | 'dayColumns' | 'upNext';

/* The layout follows the declared footprint unless the author overrode it: a
 * single small cell has room for "what is next" and nothing more, and a
 * full-width block has room for day columns. Deriving from the size means an
 * author who resizes a calendar gets the right layout without a second
 * setting to find. */
function calendarLayoutFor(block: Block): CalendarLayoutName {
  const explicit = str(block.layout);
  if (explicit === 'agenda' || explicit === 'dayColumns' || explicit === 'upNext') return explicit;
  switch (str(block.namedSize)) {
    case 'small': return 'upNext';
    case 'full': return 'dayColumns';
    default: return 'agenda';
  }
}

/* RULE 3, as code rather than as a comment.
 *
 * The effective level is the STRICTER of the surface's and the feed's. On a
 * shared render the private keys are not merely skipped at the emit sites below
 * - the events are REBUILT without them before any layout function sees them, so
 * a future field added to one of the three layouts cannot reintroduce the leak.
 * The key list is imported from shape.ts rather than copied, so the two cannot
 * drift apart. */
function effectiveLevel(feed: CalendarFeed, surface: ShareLevel): ShareLevel {
  return surface === 'shared' || feed.level === 'shared' ? 'shared' : 'private';
}

function forLevel(events: readonly ShapedEvent[], level: ShareLevel): readonly ShapedEvent[] {
  if (level !== 'shared') return events;
  return events.map((event) => {
    const copy: Record<string, unknown> = {...event};
    for (const key of NEVER_SHARED_KEYS) delete copy[key];
    return copy as unknown as ShapedEvent;
  });
}

function whenText(event: ShapedEvent): string {
  if (event.allDay) return 'All day';
  if (event.startTime === null) return '';
  return event.endTime === null ? event.startTime : `${event.startTime}\u2013${event.endTime}`;
}

/* Titles may be ABSENT on a shared shaping that withholds them; "Busy" is the
 * honest word for an event whose title is not ours to publish. */
function titleText(event: ShapedEvent): string {
  return event.title !== undefined && event.title !== '' ? event.title : 'Busy';
}

/* The private-only detail line. This function is the positive control the
 * share-safety test needs: if it ever emits nothing at all, the "no location on
 * a shared canvas" assertion becomes vacuous, so the test asserts that the
 * private rendering DOES contain these. */
function detailHtml(event: ShapedEvent, level: ShareLevel): string {
  if (level !== 'private') return '';
  const parts: string[] = [];
  if (typeof event.location === 'string' && event.location !== '') {
    parts.push(`<span class="ch-event-location">${escapeHtml(event.location)}</span>`);
  }
  if (Array.isArray(event.attendees) && event.attendees.length > 0) {
    parts.push(`<span class="ch-event-attendees">${escapeHtml(event.attendees.join(', '))}</span>`);
  }
  if (typeof event.description === 'string' && event.description !== '') {
    parts.push(`<span class="ch-event-description">${escapeHtml(event.description)}</span>`);
  }
  return parts.length === 0 ? '' : `<p class="ch-event-detail">${parts.join(' · ')}</p>`;
}

function eventHtml(event: ShapedEvent, level: ShareLevel): string {
  const when = whenText(event);
  const classes = ['ch-event', `ch-band-${event.band}`, event.tentative ? 'ch-tentative' : '']
    .filter((c) => c !== '').join(' ');
  return [
    `<li class="${classes}">`,
    when === '' ? '' : `<span class="ch-event-when">${escapeHtml(when)}</span>`,
    `<span class="ch-event-title">${escapeHtml(titleText(event))}</span>`,
    detailHtml(event, level),
    '</li>',
  ].filter((part) => part !== '').join('');
}

/* Authored events, held in the document itself.
 *
 * SHAPED, not raw: the block carries the same field set shape.ts produces, so
 * the level-stripping below applies to it identically and an authored event
 * cannot bypass the share rule by arriving through a different door. Every field
 * is coerced rather than trusted - this is JSON from a file a household may have
 * hand-edited. */
function inlineEvents(block: Block): {
  readonly dated: readonly ShapedEvent[];
  readonly undated: readonly ShapedEvent[];
} | null {
  const raw = block.events;
  if (!Array.isArray(raw)) return null;
  const dated: ShapedEvent[] = [];
  const undated: ShapedEvent[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const date = str(record.date);
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const startTime = /^\d{2}:\d{2}$/.test(str(record.startTime)) ? str(record.startTime) : null;
    const endTime = /^\d{2}:\d{2}$/.test(str(record.endTime)) ? str(record.endTime) : null;
    const allDay = startTime === null || record.allDay === true;
    const event: Record<string, unknown> = {
      id: str(record.id) !== '' ? str(record.id) : `authored-${index}`,
      date,
      startTime: allDay ? null : startTime,
      endTime: allDay ? null : endTime,
      allDay,
      band: bandFor(allDay ? null : startTime),
      tentative: record.tentative === true,
      busy: record.busy !== false,
    };
    if (str(record.title) !== '') event.title = str(record.title);
    /* Assigned only when present, exactly as shape.ts does, so a shared strip
     * removes a key rather than blanking a value. */
    if (str(record.location) !== '') event.location = str(record.location);
    if (str(record.description) !== '') event.description = str(record.description);
    if (Array.isArray(record.attendees)) {
      const names = record.attendees.filter((a): a is string => typeof a === 'string');
      if (names.length > 0) event.attendees = names;
    }
    /* An authored entry with no usable date cannot be placed on a day, and the
     * three layouts all group by day - but DROPPING it would be silent data
     * loss on a wall, which is the one outcome this codebase refuses. It is
     * rendered separately, undated, so the household can see what it typed and
     * see that it needs a date. */
    (hasDate ? dated : undated).push(event as unknown as ShapedEvent);
  }
  return {dated, undated};
}

function renderCalendar(block: Block, ctx: BlockContext): string {
  const feed = feedFor<CalendarFeed>(ctx.data.calendars, block.source);
  const authored = inlineEvents(block);

  let calendar: CalendarFeed;
  if (feed !== null && feed.ok) {
    calendar = feed.value;
  } else if (authored !== null) {
    calendar = {
      name: str(block.title) === '' ? null : str(block.title),
      events: authored.dated,
      /* An authored calendar's own level is private - it is the household's own
       * document. The SURFACE then decides what may actually be emitted, which
       * is the whole point of taking the stricter of the two. */
      level: 'private',
      attribution: attributionFrom(block.credit ?? block.attribution),
    };
  } else if (feed !== null && !feed.ok) {
    return degradedBody(feed.reason);
  } else {
    return degradedBody('No calendar source configured');
  }

  const level = effectiveLevel(calendar, ctx.shareLevel);
  const events = forLevel(calendar.events, level);
  const undated = forLevel(authored?.undated ?? [], level);
  const options: LayoutOptions = {
    now: ctx.now,
    displayZone: ctx.timeZone,
    locale: ctx.locale,
  };
  const name = calendar.name ?? str(block.title);
  const head = name === '' ? '' : `<p class="ch-block-label">${escapeHtml(name)}</p>`;
  const tail = creditHtml(calendar.attribution ?? null, 'calendar');
  const layout = calendarLayoutFor(block);

  let body = '';
  if (layout === 'upNext') {
    const model = upNext(events, {...options, count: 2});
    if (model.empty) {
      body = `<p class="ch-empty">${escapeHtml(model.emptyMessage)}</p>`;
    } else {
      const slots = [model.primary, model.secondary].filter((slot) => slot !== null);
      body = [
        '<ul class="ch-upnext">',
        ...slots.map((slot) =>
          `<li class="ch-event"><span class="ch-event-when">${escapeHtml(slot!.when)}</span>`
          + `<span class="ch-event-title">${escapeHtml(titleText(slot!))}</span>`
          + `${detailHtml(slot!, level)}</li>`),
        '</ul>',
      ].join('\n');
    }
  } else if (layout === 'dayColumns') {
    const model = dayColumns(events, {...options, days: 4});
    body = [
      '<div class="ch-daycolumns">',
      ...model.columns.map((column) => [
        `<section class="ch-daycolumn${column.emphasis ? ' ch-emphasis' : ''}`
          + `${column.isWeekend ? ' ch-weekend' : ''}" data-position="${column.position}">`,
        `<h3 class="ch-day-label">${escapeHtml(column.label)}</h3>`,
        column.events.length === 0
          ? '<p class="ch-empty">\u2014</p>'
          : `<ul class="ch-day-events">${column.events.map((e) => eventHtml(e, level)).join('')}</ul>`,
        '</section>',
      ].join('\n')),
      '</div>',
    ].join('\n');
  } else {
    /* agenda: the default, and the right one for a wall. */
    const model = agenda(events, {...options, limit: 8});
    if (model.empty) {
      body = `<p class="ch-empty">${escapeHtml(model.emptyMessage)}</p>`;
    } else {
      body = [
        '<div class="ch-agenda">',
        ...model.days.map((day) => [
          `<section class="ch-agenda-day${day.isToday ? ' ch-today' : ''}">`,
          `<h3 class="ch-day-label">${escapeHtml(day.label)}</h3>`,
          `<ul class="ch-day-events">${day.events.map((e) => eventHtml(e, level)).join('')}</ul>`,
          '</section>',
        ].join('\n')),
        model.overflow > 0
          ? `<p class="ch-overflow">+${model.overflow} more</p>`
          : '',
        '</div>',
      ].filter((part) => part !== '').join('\n');
    }
  }

  const undatedHtml = undated.length === 0 ? '' : [
    '<section class="ch-agenda-day ch-undated">',
    '<h3 class="ch-day-label">No date</h3>',
    `<ul class="ch-day-events">${undated.map((e) => eventHtml(e, level)).join('')}</ul>`,
    '</section>',
  ].join('\n');

  return [head, body, undatedHtml, tail].filter((part) => part !== '').join('\n');
}

/* --------------------------------------------------------------- degraded -- */

/* One dimmed block, with the reason stated in words. NOT an empty rectangle: an
 * empty rectangle on a wall is indistinguishable from a broken layout, and a
 * household cannot tell which of six blocks lost its data. The reason string is
 * display-safe by construction - see Feed in data.ts. */
export function degradedBody(reason: string): string {
  return `<p class="ch-degraded">${escapeHtml(reason)}</p>`;
}

/* ---------------------------------------------------------- unknown types -- */

/* A labelled placeholder, naming the type it could not draw. The document's
 * round-trip guarantee already keeps the block's own fields intact through a
 * save; this makes the guarantee VISIBLE, so a canvas authored by a newer build
 * shows "a thing this build does not know about" rather than blanking a wall. */
function renderUnknown(block: Block): string {
  const type = str(block.type);
  return [
    '<p class="ch-block-label">Not available in this version</p>',
    `<p class="ch-unknown-type">${escapeHtml(type === '' ? '(untyped block)' : type)}</p>`,
  ].join('\n');
}

/* ------------------------------------------------------------------ entry -- */

export type RenderedBlockBody = {
  readonly html: string;
  /** Emitted as a data attribute so a test, and an operator reading the page
   * source, can see which blocks lost their data without guessing from CSS. */
  readonly state: 'ok' | 'degraded' | 'unknown';
};

/* RULE 4, structurally: the only way to reach a block renderer is through this
 * function, and it catches. A block that throws is a dimmed block. */
export function renderBlockBody(block: Block, ctx: BlockContext): RenderedBlockBody {
  const type = str(block.type);
  if (!isBuiltInBlockType(type)) {
    return {html: renderUnknown(block), state: 'unknown'};
  }
  let html: string;
  try {
    switch (type) {
      case 'clock': html = renderClock(block, ctx); break;
      case 'calendar': html = renderCalendar(block, ctx); break;
      case 'photo': html = renderPhoto(block, ctx); break;
      case 'weather': html = renderWeather(block, ctx); break;
      case 'text': html = renderText(block, ctx); break;
    }
  } catch {
    /* Deliberately swallowed and never logged with the cause attached to the
     * page: an error message can carry a URL, and a calendar URL is a bearer
     * credential. One dimmed block, no detail on the wall. */
    return {html: degradedBody('This block could not be drawn'), state: 'degraded'};
  }
  return {
    html,
    state: html.includes('class="ch-degraded"') ? 'degraded' : 'ok',
  };
}

export {feedFor};
