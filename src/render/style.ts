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
/* The stylesheet, as a string.
 *
 * A string rather than a file because the runtime image has no bundler and no
 * node_modules: `dependencies: {}` is a product property, so every asset the
 * server serves is either read from disk at request time or is a constant in
 * the source. It is served from a FIXED, token-free path so a household of six
 * screens shares one cacheable file, and so the page needs no inline <style>
 * that would force the CSP to loosen `style-src` for the whole product.
 *
 * VIEWING DISTANCE DRIVES EVERY SIZE. The primary target is a television read
 * from roughly three metres and tablets read from arm's length, so type is
 * scaled well past desktop norms and the size contrast between a clock and the
 * smallest credit is deliberately large. Sizes are in `cqw`/`clamp` against the
 * block's own container, so a block that is 3 cells wide at Standard and 6 at
 * Dense reads the same at both - the footprint changes, the proportions do not.
 *
 * HIERARCHY COMES FROM SIZE, POSITION AND OPACITY - NEVER FROM HUE. Coloured
 * text over an arbitrary photograph is both unreadable and restless, and colour
 * alone fails for the ~8% of men with a colour vision deficiency and for
 * everyone at three metres where hue discrimination degrades.
 */

export const CANVAS_STYLESHEET_PATH = '/assets/canvas.css';

export const CANVAS_STYLESHEET = `/* CommonHome Canvas render stylesheet. AGPL-3.0-or-later. */
:root {
  color-scheme: light dark;
  --ch-canvas: #12100E;
  --ch-text: #FFFFFF;
  --ch-accent: #C97B4A;
  --ch-a-primary: 1;
  --ch-a-secondary: 0.85;
  --ch-a-tertiary: 0.70;
  --ch-a-quiet: 0.50;
  --ch-edge: clamp(12px, 2.2vw, 44px);
  --ch-gap: clamp(8px, 1.2vw, 22px);
  --ch-radius: clamp(10px, 1.2vw, 22px);
  --ch-font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ch-serif: Georgia, "Times New Roman", serif;
  /* Slow and uniform. Nothing on an ambient screen should move quickly enough
     to pull an eye from across a room. */
  --ch-fade: 0.5s ease;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { background: var(--ch-canvas); }
html, body {
  min-height: 100%;
  color: var(--ch-text);
  font-family: var(--ch-font);
  -webkit-font-smoothing: antialiased;
}

.ch-canvas {
  padding: var(--ch-edge);
  display: flex;
  flex-direction: column;
  gap: var(--ch-gap);
  min-height: 100vh;
}

/* The canvas name is furniture, not content: quiet, small, top-left, and the
   same on every screen so the eye learns to skip it. */
.ch-canvas-name {
  font-size: clamp(13px, 1.1vw, 19px);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: var(--ch-a-quiet);
}

.ch-region { display: flex; flex-direction: column; gap: var(--ch-gap); flex: 1 1 auto; }

/* ------------------------------------------------------------------- grid -- */

/* One CSS grid per Grid layout, with exactly as many columns as the density
   declares. Rows are a fixed minimum height rather than content-sized, so a
   block that loses its data does not collapse and shuffle its neighbours -
   glanceability depends on the furniture not moving. */
.ch-grid {
  display: grid;
  gap: var(--ch-gap);
  grid-auto-rows: minmax(clamp(34px, 6.2vh, 96px), auto);
  flex: 1 1 auto;
}
.ch-grid[data-density="comfortable"] { grid-template-columns: repeat(6, minmax(0, 1fr)); }
.ch-grid[data-density="standard"]    { grid-template-columns: repeat(12, minmax(0, 1fr)); }
.ch-grid[data-density="dense"]       { grid-template-columns: repeat(24, minmax(0, 1fr)); }

/* An AutoGrid places its own items, so density largely IS the column count and
   there is nothing positional to preserve. */
.ch-autogrid {
  display: grid;
  gap: var(--ch-gap);
  grid-auto-rows: minmax(clamp(60px, 14vh, 220px), auto);
  flex: 1 1 auto;
}
.ch-autogrid[data-width-mode="narrow"]   { grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); }
.ch-autogrid[data-width-mode="standard"] { grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.ch-autogrid[data-width-mode="wide"]     { grid-template-columns: repeat(auto-fill, minmax(25rem, 1fr)); }
.ch-autogrid[data-height-mode="short"] { grid-auto-rows: minmax(clamp(44px, 9vh, 130px), auto); }
.ch-autogrid[data-height-mode="tall"]  { grid-auto-rows: minmax(clamp(90px, 22vh, 340px), auto); }

.ch-rows { display: flex; flex-direction: column; gap: var(--ch-gap); flex: 1 1 auto; }
.ch-row { display: flex; flex-direction: column; gap: var(--ch-gap); }

/* Tabs render as LABELLED SECTIONS, stacked, not as tab strips.
   A display surface has no editing or navigation affordance at all, so there is
   no control to switch a tab with; and a tab whose contents can only be reached
   by touching something is a tab a wall display never shows. Stacking is the
   honest rendering: everything the document says is on the screen. */
.ch-tabs { display: flex; flex-direction: column; gap: calc(var(--ch-gap) * 1.5); flex: 1 1 auto; }
.ch-tab-label {
  font-size: clamp(12px, 1vw, 17px);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: var(--ch-a-quiet);
  margin-bottom: calc(var(--ch-gap) / 2);
}

/* --------------------------------------------------------------- the block -- */

/* container-type so every block's type scales against ITS OWN width. This is
   what makes one declared footprint legible at three densities: the cell count
   changes, the proportions inside the block do not. */
.ch-block {
  container-type: inline-size;
  position: relative;
  overflow: hidden;
  border-radius: var(--ch-radius);
  padding: clamp(10px, 1.6cqw, 30px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: clamp(2px, 0.6cqw, 10px);
  background: color-mix(in srgb, var(--ch-text) 6%, transparent);
  transition: opacity var(--ch-fade);
}

/* RULE: a block that lost its data is DIMMED, never removed and never blank.
   It keeps its footprint, so the rest of the page does not move, and it says in
   words which block is affected. */
.ch-block[data-state="degraded"] { opacity: 0.45; }
.ch-block[data-state="unknown"] {
  opacity: 0.6;
  border: 1px dashed color-mix(in srgb, var(--ch-text) 35%, transparent);
  background: none;
}

/* Announced when a size the author chose is not offered at this density and the
   renderer landed on the nearest declared one. Visible in the source, not on
   the wall: the household should see a block, not a diagnostic. */
.ch-block[data-footprint="snapped"] { }

.ch-block-label {
  font-size: clamp(11px, 3.4cqw, 22px);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: var(--ch-a-quiet);
}

.ch-degraded, .ch-empty {
  font-size: clamp(12px, 4cqw, 26px);
  opacity: var(--ch-a-tertiary);
}

.ch-unknown-type {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: clamp(11px, 3.6cqw, 20px);
  opacity: var(--ch-a-tertiary);
  word-break: break-all;
}

/* --------------------------------------------------------- attribution --- */

/* Attribution is first-class: it sits WITH the thing it credits, not in a
   footnote at the bottom of the page. Quiet - small and at 50% - but always
   present, because a household should be able to see where a number or a
   photograph came from without being told. */
.ch-credit {
  font-size: clamp(10px, 2.6cqw, 17px);
  letter-spacing: 0.01em;
  opacity: var(--ch-a-quiet);
  margin-top: clamp(3px, 0.8cqw, 9px);
}

/* ------------------------------------------------------------------ clock -- */

.ch-clock { align-items: flex-start; }
.ch-clock-time {
  font-size: clamp(30px, 26cqw, 220px);
  font-weight: 300;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  opacity: var(--ch-a-primary);
}
.ch-clock-date {
  font-size: clamp(12px, 5.4cqw, 44px);
  opacity: var(--ch-a-tertiary);
}

/* ---------------------------------------------------------------- weather -- */

.ch-weather { align-items: flex-start; }
.ch-weather-temp {
  font-size: clamp(26px, 19cqw, 130px);
  font-weight: 300;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  opacity: var(--ch-a-secondary);
}
.ch-weather-condition {
  font-size: clamp(12px, 5cqw, 40px);
  opacity: var(--ch-a-tertiary);
}

/* ------------------------------------------------------------------ photo -- */

.ch-photo { padding: 0; justify-content: flex-end; background: var(--ch-canvas); }
.ch-photo-image {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  /* A photo block's image sits behind its caption band without needing a
     negative z-index, which would paint it behind the block's own background
     and hide it while every DOM property still reported it as loaded. */
  z-index: 0;
}
/* The scrim is deliberately NOT a flat wash. A uniform dark layer kills the
   photograph and still fails behind a bright sky. This darkens one specific
   place instead: the bottom edge, where photos render brightest and where the
   caption and the credit sit. The mid-frame is left untouched. */
.ch-photo-band {
  position: relative;
  z-index: 1;
  padding: clamp(10px, 2.4cqw, 34px);
  background: linear-gradient(to top,
    rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.38) 45%, rgba(0,0,0,0) 100%);
  text-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);
}
.ch-photo-caption {
  font-family: var(--ch-serif);
  font-style: italic;
  font-size: clamp(13px, 4.6cqw, 40px);
  line-height: 1.25;
  opacity: var(--ch-a-primary);
}
.ch-photo .ch-credit { opacity: var(--ch-a-tertiary); }

/* ------------------------------------------------------------------- text -- */

.ch-text { justify-content: center; }
.ch-text-body {
  font-family: var(--ch-serif);
  font-size: clamp(13px, 5.6cqw, 46px);
  line-height: 1.3;
  opacity: var(--ch-a-secondary);
}

/* --------------------------------------------------------------- calendar -- */

.ch-calendar { justify-content: flex-start; gap: clamp(4px, 1cqw, 14px); }
.ch-agenda, .ch-upnext, .ch-daycolumns { display: flex; gap: clamp(4px, 1.2cqw, 18px); }
.ch-agenda { flex-direction: column; }
.ch-upnext { flex-direction: column; list-style: none; }
.ch-daycolumns { flex-direction: row; align-items: stretch; }
.ch-daycolumn { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
                gap: clamp(3px, 0.8cqw, 10px); }
/* TODAY is the emphasis, always - not "the busiest day" and not "the next day
   with something on it". A moving emphasis is a moving layout. */
.ch-daycolumn.ch-emphasis { flex: 1.6 1 0; }
.ch-daycolumn.ch-emphasis .ch-day-label { opacity: var(--ch-a-primary); }

.ch-day-label {
  font-size: clamp(11px, 3cqw, 22px);
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: var(--ch-a-quiet);
}
.ch-day-events { list-style: none; display: flex; flex-direction: column;
                 gap: clamp(2px, 0.6cqw, 8px); }
.ch-event { display: flex; flex-wrap: wrap; gap: clamp(4px, 1cqw, 14px);
            align-items: baseline; }
.ch-event-when {
  font-variant-numeric: tabular-nums;
  font-size: clamp(11px, 3cqw, 24px);
  opacity: var(--ch-a-quiet);
  white-space: nowrap;
}
.ch-event-title {
  font-size: clamp(12px, 3.4cqw, 28px);
  opacity: var(--ch-a-secondary);
  min-width: 0;
}
.ch-event-detail {
  flex: 1 1 100%;
  font-size: clamp(10px, 2.6cqw, 18px);
  opacity: var(--ch-a-quiet);
}
/* An unconfirmed event says so by weight, not by colour alone. */
.ch-event.ch-tentative .ch-event-title { font-style: italic; opacity: var(--ch-a-tertiary); }
.ch-overflow { font-size: clamp(10px, 2.8cqw, 19px); opacity: var(--ch-a-quiet); }

/* --------------------------------------------------------------- motion --- */

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
