# 05 — The ambient screen

This is the part of Canvas that works today. It is a **spike** — a prototype
that runs on a television and answers design questions — not Canvas v0.1. It
does not use the canonical document model in `src/canvas/`, and the composition
is hand-written HTML and CSS rather than authored blocks.

Read that paragraph again before deploying it anywhere that matters.

## What it shows

```
┌───────────────────────────────────────────────────────────────┐
│ who is home                                        21°C       │
│                                                    Partly cloudy│
│                                                    met.no     │
│                                                               │
│                     (full-bleed photograph)                   │
│                                                               │
│                          NEXT · 5:30 PM                       │
│                          Swim practice                        │
│                                                               │
│            "The best way out is always through."              │
│                        — Robert Frost                         │
│ health notice (only when wrong)     Photo by <name> on <src>  │
└───────────────────────────────────────────────────────────────┘
```

A three-column, five-row grid over a full-bleed photograph. The composition is
image-focused rather than text-heavy: the photo is the subject, and the words
on it are a quote for the day and one upcoming commitment.

| Region | Content |
|---|---|
| Top left | Who is home, quietly |
| Top right | Temperature, condition, and the forecast source credited beneath it |
| Bottom centre (row 4) | The focal slot: the next commitment, or nothing |
| Bottom centre (row 5) | The day's quote and its author — a caption band, not a centrepiece |
| Bottom left | Health notice; absent unless something is actually wrong |
| Bottom right | Photo credit; smallest thing on screen, furthest corner |

Deliberately absent: a clock, a date and a greeting. The clock left this
composition because the surrounding shell already shows the time, and a large
clock was the loudest thing on what is supposed to be a picture.

## Product rules, and where they live

`spikes/ambient.ts` is **DOM and timers only**. Anything that encodes a product
rule lives in `spikes/ambient-model.ts`, where it can be asserted without a
browser. That is why `npm run test:ambient` covers 47 behaviours of a screen
with no test browser involved.

The four rules that shape it, quoted from the model's header:

> - the focal slot holds exactly one element, chosen by precedence
> - Home Assistant condition slugs never reach a family wall raw
> - a stale snapshot is disclosed, never presented as current
> - every rendered value can name where it came from

### The focal slot is a contract, not a stack

Candidates compete for one below-centre slot and exactly one wins; they are
never shown together. Precedence reflects what a household glancing at a wall
needs to know next: a commitment beats ambient conditions.

Past events are excluded. A display showing this morning's appointment at five
in the afternoon is worse than showing nothing, because it looks current.

There is **no weather fallback** in the focal slot. Weather renders once, top
right, with its credit; repeating it centre-stage made the screen text-heavy
and told the viewer nothing the corner had not. An empty focal slot is the calm
outcome.

### Condition slugs are mapped, never shown raw

Home Assistant weather states are machine slugs — `partlycloudy`,
`lightning-rainy`, `exceptional`. Rendering them raw puts developer identifiers
on a family wall.

```ts
const CONDITIONS: Record<string, string> = {
  'clear-night': 'Clear', cloudy: 'Cloudy', fog: 'Fog', hail: 'Hail',
  lightning: 'Thunderstorms', 'lightning-rainy': 'Thunderstorms',
  partlycloudy: 'Partly cloudy', pouring: 'Heavy rain', rainy: 'Rain',
  snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny',
  windy: 'Windy', 'windy-variant': 'Windy', exceptional: 'Severe weather',
};
```

Mapped explicitly rather than by regex, because the slugs are a closed set and
`partlycloudy` has no separator to split on. An unknown future slug still never
reaches the wall raw: separators become spaces and the first letter is
capitalised, so it degrades to readable English.

### Degradation is stated, never faked

The screen commits to never blanking. But "never blank" must not become
"silently wrong", so a screen rendering a cached snapshot says so once it is
meaningfully old:

| Condition | Rendered health text |
|---|---|
| No snapshot at all | `Waiting for data` |
| Healthy | *(empty — the element is `display: none` when empty)* |
| Partial, fresh | `Partial: weather, photo` |
| Partial, older than 2 minutes | `Showing last known good · 7 min old` |

The health line is a diagnostic, so it is **absent** rather than dim when
nothing is wrong. A television cannot be hovered, so the disclosure is
conditional rather than hover-revealed.

### The quote is deterministic, not random

```ts
export function quoteOfDay(now: Date, quotes: readonly Quote[] = QUOTES): Quote | null
```

Chosen from the local calendar date. Deterministic for two reasons. A wall
display re-renders often — polls, restarts, power cycles — and a quote that
changes on every refresh reads as churn, not inspiration. And every display in
the house showing the *same* quote on the same day makes it a small shared
artifact rather than per-screen noise.

It uses the local date, so the quote changes at the household's midnight, not
UTC's. The client checks once a minute and re-renders only on rollover.

The built-in library ships 100 quotes locally: no network call, no account, no
tracking. Attribution doctrine applies to words too — every quote names its
author, and the set deliberately avoids the internet's famous misattributions.
Where a quote is traditional or its author genuinely unknown, it says so rather
than borrowing a famous name. Tests assert that every quote has an author, that
none is duplicated, that each is sized for a wall rather than a page, and that
no two consecutive days share an author.

A household library can substitute for the built-in one by passing it to
`quoteOfDay`; there is no UI for that yet.

## Configuration

The adapter is `vite.ambient.config.ts`. It is configured by environment
variables and by editing constants in that file. There is no config file, no UI
and no persistence — this is a spike.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | `http://localhost:8123` | Home Assistant base URL |
| `HA_TOKEN` | empty | Long-lived access token |
| `UNSPLASH_ACCESS_KEY` | empty | Unsplash API access key |

```sh
HA_URL=http://<your-home-assistant-host>:8123 \
HA_TOKEN=<token> \
UNSPLASH_ACCESS_KEY=<key> \
npx vite --config vite.ambient.config.ts
```

Or `npm run build:ambient` to produce a static build of the composition into
`dist/ambient` (the snapshot endpoint is part of the dev-server plugin and is
not included in that build).

An empty `UNSPLASH_ACCESS_KEY` simply means no photo: `unsplashPhoto` returns
`null` early and the composition falls back to the flat canvas colour.

### Constants to edit in `vite.ambient.config.ts`

| Constant | What it does |
|---|---|
| `WEATHER` | The Home Assistant weather entity id |
| `CALENDAR` | The calendar entity id |
| `PEOPLE` | An array of person entity ids for presence |
| `UNSPLASH_TOPIC` | The Unsplash topic id to draw photos from |
| `ALLOWED_HOSTS` | Hosts permitted to reach the server; **you must add your own** |
| `PHOTO_TTL_MS` | Photo cache lifetime; three hours |
| `APP_NAME` | Identifies this application in Unsplash's required UTM parameters |

The entity lists are an **explicit allowlist**, not a pattern. Adding an entity
is a deliberate act, not a side effect of the display asking for something new.

`ALLOWED_HOSTS` ships with loopback plus the author's own addresses. Replace
them. The server binds `0.0.0.0` but rejects any request whose `Host` header is
not in the list with `403 Host not permitted.`, and Vite's own `allowedHosts`
enforces the same list independently.

### Server behaviour

| Setting | Value | Why |
|---|---|---|
| Port | 4174, `strictPort` | Fails loudly rather than drifting to another port |
| CORS | off | Nothing should be embedding this cross-origin |
| HMR | disabled | An appliance display has no use for hot reload and should not hold an open websocket it never reads |
| `fs.strict` | on | |
| `/.planning`, `/.git`, `/.hermes` | 404 | Never serve repository internals from a display-facing process |
| `/node_modules` | served | Vite's own client runtime is imported from there; blocking it blanks the screen silently |

### Polling and caching

| Timer | Interval |
|---|---|
| Snapshot poll | 2 minutes |
| Quote rollover check | 1 minute |
| Photo cache lifetime | 3 hours |

The photo is cached for hours rather than fetched per snapshot. A commonly
available demo API tier allows 50 requests an hour; at a two-minute poll,
fetching a photo each time would exhaust that in about ninety minutes. A wall
photo that changes a few times a day is also simply calmer than one that
changes while somebody is looking at it. Re-serving the same image URL costs no
API request.

## The snapshot endpoint

```
GET /__ambient/snapshot
```

Read-only by construction. Anything other than GET returns 405; anything other
than this path falls through to static serving.

```json
{
  "weather": {"state": "partlycloudy", "temperature": 21.4, "unit": "°C",
              "attribution": "Weather forecast from met.no, delivered by the Norwegian Meteorological Institute."},
  "events": [{"summary": "Swim practice", "start": "2026-09-21T17:30:00-06:00", "allDay": false}],
  "peopleHome": ["Alex"],
  "photo": {
    "url": "https://images.example/...&w=1920&h=1080&fit=crop&crop=entropy&auto=format&q=80",
    "color": "#26343f", "blurHash": "LEHV6n...",
    "photographer": "A Photographer",
    "photographerUrl": "https://unsplash.com/@someone?utm_source=commonhome_canvas&utm_medium=referral",
    "source": "Unsplash",
    "sourceUrl": "https://unsplash.com/?utm_source=commonhome_canvas&utm_medium=referral"
  },
  "generatedAt": "2026-09-21T16:02:11.004Z",
  "degraded": []
}
```

What is **not** in that payload: tokens, entity ids, raw upstream objects,
calendar descriptions, calendar locations. Only three fields of an event leave
the server — `summary` truncated to 120 characters, `start`, and an `allDay`
flag. Descriptions and locations are household-private and have no business on
a wall display. At most eight events are returned, over a 36-hour window.

`Cache-Control: no-store` is set on every response.

On total failure the endpoint returns **HTTP 503 with the same JSON shape** and
`degraded: ["all"]`, so the client keeps rendering its last known good snapshot
instead of blanking. The client mirrors this: on a network error it re-renders
its last snapshot with `degraded: ['all']` rather than clearing the screen.

## Attribution obligations

Attribution in Canvas is a first-class modelled element, not fine print. Two
reasons, stated in the source: **obligation** — the forecast provider's terms
require crediting the forecast, and the photo provider requires naming the
photographer and the source — and **doctrine**, that a household should always
be able to see where a number came from. A display that states the weather
without saying who forecast it is asking to be trusted without showing its
work.

Each credit is bound to the thing it describes and rendered next to it, so the
relationship is visible rather than implied by a footnote.

```ts
export type Credit = {
  of: 'weather' | 'calendar' | 'presence' | 'photo';
  source: string;
  author?: string;
  authorUrl?: string;
  sourceUrl?: string;
};
```

### Weather (met.no)

The attribution arrives from Home Assistant as a full sentence: *"Weather
forecast from met.no, delivered by the Norwegian Meteorological Institute."*
Rendered verbatim it is a paragraph in a corner. `shortenAttribution` reduces it
to the institution actually being credited, which is what the licence asks for,
while the full string remains available for a details view.

The regex stops at a comma or a sentence-ending period but **not** at a period
inside a domain — the source being credited is literally `met.no`, and a naive
pattern truncates it to `met`. A period only ends the clause when followed by
whitespace or the end of the string. There is a test for exactly this.

If no source can be identified, `weatherCredit` returns `null` rather than
rendering an empty label.

### Photos (Unsplash)

Three obligations, all honoured in `vite.ambient.config.ts` and
`ambient-model.ts`:

1. **Hotlink the image.** The served URL is built from `urls.raw` with imgix
   sizing parameters appended, so **the `ixid` in `urls.raw` is preserved** as
   the guidelines require. The image is not copied or re-hosted.

   ```ts
   const sized = `${d.urls.raw}&w=1920&h=1080&fit=crop&crop=entropy&auto=format&q=80`;
   ```

2. **Trigger the download endpoint on each use.** The API guidelines require
   hitting `links.download_location` every time a photo is used as a
   background. It is not a download — it is how photographers are credited with
   a use. It is fired and forgotten so a slow response never delays the screen,
   but it is never skipped.

3. **Credit in the required wording, with UTM parameters.** The rendered text
   is `Photo by <name> on Unsplash`, and both the photographer URL and the
   source URL carry `?utm_source=commonhome_canvas&utm_medium=referral`.

On a television nothing is clickable, so the text credit still renders in full
and the links travel with the model for any surface that can use them. Dropping
the credit because a TV cannot be clicked would not satisfy the requirement.

`photoCredit` returns `null` for an incomplete photo record rather than
crediting nobody, and `creditText(null)` returns an empty string rather than the
literal string `"null"`. Both are tested.

Photos are requested with `content_filter=high` and `orientation=landscape`,
from a topic of landscape and drone photography intended as desktop
backgrounds, which is the closest published topic to a calm wall display.

## Visual technique

Recorded because it is unusual and deliberate:

- **The scrim is not a flat wash.** Rather than darkening the whole photo until
  text works anywhere, each text cluster drags a soft blurred shadow behind
  itself (`filter: blur(40px)`, `opacity: 0.25`, `mix-blend-mode: overlay`).
  The photo stays bright where there is nothing to read.
- **One text colour at several alphas.** Hierarchy comes from size, position
  and opacity — never from hue. Coloured text over an arbitrary photograph is
  both unreadable and restless.
- **Photos decode before they appear.** A new photo is preloaded into an
  `Image` and only swapped in on `onload`, so the two-second crossfade only ever
  runs on a complete picture rather than painting a partial image as it streams.
- **Viewing distance drives every size.** The composition targets a 1920×1080
  logical viewport read from roughly three metres.
- **Nothing slides or scales.** Content swaps fade. Transitions are slow and
  uniform — nothing on an ambient screen should move quickly enough to pull the
  eye from across a room.
- **`prefers-reduced-motion: reduce` disables every transition and animation.**

## Limitations

- It is a Vite dev-server plugin, not a service. No authentication, no display
  identity, no TLS, no packaging.
- Entities are edited in source, not configured.
- It does not use the canonical document model. The composition is fixed HTML
  and CSS; you cannot author it.
- Only one photo provider and one home-automation provider are wired up.
- There is no household quote library UI, no photo history, no favourites.
