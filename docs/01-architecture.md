# 01 — Architecture

Canvas is a prototype. This document describes the parts that exist, the
boundary between them, and the parts that are deliberately absent.

## The two halves of the repository

The single most important structural fact about this repository is that it
contains two unrelated bodies of code.

| Directory | Status | Purpose |
|---|---|---|
| `src/canvas/` | **Production model** | The canonical document schema, density levels, block footprints and reflow. Tested, pure, no I/O, no DOM. |
| `spikes/` | **Disposable experiments** | Engine comparison harness, its own throwaway document shape, and the ambient screen prototype. |

They do not share types, do not import each other, and do not agree on
semantics. `spikes/model.ts` opens with:

```ts
// Disposable experiment semantics, not the product schema.
```

and `src/canvas/types.ts` answers it:

```ts
/* CommonHome Canvas — the canonical document model.
 *
 * This is the product model. spikes/model.ts is a disposable experiment with
 * different semantics and is not related to anything here.
 */
```

When the editor is built, it will be built against `src/canvas/`. The spikes
are scheduled for removal once they have finished answering the questions they
were written to answer.

## The canonical model (`src/canvas/`)

Five modules, one public surface.

```
density.ts   named density levels; column counts; scale factors
sizes.ts     block type declarations; named footprints per density; snapping
types.ts     the document schema, layout kinds, Result/error types, guards
reflow.ts    the pure reflow function, dispatching per layout kind
document.ts  load / validate / save; canonical-vs-override priority; share
index.ts     re-exports the above as one import
testing.ts   deterministic generators for the property tests (not shipped)
```

Properties the model holds, and the tests that hold it to them:

- **Reflow is pure.** It reads nothing but its arguments — no clock, no
  randomness, no module-level mutable state, no I/O — and returns freshly
  built values via `structuredClone`, so a caller cannot alias into the input.
- **Reflow rewrites layout only.** It reads `spec.elements` to learn a block's
  footprint and never writes to it.
- **Unknown content survives.** Unknown layout kinds, unknown block types and
  unknown fields all round-trip through `loadDocument` → `saveDocument`
  unchanged.
- **Round-trip identity.** Returning to the authored density restores the
  authored record exactly, because the doubling column counts make the
  arithmetic exact rather than approximate.
- **Idempotence.** `reflow(reflow(L, d), d)` equals `reflow(L, d)`.

There is no UI, no persistence and no network code in `src/canvas/`. That is
intentional: the layout representation was fixed before any document was
persisted, because a representation mistake is cheap now and very expensive
once documents exist in households.

## Where the grid engine sits

**GridStack 13.2.0** was selected as the eventual editor's drag/drop/resize
engine, after a hands-on comparison against native CSS Grid and React Grid
Layout. It is currently **only present in the comparison spike**. Nothing in
`src/canvas/` imports it, and the production editor that would use it does not
exist yet.

The comparison recorded at decision time:

| Check | GridStack | Native CSS Grid | React Grid Layout |
|---|---|---|---|
| Licence | MIT | n/a | MIT |
| Runtime dependencies | none | none | React + React DOM |
| JS bundle | 97,038 B | 10,330 B | 264,934 B |
| JS gzipped | 28,409 B | 4,537 B | 80,436 B |
| Adapter size | 1,597 B | 1,441 B | 1,381 B |

Two things this settles. MIT with zero dependencies imposes no transitive
obligations on an AGPL-3.0 project. And GridStack costs roughly a third of
React Grid Layout's gzipped weight without pulling a framework into a project
that has no other reason to ship one. Native CSS Grid is far smaller still and
did not win the hands-on comparison.

The relationship between the engine and the model is a layering, not a
coupling: **GridStack is an input device.** Named sizes (see
[03](03-blocks-and-sizing.md)) sit on top of it as a constraint layer that
restricts resize to declared footprints, and the canonical document is what
gets persisted — never GridStack's internal state.

## The server-side adapter boundary

The ambient spike is served by `vite.ambient.config.ts`, which is a Vite
config carrying a small middleware plugin. It exists as a *server* rather than
as browser `fetch` calls for one reason, stated in the file itself:

> A living-room screen is shared with the whole household and any visitor, so
> neither the Home Assistant token nor the Unsplash key may be reachable from
> the page. This process holds both, calls the APIs itself, and returns ONLY
> the shaped fields the composition renders. No token, no entity ids, no raw
> upstream payloads cross to the browser.

```
┌─────────────────────┐       ┌──────────────────────────┐       ┌───────────────┐
│ Display (browser)   │       │ Adapter process           │       │ Upstream APIs │
│                     │       │                           │       │               │
│  GET /__ambient/    │──────▶│  holds HA_TOKEN,          │──────▶│ Home Assistant│
│      snapshot       │       │  UNSPLASH_ACCESS_KEY      │──────▶│ photo provider│
│                     │◀──────│  issues GETs only         │       │               │
│  shaped JSON only   │       │  shapes + allowlists      │       │               │
└─────────────────────┘       └──────────────────────────┘       └───────────────┘
```

The properties that make this a boundary rather than a proxy:

- **Explicit entity allowlist.** The weather entity, the calendar and the
  person entities are named as constants in the config. Adding a source is a
  deliberate edit, not a side effect of the display asking for something new.
- **Field-level shaping.** Only three fields of a calendar event leave the
  server — `summary` (truncated to 120 characters), `start`, and an `allDay`
  flag. Descriptions and locations are household-private and are dropped.
- **Read-only by construction.** The middleware issues GETs and exposes no way
  to call a service. A compromised display cannot actuate anything.
- **Method and path gating.** Anything that is not `GET /__ambient/snapshot`
  falls through to static serving; a non-GET returns 405.
- **Repository internals are not served.** Requests for `/.planning`, `/.git`
  or `/.hermes` return 404. `node_modules` is deliberately *not* blocked,
  because Vite's own client runtime is imported from there and blocking it
  silently blanks the screen.
- **A Host allowlist**, enforced both by Vite's `allowedHosts` and by the
  middleware, returning 403 for anything else. HMR is disabled and CORS is off.

### Independent degradation

Each source fails on its own. Weather, calendar, presence and photo are
fetched in separate `try` blocks; a failure pushes a name onto a `degraded`
array and the rest still renders. Total failure returns HTTP 503 with the
*same JSON shape* so the client keeps rendering its last known good snapshot
rather than blanking.

Photos are cached for three hours rather than fetched per snapshot. The
snapshot endpoint is polled every two minutes; fetching a photo each time would
exhaust a rate-limited quota within a couple of hours, and a wall photo that
changes while somebody is looking at it is not calm.

### What this adapter is not

It is a Vite dev-server plugin. It is not a production server, has no
authentication, no display identity, no TLS story and no packaging. The
credential-isolation *shape* is the part worth keeping; the hosting is not.

## The ambient screen

`ambient.html` + `spikes/ambient.ts` + `spikes/ambient-model.ts` +
`spikes/ambient.css` + `spikes/quotes.ts`.

The split that matters: **`ambient.ts` is DOM and timers only.** Anything that
encodes a product rule lives in `ambient-model.ts`, where it can be asserted
without a browser. That is why `npm run test:ambient` can cover 47 behaviours
of a screen with no test browser involved.

Full detail in [05 — Ambient screen](05-ambient-screen.md).

## What does not exist

Stated plainly so nobody plans against it:

- No editor. No canvas authoring UI of any kind against the canonical model.
- No persistence. `npm run test:storage` is a *probe* that SQLite survives
  rollback, restart and backup/restore; it is not a storage layer.
- No HTTP API, no schema discovery endpoint, no agent interface.
- No authentication, no authorisation, no display pairing, no revocation.
- No publishing, drafts, revisions, loops or schedules.
- No container image, no install path, no upgrade path, no backup tooling.

## Planned direction

The roadmap under `.planning/ROADMAP.md` sequences the work: editor first, then
persistent drafts and immutable publication, then registered displays and
offline continuity, then loops and schedules, then calm ambient profiles, then
bounded live-data providers, then large-display and TV/kiosk validation, then
mobile and a standalone release boundary. Every one of those phases is
unstarted except the layout-representation work described above.
