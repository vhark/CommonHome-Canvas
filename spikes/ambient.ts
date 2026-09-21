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
/* CommonHome Canvas — ambient screen SPIKE.
 *
 * SPIKE, not Canvas v0.1. Doc 38's ambient formula, revised after owner
 * feedback: image-focused, not text-heavy. The photo is the subject; the
 * words on it are a quote for the day and one upcoming commitment. The
 * clock and date left this composition because the Shelf's bar already
 * shows the time, and weather renders once in the top-right corner.
 *
 * Product rules live in ambient-model.ts so they can be tested without a
 * browser. This file is DOM and timers only.
 */
import {
  type Snapshot,
  conditionText,
  creditText,
  focal,
  healthText,
  photoCredit,
  quoteOfDay,
  weatherCredit,
} from './ambient-model.ts';
import './ambient.css';

const SNAPSHOT_MS = 2 * 60 * 1000;
const QUOTE_CHECK_MS = 60 * 1000;

/* Last known good. Doc 38 commits to never-blank: a transient upstream failure
 * must not blank a wall screen, so the previous snapshot keeps rendering and
 * says how old it is rather than being replaced by an error. */
let last: Snapshot | null = null;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

/* The quote is date-derived, so it only needs re-rendering when the local
 * date changes. Checked once a minute; re-rendered only on rollover. */
let quoteDay = '';
function renderQuote(): void {
  const now = new Date();
  const day = now.toDateString();
  if (day === quoteDay) return;
  quoteDay = day;
  const q = quoteOfDay(now);
  $('.quote-text').textContent = q ? `\u201c${q.text}\u201d` : '';
  $('.quote-author').textContent = q ? q.author : '';
}

function renderPhoto(snap: Snapshot): void {
  const el = $('.photo');
  const photo = snap.photo;
  if (!photo) return;
  if (el.dataset.url === photo.url) return;

  /* Decode before showing. Swapping the background directly paints a partial
   * image while it streams; preloading means the crossfade only ever runs on a
   * complete picture. */
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url("${photo.url}")`;
    el.dataset.url = photo.url;
    el.classList.add('loaded');
  };
  img.src = photo.url;

  $('.photo-credit').textContent = creditText(photoCredit(photo));
}

function renderWeather(snap: Snapshot): void {
  const w = snap.weather;
  const temp = $('.temp');
  const cond = $('.condition');
  const credit = $('.weather-credit');

  if (!w || w.temperature === null) {
    temp.textContent = '';
    cond.textContent = '';
    credit.textContent = '';
    return;
  }
  temp.textContent = `${Math.round(w.temperature)}${w.unit}`;
  cond.textContent = conditionText(w.state);
  /* Attribution renders directly beneath the weather it describes. Bound to
   * the data, not floated in a corner, so the credit is unambiguous. */
  credit.textContent = creditText(weatherCredit(w));
}

function renderFocal(snap: Snapshot): void {
  const f = focal(snap, new Date());
  $('.focal-label').textContent = f ? f.label : '';
  $('.focal-value').textContent = f ? f.value : '';
}

function renderPresence(snap: Snapshot): void {
  const names = snap.peopleHome;
  $('.presence').textContent = names.length ? `${names.join(', ')} home` : '';
}

function render(snap: Snapshot): void {
  renderPhoto(snap);
  renderWeather(snap);
  renderFocal(snap);
  renderPresence(snap);
  $('.health').textContent = healthText(snap, new Date());
}

async function poll(): Promise<void> {
  try {
    const res = await fetch('/__ambient/snapshot', {cache: 'no-store'});
    const snap = (await res.json()) as Snapshot;
    if (snap.degraded.includes('all') && last) {
      render({...last, degraded: ['all']});
      return;
    }
    last = snap;
    render(snap);
  } catch {
    // Network failure: keep the last good screen up and disclose its age.
    if (last) render({...last, degraded: ['all']});
    else $('.health').textContent = 'Waiting for data';
  }
}

renderQuote();
setInterval(renderQuote, QUOTE_CHECK_MS);
void poll();
setInterval(() => void poll(), SNAPSHOT_MS);
