# CommonHome Canvas

A privacy-first, self-hosted household display and dashboard system. Canvas is
intended to let a household compose calm screens — a photo wall in the living
room, an agenda in the kitchen, a status board in the hallway — and drive them
from hardware the household owns, with no account, no cloud tenancy and no
third party in the data path.

**Put another way: Canvas is self-hosted digital signage, scoped to a home.**
The problem is the same one signage software solves — compose a screen, put it
on a display, keep it current — and the architecture is the same: a server
that owns the content, and displays that render it. What differs is the
threat model. Commercial signage assumes a business that accepts a cloud
tenancy; a home screen shows who is out, what the family is doing tomorrow,
and photographs of children, so the content must not leave the building.

That framing also sets the honest limit. Canvas today drives **one** screen
well. The fleet layer that signage implies — multiple displays managed
centrally, scheduled rotation, playlists, remote updates — is designed but not
built. See the status table below.

Licence: **AGPL-3.0** (`LICENSE` is present in this repository).

---

## Status: prototype

This is an early prototype, not a product. Read this section before evaluating
anything else in the repository.

What exists today is two things:

1. **A tested, canonical document and layout model** in `src/canvas/`. This is
   the real core: the portable Canvas document schema, named density levels,
   declared block footprints and a pure, deterministic reflow function. It is
   covered by 50 passing tests, including property tests. It has **no UI, no
   editor and no persistence** — it is a model layer.

2. **Spikes** in `spikes/`. These are disposable experiments. `spikes/model.ts`
   states in its first line that it is "Disposable experiment semantics, not
   the product schema". The grid-engine comparison harness and the ambient
   screen both live here. The ambient screen is a working prototype that runs
   on a television; it is still a spike, and it does not use the canonical
   model in `src/canvas/`.

There is no editor, no server, no database, no authentication, no publishing,
no display pairing and no deployment story yet. Do not run this as a service
you depend on.

### Feature status

| Area | Status | Where |
|---|---|---|
| Canonical Canvas document schema (`apiVersion`/`kind`/`metadata`/`spec`) | **Working** | `src/canvas/types.ts`, `document.ts` |
| Load / validate / save with unknown-content round-tripping | **Working** | `src/canvas/document.ts` |
| Named density levels (6 / 12 / 24 columns) | **Working** | `src/canvas/density.ts` |
| Declared named block sizes per density, with a queryable picker set | **Working** | `src/canvas/sizes.ts` |
| Pure deterministic density reflow (Grid, AutoGrid, Rows, Tabs, unknown kinds) | **Working** | `src/canvas/reflow.ts` |
| Per-density local overrides, stripped from share exports | **Working** | `src/canvas/document.ts` |
| Property tests (round-trip, idempotence, containment, preservation) | **Working** | `src/canvas/*.test.ts` |
| Ambient photo screen with quote, weather and attribution | **Prototype (spike)** | `spikes/ambient*.ts`, `ambient.html` |
| Server-side adapter holding credentials, shaped snapshot endpoint | **Prototype (spike)** | `vite.ambient.config.ts` |
| Grid engine selected (GridStack 13.2.0) | **Decided, not integrated** | see `docs/01-architecture.md` |
| Interactive editor | **Planned** | — |
| Persistence, drafts, immutable publishing | **Planned** | — |
| Registered displays, pairing, offline continuity (the signage "player" layer) | **Planned** | — |
| Loops and schedules (signage "playlists" and dayparting) | **Planned** | — |
| Authentication, API surface | **Planned** | — |
| Packaging as a container / installable service | **Working** | `Dockerfile`, `docker-compose.yml`, `scripts/install.sh` |

"Working" here means: implemented in this repository and covered by tests you
can run yourself with the commands below. It does not mean production-ready.

---

## Why self-hosted and privacy-first

A household display is a shared surface. Everyone in the house sees it, and so
does every visitor. Two consequences shape the design, and both are already
visible in the prototype:

- **Credentials never reach the browser.** The ambient spike's server process
  holds the Home Assistant token and the photo-provider key, calls those APIs
  itself, and returns only the shaped fields the screen renders. The page never
  sees a token, an entity id or a raw upstream payload. See
  `vite.ambient.config.ts` and `docs/01-architecture.md`.
- **The snapshot endpoint is read-only by construction.** It issues GETs and
  exposes no way to call a service, so a compromised display cannot actuate
  anything in the house.

Documents are plain JSON, hand-editable and diffable. Unknown fields and
unknown block types written by a newer build survive a load/save cycle by an
older one, so a shared document does not rot. See
`docs/02-canvas-document-format.md`.

---

## Quickstart

Requires Node **26.8.1** (pinned in `package.json` `engines`). The project has
no runtime dependencies; everything in `devDependencies` is for the spikes and
the test harness.

```sh
npm ci --ignore-scripts
```

### Run the model tests

The canonical model needs no browser and no server:

```sh
npm run test:canvas
```

Expected: `pass 50`, `fail 0`.

### Run the grid comparison spike

```sh
npm run dev:spike
```

Then open `http://127.0.0.1:4173/?candidate=native&columns=12`. Use
`candidate=gridstack` or `candidate=rgl`, and optionally `columns=24`. Enter
**Edit layout** before moving or resizing. This is a comparison harness, not an
editor.

### Run the ambient screen spike

The ambient screen needs credentials supplied as environment variables, and it
needs its host allowlist edited (see `docs/05-ambient-screen.md`):

```sh
HA_URL=http://<your-home-assistant-host>:8123 \
HA_TOKEN=<token> \
UNSPLASH_ACCESS_KEY=<key> \
npx vite --config vite.ambient.config.ts
```

It listens on port 4174. Both credentials are optional in the sense that each
data source degrades independently — a missing photo key means no photo, not a
blank screen.

---

## npm scripts

Every script below exists in `package.json`. There is deliberately no generic
`dev` or `start` script, because there is no application to start yet.

| Script | What it does |
|---|---|
| `npm run dev:spike` | Vite dev server for the grid comparison harness on `127.0.0.1:4173`, strict port |
| `npm run build` | `node spikes/build.mjs` — builds the three grid candidates and records bundle sizes |
| `npm run build:ambient` | `node spikes/build-ambient.mjs` — production build of the ambient screen into `dist/ambient` |
| `npm run test:canvas` | `node --test src/canvas/` — the canonical model suite (50 tests) |
| `npm run test:ambient` | `node --test spikes/ambient-model.test.ts` — ambient product rules (47 tests) |
| `npm run test:model` | `node --test spikes/model.test.ts` — the spike model's own tests (4 tests) |
| `npm run test:storage` | `node --test spikes/storage.test.ts` — SQLite durability probe (1 test) |
| `npm run test:spike` | `playwright test tests/spike.spec.ts` — the browser matrix |

Note: `npm run build` rewrites files under `.planning/` that are recorded phase
evidence. If you run it, restore them with `git checkout -- .planning/`.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | How the pieces fit; the model/spike split; the server-side adapter boundary |
| [docs/02-canvas-document-format.md](docs/02-canvas-document-format.md) | The portable document schema, field by field |
| [docs/03-blocks-and-sizing.md](docs/03-blocks-and-sizing.md) | Blocks, declared named footprints, and why arbitrary resize is not offered |
| [docs/04-grid-density.md](docs/04-grid-density.md) | Named density levels and deterministic reflow |
| [docs/05-ambient-screen.md](docs/05-ambient-screen.md) | The working ambient display and its attribution obligations |
| [docs/06-development.md](docs/06-development.md) | Setup, scripts, the Playwright matrix, testing philosophy |
| [docs/07-design-principles.md](docs/07-design-principles.md) | Touch-first, calm defaults, determinism, attribution, accessibility |

Internal planning material lives under `.planning/` — roadmap, requirement IDs,
phase evidence and research notes. It is working material, not documentation.

---

## Licence

AGPL-3.0. See `LICENSE`.

The grid engine selected for the eventual editor, GridStack 13.2.0, is MIT with
no runtime dependencies, which imposes no transitive obligations on an AGPL
project.
