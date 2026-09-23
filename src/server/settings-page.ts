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
/* THE SETTINGS PAGE. Server-rendered HTML, no JavaScript at all.
 *
 * FIVE RULES, AND EACH ONE IS A PRODUCT CONSTRAINT RATHER THAN A PREFERENCE.
 *
 * 1. NO CREDENTIAL IS EVER PRINTED. Not in a value attribute, not in a
 *    placeholder, not in a comment, not in a hidden field. The password
 *    inputs on this page are ALWAYS empty, including immediately after a
 *    successful save, and what the household sees instead is
 *    "Set, ending 4f2a". This is the single most important property of the
 *    file, because this is the one page in the product that holds every
 *    secret the household owns - and the credential sweep in the tests runs
 *    over the full output of exactly this function.
 *
 * 2. HELPER TEXT IS INLINE, NEVER A TOOLTIP. Primary displays are Android
 *    tablets and touchscreens where `@media (hover: hover)` never matches, so
 *    a `title=` attribute is text the household cannot read at all (DES-04).
 *    Every credential field answers four questions in visible prose: what is
 *    this, how do I make one, what can it do if it leaks, and what if I would
 *    rather not. `<details>` is used for the longer passages - it opens on TAP,
 *    which is a click, not a hover.
 *
 * 3. EVERY TARGET IS AT LEAST 48x48 CSS PX. Buttons, checkbox rows, radio
 *    rows, summary elements and text inputs. DES-05 measured a 33% miss rate
 *    on a 16px affordance with a real fingertip, and that rule applies to
 *    every affordance and not only to things that look like buttons. The
 *    checkbox itself is enlarged AND its whole label row is the target, so a
 *    tap anywhere on the row toggles it.
 *
 * 4. NO INLINE SCRIPT AND NO SCRIPT AT ALL. The global CSP says
 *    script-src 'self', and a page that needs the policy loosened loosens it
 *    for the whole product. Everything here is a plain form POST, which also
 *    means the page works on a television's airmouse keyboard and in any
 *    browser a household might have on a wall.
 *
 * 5. THE STYLE IS INLINE <style>, WHICH THE CSP ALREADY PERMITS
 *    (`style-src 'self' 'unsafe-inline'`) - the same allowance the share
 *    lock page uses. An external stylesheet would be a second cacheable
 *    asset for a page loaded roughly twice a year.
 */

import {escapeHtml} from '../render/escape.ts';
import {
  WEATHER_PROVIDERS,
  type Location,
  type WeatherProvider,
} from '../providers/index.ts';
import {BLOCK_DESCRIPTORS} from './blocks.ts';
import type {CredentialDescription} from './credentials.ts';
import {blockEnabled, type Settings} from './settings.ts';

export const SETTINGS_PATH = '/settings';

/** A one-line outcome shown at the top of the page after a POST. Carries a
 * TONE rather than a colour, so the styling decision stays in the stylesheet
 * and the route only has to say what happened. */
export type Notice = {
  readonly tone: 'ok' | 'problem';
  readonly message: string;
};

export type SettingsPageModel = {
  readonly settings: Settings;
  readonly credentials: readonly CredentialDescription[];
  readonly notice: Notice | null;
  /** Geocoder candidates, when the household has just searched for a place.
   * Several, because "Springfield" is a real ambiguity a person resolves and
   * a server must not guess at. */
  readonly places: readonly Location[];
  /** What was typed into the place box, echoed so a mis-typed search is
   * editable rather than retyped. Escaped like everything else. */
  readonly placeQuery: string;
};

/* ------------------------------------------------------------------ style -- */

/* Rule 3 lives here. Every interactive selector below carries a 48px minimum,
 * and the checkbox itself is scaled up rather than left at a browser default
 * of about 13px. */
const STYLE = `
  :root { color-scheme: light dark; --gap: 1rem; --edge: color-mix(in srgb, currentColor 25%, transparent); }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0 auto; padding: 1.5rem 1rem 6rem; max-width: 46rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.125rem; margin: 2.5rem 0 .25rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .25rem; }
  p { margin: .4rem 0; }
  .lede, .hint { opacity: .78; font-size: .9375rem; }
  section { border-top: 1px solid var(--edge); padding-top: .5rem; }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { padding: 0; font-weight: 600; }

  /* DES-05: 48x48 minimum on EVERY affordance, not only on buttons. */
  button, input[type="text"], input[type="password"], input[type="search"], select {
    font: inherit; min-height: 48px; padding: .5rem .75rem;
    border-radius: .5rem; border: 1px solid currentColor; background: transparent;
    color: inherit; width: 100%;
  }
  button { cursor: pointer; font-weight: 600; min-width: 48px; }
  .row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: stretch; }
  .row > * { flex: 1 1 14rem; }
  .row > button { flex: 0 0 auto; min-width: 9rem; }

  /* The WHOLE ROW is the target, so a fingertip landing anywhere on the label
     toggles the switch. The control is enlarged too, because a 13px default
     checkbox is not a touch target even inside a large label. */
  .switch { display: flex; gap: .875rem; align-items: flex-start;
            min-height: 48px; padding: .625rem .75rem; margin: .25rem 0;
            border: 1px solid var(--edge); border-radius: .5rem; cursor: pointer; }
  .switch input { width: 28px; height: 28px; margin: .35rem 0 0; flex: 0 0 auto; }
  .switch .label { font-weight: 600; }
  .switch .hint { display: block; font-weight: 400; }

  /* <details> opens on TAP. It is disclosure, not hover-reveal (DES-04). */
  details { border: 1px solid var(--edge); border-radius: .5rem; margin: .625rem 0; }
  summary { min-height: 48px; display: flex; align-items: center; padding: 0 .875rem;
            cursor: pointer; font-weight: 600; }
  details > *:not(summary) { padding: 0 .875rem; }
  details > *:last-child { padding-bottom: .875rem; }
  ol { margin: .4rem 0; padding-left: 1.4rem; }
  li { margin: .3rem 0; }

  .notice { border: 1px solid currentColor; border-radius: .5rem;
            padding: .875rem; margin: 1rem 0; font-weight: 600; }
  .state { font-weight: 600; }
  .env { border: 1px dashed var(--edge); border-radius: .5rem; padding: .75rem; margin: .5rem 0; }
  .warn { font-weight: 600; }
  form { margin: .75rem 0; }
  .provider { border: 1px solid var(--edge); border-radius: .5rem;
              padding: .875rem; margin: .75rem 0; }
  .tag { font-size: .8125rem; border: 1px solid currentColor; border-radius: 99px;
         padding: .1rem .55rem; margin-left: .4rem; opacity: .8; }
`;

/* ------------------------------------------------------------- components -- */

function notice(value: Notice | null): string {
  if (value === null) return '';
  return `<p class="notice" data-tone="${value.tone}" role="status">${escapeHtml(value.message)}</p>`;
}

function checkboxRow(options: {
  name: string;
  value: string;
  label: string;
  hint: string;
  checked: boolean;
  tag?: string;
}): string {
  const tag = options.tag === undefined ? '' : `<span class="tag">${escapeHtml(options.tag)}</span>`;
  return [
    '<label class="switch">',
    `<input type="checkbox" name="${escapeHtml(options.name)}"`,
    ` value="${escapeHtml(options.value)}"${options.checked ? ' checked' : ''}>`,
    '<span>',
    `<span class="label">${escapeHtml(options.label)}${tag}</span>`,
    `<span class="hint">${escapeHtml(options.hint)}</span>`,
    '</span>',
    '</label>',
  ].join('');
}

function radioRow(options: {
  name: string;
  value: string;
  label: string;
  hint: string;
  checked: boolean;
  tag?: string;
}): string {
  const tag = options.tag === undefined ? '' : `<span class="tag">${escapeHtml(options.tag)}</span>`;
  return [
    '<label class="switch">',
    `<input type="radio" name="${escapeHtml(options.name)}"`,
    ` value="${escapeHtml(options.value)}"${options.checked ? ' checked' : ''}>`,
    '<span>',
    `<span class="label">${escapeHtml(options.label)}${tag}</span>`,
    `<span class="hint">${escapeHtml(options.hint)}</span>`,
    '</span>',
    '</label>',
  ].join('');
}

/* RULE 2, as a component. The four questions, every time, in visible prose -
 * never a tooltip, never a link to a document that will go stale. */
function helpFor(provider: WeatherProvider): string {
  const help = provider.help;
  const steps = help.howToMakeOne.length === 0
    ? ''
    : [
        '<h3>How do I make one?</h3>',
        '<ol>',
        ...help.howToMakeOne.map((step) => `<li>${escapeHtml(step)}</li>`),
        '</ol>',
      ].join('');
  return [
    '<details>',
    `<summary>About ${escapeHtml(provider.label)}</summary>`,
    '<h3>What is this?</h3>',
    `<p>${escapeHtml(help.whatItIs)}</p>`,
    steps,
    '<h3>What can it do if it leaks?</h3>',
    `<p class="warn">${escapeHtml(help.ifItLeaks)}</p>`,
    '<h3>What if I would rather not?</h3>',
    `<p>${escapeHtml(help.ifYouWouldRatherNot)}</p>`,
    '</details>',
  ].join('\n');
}

/* RULE 1, as a component.
 *
 * The <input> has NO value attribute and NO placeholder derived from the
 * secret. What is shown instead is a state line built from the hint, which is
 * a hash prefix. When the environment holds the value the field is disabled
 * outright rather than left open: a box that accepts a value the server will
 * ignore is worse than no box, because somebody will type into it and
 * conclude the page is broken. */
function credentialField(
  provider: WeatherProvider,
  description: CredentialDescription | undefined,
): string {
  if (provider.credential.kind !== 'required') {
    return '<p class="hint">Needs no account, no key and nothing to paste.</p>';
  }
  const id = provider.credential.credentialId;
  const label = provider.credential.label;
  const state = description === undefined || !description.configured
    ? '<p class="state">Not set.</p>'
    : `<p class="state">Set${description.hint === null ? '' : ` — ${escapeHtml(description.hint)}`}`
      + `${description.source === 'environment' ? ', by an environment variable' : ''}.</p>`;

  if (description?.fromEnvironment === true) {
    return [
      '<div class="env">',
      state,
      '<p class="hint">This is set by an environment variable on the machine running Canvas, '
        + 'and an environment variable always wins. To change it, change it there and restart — '
        + 'anything typed here would be ignored.</p>',
      '</div>',
    ].join('\n');
  }

  return [
    state,
    `<form method="post" action="${SETTINGS_PATH}/credential">`,
    `<input type="hidden" name="id" value="${escapeHtml(id)}">`,
    '<div class="row">',
    /* NO value=, NO placeholder carrying anything derived from the secret.
     * autocomplete="off" so a browser does not helpfully refill a token into
     * a page that is, by design, incapable of reading one back. */
    `<label style="flex:1 1 18rem"><span class="hint">${escapeHtml(label)}</span>`,
    `<input type="password" name="value" autocomplete="off" spellcheck="false" `
      + `aria-label="${escapeHtml(label)}" required></label>`,
    '<button type="submit">Save</button>',
    '</div>',
    '</form>',
    description?.configured === true
      ? [
          `<form method="post" action="${SETTINGS_PATH}/credential/clear">`,
          `<input type="hidden" name="id" value="${escapeHtml(id)}">`,
          '<button type="submit">Remove this credential</button>',
          '</form>',
        ].join('\n')
      : '',
  ].filter((part) => part !== '').join('\n');
}

function providerCard(
  provider: WeatherProvider,
  model: SettingsPageModel,
): string {
  const selected = model.settings.weather.providerId === provider.id;
  const description = model.credentials.find(
    (c) => provider.credential.kind === 'required' && c.id === provider.credential.credentialId,
  );
  const options = model.settings.weather.options[provider.id] ?? {};

  /* Home Assistant's two non-secret fields. They are NOT credentials - a LAN
   * name and an entity id are local names - so they are ordinary text inputs
   * whose current values are printed. The token above is not. */
  const extra = provider.id === 'home-assistant'
    ? [
        `<form method="post" action="${SETTINGS_PATH}/provider-options">`,
        '<input type="hidden" name="providerId" value="home-assistant">',
        '<div class="row">',
        '<label style="flex:1 1 18rem"><span class="hint">Address of your Home Assistant, '
          + 'for example https://homeassistant.example.com</span>',
        `<input type="text" name="url" inputmode="url" autocomplete="off" `
          + `aria-label="Home Assistant address" value="${escapeHtml(options.url ?? '')}"></label>`,
        '</div>',
        '<div class="row">',
        '<label style="flex:1 1 18rem"><span class="hint">Weather entity id, as shown in '
          + 'Developer tools → States</span>',
        `<input type="text" name="weatherEntity" autocomplete="off" spellcheck="false" `
          + `aria-label="Weather entity id" value="${escapeHtml(options.weatherEntity ?? '')}"></label>`,
        '<button type="submit">Save</button>',
        '</div>',
        '</form>',
      ].join('\n')
    : '';

  return [
    `<div class="provider" data-provider="${escapeHtml(provider.id)}"`,
    ` data-selected="${selected ? 'true' : 'false'}">`,
    radioRow({
      name: 'providerId',
      value: provider.id,
      label: provider.label,
      hint: provider.summary,
      checked: selected,
      ...(provider.advanced ? {tag: 'Advanced'} : {}),
    }),
    helpFor(provider),
    credentialField(provider, description),
    extra,
    `<form method="post" action="${SETTINGS_PATH}/test">`,
    `<input type="hidden" name="providerId" value="${escapeHtml(provider.id)}">`,
    `<button type="submit">Test ${escapeHtml(provider.label)}</button>`,
    '</form>',
    '</div>',
  ].filter((part) => part !== '').join('\n');
}

function placeLine(place: Location): string {
  return [place.name, place.region, place.countryCode]
    .filter((part) => part !== undefined && part !== '')
    .join(', ');
}

/* ------------------------------------------------------------------- page -- */

export function renderSettingsPage(model: SettingsPageModel): string {
  const {settings} = model;

  const builtIn = BLOCK_DESCRIPTORS.filter((d) => !d.experimental);
  const experimental = BLOCK_DESCRIPTORS.filter((d) => d.experimental);

  const location = settings.location;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Canvas settings</title>
<style>${STYLE}</style>
<body>
<h1>Canvas settings</h1>
<p class="lede">Everything on this page is stored on this machine. Canvas asks for as
little as it can: weather works with no account and no key at all.</p>
${notice(model.notice)}

<section id="blocks">
<h2>Blocks</h2>
<p class="lede">What Canvas is allowed to put on a screen. Anything switched off here
does not render and is not offered when you add something to a canvas.</p>
<form method="post" action="${SETTINGS_PATH}/blocks">
<fieldset>
<legend class="hint">Built-in Blocks</legend>
${builtIn.map((d) => checkboxRow({
  name: 'block',
  value: d.type,
  label: d.label,
  hint: d.description,
  checked: blockEnabled(settings, d.type),
})).join('\n')}
</fieldset>
<button type="submit">Save Blocks</button>
</form>
</section>

<section id="location">
<h2>Location</h2>
<p class="lede">One place name for the whole household. Canvas looks up its coordinates
once and stores them here; it does not ask you to paste coordinates into three
different Blocks.</p>
<p class="warn">Exact coordinates are a home address in another form. They stay on this
machine: they are never written into a canvas and never travel in a shared link.</p>
${location === null
  ? '<p class="state">No location set. Weather cannot be fetched until there is one.</p>'
  : `<p class="state">Set to ${escapeHtml(placeLine(location))}.</p>`}
<form method="post" action="${SETTINGS_PATH}/location">
<div class="row">
<label style="flex:1 1 18rem"><span class="hint">Town or city</span>
<input type="search" name="place" autocomplete="off" aria-label="Town or city"
 value="${escapeHtml(model.placeQuery)}"></label>
<button type="submit">Look up</button>
</div>
</form>
${model.places.length === 0 ? '' : [
  '<form method="post" action="' + SETTINGS_PATH + '/location/choose">',
  '<fieldset><legend class="hint">Which one did you mean?</legend>',
  ...model.places.map((place, index) => radioRow({
    name: 'place',
    value: JSON.stringify(place),
    label: placeLine(place),
    hint: place.timeZone === undefined ? '' : place.timeZone,
    checked: index === 0,
  })),
  '</fieldset>',
  '<button type="submit">Use this place</button>',
  '</form>',
].join('\n')}
<form method="post" action="${SETTINGS_PATH}/contact">
<div class="row">
<label style="flex:1 1 18rem"><span class="hint">Contact address (optional). MET Norway
asks that software using their forecasts can be contacted. Leave this empty and Canvas
sends the project's own address instead of yours.</span>
<input type="text" name="contact" autocomplete="off" aria-label="Contact address"
 value="${escapeHtml(settings.contact)}"></label>
<button type="submit">Save</button>
</div>
</form>
</section>

<section id="integrations">
<h2>Integrations</h2>
<p class="lede">Where the weather comes from. The first two need no account of any kind;
the third reads your own sensors and needs a token.</p>
<form method="post" action="${SETTINGS_PATH}/weather">
${WEATHER_PROVIDERS.map((provider) => providerCard(provider, model)).join('\n')}
<fieldset>
<legend class="hint">Units</legend>
${radioRow({
  name: 'units',
  value: 'metric',
  label: 'Celsius',
  hint: 'Degrees Celsius.',
  checked: settings.weather.units === 'metric',
})}
${radioRow({
  name: 'units',
  value: 'imperial',
  label: 'Fahrenheit',
  hint: 'Degrees Fahrenheit.',
  checked: settings.weather.units === 'imperial',
})}
</fieldset>
<button type="submit">Save weather source</button>
</form>
</section>

<section id="experimental">
<h2>Experimental</h2>
<p class="lede">Work in progress. Experimental Blocks may break, may change shape, and may
be removed in a later version. They are off until you switch them on, and an experimental
Block that is running says so on the screen — so nobody wonders later why one panel on the
hallway display looks different.</p>
<form method="post" action="${SETTINGS_PATH}/experimental">
${checkboxRow({
  name: 'experimentalEnabled',
  value: 'on',
  label: 'Allow experimental Blocks',
  hint: 'Master switch. With this off, nothing below runs whatever it says.',
  checked: settings.experimentalEnabled,
})}
<fieldset>
<legend class="hint">Experimental Blocks</legend>
${experimental.map((d) => checkboxRow({
  name: 'block',
  value: d.type,
  label: d.label,
  hint: `${d.description} ${d.caveat ?? ''}`.trim(),
  checked: settings.blocks[d.type] === true,
  tag: 'Experimental',
})).join('\n')}
</fieldset>
<button type="submit">Save experiments</button>
</form>
</section>

<section id="safety">
<h2>How Canvas handles what you type here</h2>
<p>Credentials are write-only. Canvas stores them in a file only the account running
Canvas can read, and there is no address on this server that will give one back — not to
you, not to a browser, not to anything on your network. That is why the boxes above are
always empty even after a successful save, and why what you see instead is a short
fingerprint that tells you the value has not changed.</p>
<p>This page has no password on it yet. Until Canvas has proper administrator accounts, it
answers requests from this machine only and refuses everything else, whatever address the
server is listening on.</p>
</section>
</body>
</html>
`;
}
