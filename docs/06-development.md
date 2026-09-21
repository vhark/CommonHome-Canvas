# 06 — Development

## Requirements

| Requirement | Version |
|---|---|
| Node | **26.8.1** (pinned in `package.json` `engines`) |
| Runtime dependencies | none |

Everything in `devDependencies` serves the spikes and the test harness:

```json
"devDependencies": {
  "gridstack": "13.2.0",
  "react-grid-layout": "2.2.4",
  "react": "19.2.8",
  "react-dom": "19.2.8",
  "vite": "8.2.2",
  "@playwright/test": "1.63.0",
  "@axe-core/playwright": "4.13.0"
}
```

React and React Grid Layout are present only because the grid comparison spike
builds all three candidates. Neither is part of the product direction.

## Setup

```sh
npm ci --ignore-scripts
```

`--ignore-scripts` is deliberate: Playwright's browser download is a separate,
explicit step rather than an install side effect.

For the browser matrix:

```sh
npx --no-install playwright install chromium firefox webkit
```

WebKit additionally requires host system libraries (GTK4, Graphene, libevent,
several GStreamer packages). Installing OS packages is a separate permission
from downloading browsers, and this project treats it as a decision rather than
a chore. Without them, WebKit projects fail at browser launch — correctly, and
loudly.

## The scripts

Every script below exists in `package.json`. There is **no** `dev`, `start`,
`lint`, `typecheck` or aggregate `test` script.

### `npm run test:canvas`

```sh
node --test src/canvas/
```

The canonical model suite — the one that matters. **50 tests**, no browser, no
server, runs in a few seconds.

| File | Tests | Covers |
|---|---|---|
| `density.test.ts` | 3 | level names, column counts, scale factors |
| `sizes.test.ts` | 9 | declaration validation, picker contents, snapping and tie-breaks |
| `reflow.test.ts` | 12 | purity, containment, preservation, unknown kinds, chaining |
| `document.test.ts` | 10 | load/validate/save, round-tripping, overrides, share |
| `nesting.test.ts` | 16 | Rows/Tabs/AutoGrid, properties across nesting depth |

### `npm run test:ambient`

```sh
node --test spikes/ambient-model.test.ts
```

**47 tests** over the ambient screen's product rules — condition mapping, focal
slot precedence, health disclosure, attribution shortening, credit wording, and
the quote library's attribution and determinism. No browser: the rules were
deliberately split out of the DOM code so they could be asserted directly.

### `npm run test:model`

```sh
node --test spikes/model.test.ts
```

**4 tests** over the *spike's* disposable document shape. Not the product
model. These go away with the spike.

### `npm run test:storage`

```sh
node --test spikes/storage.test.ts
```

**1 test.** A durability probe, not a storage layer: it asserts that a SQLite
file written through `node:sqlite` `DatabaseSync` survives transaction
rollback, a process restart and a backup/restore cycle, including a value
containing a SQL-injection-shaped string. It exists to check that the standard
library's SQLite is a credible persistence candidate before anything is built
on it.

### `npm run test:spike`

```sh
playwright test tests/spike.spec.ts
```

The browser matrix. Playwright starts its own dev server via the `webServer`
config (`reuseExistingServer: false`), so **stop any manually started server on
port 4173 first** or the run fails to start.

### `npm run build`

```sh
node spikes/build.mjs
```

Builds the three grid candidates independently — one build per candidate, so
the other engines are removed rather than hidden in a shared chunk — and writes
a bundle-size report.

**This writes into `.planning/` by default**, over recorded phase evidence.
Either redirect it:

```sh
SPIKE_EVIDENCE=/tmp/canvas-bundles npm run build
```

or restore afterwards:

```sh
git checkout -- .planning/
```

`SPIKE_REPORT` does the same job for the Playwright JSON reporter.

### `npm run build:ambient`

```sh
node spikes/build-ambient.mjs
```

Production build of `ambient.html` into `dist/ambient`. It exists so the
ambient sources get real compile coverage — `npm run build` builds only the
three grid candidates and never touches `ambient.html`, so without this the
ambient sources would be verified by nothing but a dev server having served
them once.

### `npm run dev:spike`

```sh
vite --host 127.0.0.1 --port 4173 --strictPort
```

Loopback only, strict port. The config also enforces a Host and Origin
allowlist, rejects non-loopback origins with 403, blocks `/.planning`, `/.git`
and `/.hermes`, caps request bodies at 64 KiB, requires
`Content-Type: application/json`, and validates every field of the experiment
payload with exact-key checks and integer bounds. That is more hardening than a
throwaway harness needs; it is there because the harness was briefly served
beyond loopback for a hands-on comparison.

## The Playwright project matrix

`playwright.config.ts` defines seven projects. `workers: 1`, `retries: 0`,
`timeout: 120000`, `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`.

| Project | Engine | Viewport | DPR | Touch |
|---|---|---|---|---|
| `chromium-reference` | Chromium | 1920 × 1080 | 1 | no |
| `firefox-reference` | Firefox | 1920 × 1080 | 1 | no |
| `webkit-reference` | WebKit | 1920 × 1080 | 1 | no |
| `chromium-tablet` | Chromium | 1024 × 768 | 2 | yes |
| `webkit-tablet` | WebKit | 1024 × 768 | 2 | yes |
| `webkit-phone-landscape` | WebKit | 832 × 384 | 3 | yes |
| `webkit-phone-portrait` | WebKit | 384 × 832 | 3 | yes |

The three reference projects establish cross-engine behaviour at a common
large-display size. The two tablet projects add a coarse pointer and DPR 2.

The two phone projects exist because **real hardware found a coverage gap the
matrix could not have produced itself.** A real phone reported 832 × 384 CSS
pixels in landscape at DPR 3. Every other project is DPR 1 or 2 and at least
768 tall, so that viewport sat entirely outside the matrix. WebKit is used
because every browser on that platform is required to use it.

## Known and accepted failures

Two, both recorded rather than hidden.

### 1. The phone projects fail — harness chrome, not engine behaviour

Adding the phone projects produced 19 failures, all with one cause. Measured
directly at 832 × 384:

```
viewport             : 832x384
canvas top           : 476px      <- below the fold
canvas visible height: -92px      <- entirely off screen
items in DOM         : 1          (rendered, just not reachable)
document height      : 876px
```

**The comparison harness's own debug toolbar is taller than the phone
viewport.** Above the canvas sit a title, a subtitle, three engine links, a
Finish editing button, a Preview button, a fixture picker, an authored-target
picker, Create/Reset override buttons and nine layout-nudge buttons — 476 px of
chrome. Every failure is downstream of that: a drag never reaches a visible
block, and assertions time out polling a canvas that is off screen.

None of that toolbar is product. It exists so three engines can be compared
side by side, and the real editor is required to enter Edit mode deliberately
rather than showing nudge buttons permanently.

So the phone projects are **not evidence about the grid engine at a phone
size.** They are evidence that the comparison harness was built for a desktop
window. The projects were deliberately *not* deleted: they stay in the config,
failing loudly, so the gap stays visible rather than being forgotten.

### 2. One genuine engine divergence, in the rejected candidate

```
rgl mouse move and resize uses candidate engine   [webkit-tablet]
  Expected: 0
  Received: 12
```

After a bottom-edge resize the page must not have scrolled. On WebKit at tablet
size, with React Grid Layout, it scrolls 12 px. It reproduces in isolation, and
it is scoped:

| Project | Result |
|---|---|
| `chromium-tablet` | passed |
| `chromium-reference` | passed |
| `webkit-tablet` | **failed (scrollY 12)** |

WebKit-only, RGL-only, tablet-only. **Deliberately not fixed.** React Grid
Layout lost the engine comparison and is not the product's grid; fixing an
engine-specific scroll fault in a rejected candidate would be effort spent on
code scheduled for removal. It is recorded so a future run seeing
`84 passed, 1 failed` recognises a known, scoped, accepted failure rather than
a regression — and so nobody mistakes it for a fault in the chosen engine.

The equivalent fault *was* fixed in the chosen engine, and the fix was verified
to hold on WebKit.

### An operational constraint worth knowing

The suite cannot currently run two browser projects in parallel on a shared
host without timeouts. Four failures that looked like a genuine WebKit
incompatibility all passed when the suite was re-run serially:

```
$ npx playwright test tests/spike.spec.ts --project=webkit-reference --workers=1
  17 passed (5.4m)
```

A test that passes alone in 5.5 seconds and times out at 120 seconds under
parallel load is reporting contention, not an engine divergence. **WebKit
projects need `--workers=1`, or the projects need running separately.** A run
that goes green in parallel is more likely to mean the host was quiet than that
something was fixed.

The lesson generalises: a consistent failure is evidence of a consistent
*cause*, which is not the same as evidence of the cause you first suspect.

## Testing philosophy

### Reproduce before you fix

A defect is not understood until it has been reproduced deliberately. Four
failures in the run above were written up as a WebKit incompatibility on the
strength of their consistency; a serial re-run disproved that. The interim
wrong conclusion is kept in the record rather than quietly corrected, because
the correction is the useful part.

### Fails-without, passes-with

A fix must be demonstrated against a test that failed before it and passes
after it, with both runs recorded. The chosen engine's edge-autoscroll defect
was fixed that way. A fix without a failing test first is an assertion, not
evidence.

### Property tests over examples for anything with an algebra

Reflow has properties — round-trip identity, idempotence, containment,
element preservation, order stability — and properties are what examples cannot
establish. The generators sweep 120 fixed seeds through a hand-rolled
mulberry32 PRNG rather than taking a property-testing dependency:

> the project has no runtime dependencies and a seeded PRNG plus a shrink-free
> sweep over fixed seeds is enough to make the failures reproducible, which is
> the property that actually matters here

Nested-tree generation forces a minimum depth so that a container inside a
container is routinely exercised rather than merely possible, and injects
unknown layout kinds at a configurable rate so the "unknown nested kind does
not stop its siblings reflowing" property is swept rather than hand-written.

### Emulation supplements real devices; it does not replace them

A browser at a tablet viewport with `hasTouch: true` is not a tablet. The
findings that changed the design — a 33% miss rate on a 16-pixel resize grip,
`hover capable: false`, and a viewport outside the entire matrix — all came
from real hardware and none could have come from emulation. Real-device
evidence is a gate, not a nice-to-have.

### Test the rules, not the DOM, where you can

The ambient screen's product rules were deliberately split out of the file that
touches the DOM and starts timers. That is why 47 behaviours of a wall display
can be asserted in 0.3 seconds with no browser involved. Anything that encodes
a rule belongs where it can be asserted directly.

### State what is not verified

Documents in this repository routinely carry a "what this does not settle"
section. Latency figures from a shared host are observations, not benchmarks,
and are labelled as such. WebKit on Linux catches engine-level divergence but
is not the same as a real device from that vendor, and that is said out loud
rather than glossed.

## Repository layout

```
src/canvas/            the canonical model — production code
  *.test.ts            its tests
  testing.ts           deterministic generators (test support, not shipped)
spikes/                disposable experiments
  ambient*.ts/.css     the ambient screen prototype
  quotes.ts            the built-in quote library
  candidates.ts        the engine comparison harness
  gridstack/native/rgl adapters, one per candidate
  model.ts             the spike's own throwaway document shape
  storage.test.ts      SQLite durability probe
  build*.mjs           build scripts
tests/                 Playwright specs
docs/                  this documentation
.planning/             roadmap, requirements, phase evidence, research notes
ambient.html           the ambient composition
index.html             the comparison harness entry point
vite.config.ts         comparison harness server (loopback only)
vite.ambient.config.ts ambient adapter server (credentials, snapshot endpoint)
playwright.config.ts   the project matrix
```

## Contributing

- Source files do not yet carry an AGPL notice. `LICENSE` is present.
- Contributions are intended to be DCO-signed without a CLA.
- Prefer platform features and the standard library before adding a
  dependency. The model layer has zero runtime dependencies and that is a
  property worth keeping.
- Do not document a capability that does not exist. Mark planned work as
  planned.
