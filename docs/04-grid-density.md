# 04 — Grid density and reflow

Density is how many columns a canvas has. It is a property of the canvas, not
of the product — a television at three metres and a tablet at forty centimetres
do not want the same grid.

## Named levels, not a free integer

```ts
export const DENSITY = {comfortable: 6, standard: 12, dense: 24} as const;

export const DENSITY_LEVELS: readonly DensityLevel[] = [
  'comfortable',
  'standard',
  'dense',
];
```

| Level | Columns | Intended for |
|---|---|---|
| `comfortable` | 6 | wall display at distance; few, large blocks |
| `standard` | 12 | tablet, laptop; the default |
| `dense` | 24 | high-resolution display at desk distance |

The set is bounded and named rather than a free column count, for two reasons.

**Named levels keep a stored layout interpretable.** `authoredDensity:
"standard"` still means something in ten years; `columns: 12` means only what
its reader assumes.

**A bounded set keeps the design surface finite.** A block author has three
layouts to design against. A free-form column count multiplies that by infinity
and guarantees blocks that look wrong at some values.

`DENSITY_LEVELS` is ordered coarse-to-fine deliberately. The order is part of
the API: a "nearest known density" search needs a defined neighbour relation.

## Why the counts double

Each level is exactly double the previous one, and that is the whole reason
round-trip identity is achievable as an equality rather than an approximation.

```ts
export function scaleFactor(from: DensityLevel, to: DensityLevel): number {
  return DENSITY[to] / DENSITY[from];   // always a power of two
}
```

A block at column 4 in Standard(12) maps to column 8 in Dense(24), and to
column 2 in Comfortable(6). Every position maps cleanly in both directions, so
Standard → Dense → Standard returns the original layout exactly. Harmonically
unrelated counts — say 5, 9, 14 — would force rounding on every change, and
repeated rounding is exactly how layouts get quietly destroyed.

Odd *widths* are the remaining asymmetry: a 3-wide block in Standard is 1.5
cells in Comfortable. That is precisely why blocks declare named sizes rather
than arbitrary widths — reflow snaps to the nearest declared size for the
target density instead of inventing a fraction. See
[03 — Blocks and sizing](03-blocks-and-sizing.md).

Also note: a cell is meant to stay in a legible *physical* band. Density
changes how many cells exist, not how big a 4-wide block appears to a human eye
at the viewing distance. Density is chosen per display, in logical pixels, not
native ones.

## Reflow is a pure function

```ts
export function reflow(layout: Layout, target: DensityLevel, context?: ReflowContext): Layout
export function tryReflow(layout: Layout, target: DensityLevel, context?: ReflowContext): Result<Layout>
```

The contract, stated in the source:

> `reflow` is a PURE function: it reads nothing but its arguments, touches no
> clock, no randomness, no module-level mutable state and no I/O, and returns
> freshly built values so the caller cannot alias its way into the input.

`reflow` throws `UninterpretableLayout` for a layout that cannot be interpreted
at all — in practice a Grid with no `authoredDensity`. Callers holding
untrusted input should use `tryReflow`, which returns a `Result`.

`ReflowContext` supplies what reflow needs to learn a block's footprint:

```ts
export type ReflowContext = {
  elements: {[name: string]: Block};
  registry: SizeRegistry;
};
```

Supplying no context treats every item as a single cell, which is the right
degenerate answer for a caller that only cares about ordering.

### Reflow rewrites layout only

It reads `elements` to learn footprints and never writes to them. A container
reorders and rewrites nothing but its own children's layouts; it has no
business reaching into block configuration. The moment it needs to, purity and
the cheapness of per-density overrides are both gone.

## What reflow does, per kind

| Kind | Behaviour |
|---|---|
| `Grid` | Scale desired positions by the exact integer factor, sort into reading order, place each block at the first free spot that fits its footprint |
| `AutoGrid` | Rewrite `authoredDensity` and scale `maxColumnCount` by the same factor; items are carried through untouched because they hold no coordinates |
| `Rows` / `Tabs` | Reflow each child's layout in place; rebuild the child array by index so order is preserved by construction |
| Unknown kind | Returned as a clone, unchanged |

### Grid placement, in detail

1. Take the **canonical** layout — `layout.derivedFrom ?? layout` — never a
   projection (see below).
2. Reject if `authoredDensity` is missing or `items` is not an array.
3. If source density equals target, return the canonical record exactly, with
   `derivedFrom` deleted. This is what makes round-trip identity an equality.
4. Otherwise, for each item: resolve its footprint at the target density,
   clamp the width to the column count, and compute a desired column and row by
   scaling and flooring.
5. Sort by desired row, then desired column, then element name, then original
   index.
6. Walk the sorted list, placing each block at the first cell from its desired
   position (scanning in reading order) where its whole footprint fits.
7. Record the resolved `w`/`h` on the projection so a renderer need not
   re-resolve, and `snappedSize` when a snap occurred.

Rows are unbounded, so the scan always terminates; columns are not, which is
why the footprint is clamped to grid width first.

**The sort key is the determinism guarantee.** Element name is the final
tie-break because it is stable across runs and machines, where array index
would silently change meaning if a document were re-serialised in a different
order. Determinism matters more here than optimality: a rule that always
produces the same arrangement is one a family can learn, and one a property
test can pin down.

### AutoGrid, and what it does not touch

`maxColumnCount` is scaled and clamped:

```ts
projection.maxColumnCount = clamp(
  Math.max(1, Math.round(canonical.maxColumnCount * factor)),
  1,
  columnsFor(target),
);
```

An author who asked for "at most 3 across" at Comfortable(6) meant half the
width, and half the width at Dense(24) is 12.

`columnWidthMode` and `rowHeightMode` are deliberately **untouched**. They are
named, not numeric, precisely so that they mean the same thing at every
density; a reflow that rewrote them would reintroduce the raw-number problem
the names exist to avoid.

### Containers and failure propagation

A child whose nested layout fails to reflow fails the whole container: a layout
that cannot be interpreted is reported, never half-applied.

That is distinct from a child of an **unknown kind**, which reflows
successfully and unchanged, and therefore does not disturb its siblings. Both
behaviours are covered by tests.

## `derivedFrom`: never chain projections

A reflowed layout carries `derivedFrom`, pointing at the canonical it came
from. Reflow always re-derives from that canonical.

The reason is that scaling to a coarser density is lossy — two adjacent columns
merge into one — so chaining projections would degrade the layout a little on
every density change. That is exactly the drift the idempotence property exists
to forbid.

`derivedFrom` is in-memory only. `saveDocument` strips it at every depth. See
[02 — Canvas document format](02-canvas-document-format.md).

## Canonical plus overrides, in that order

Deterministic reflow and remembered per-density arrangements are not
alternatives. Canvas needs both, and the priority between them is the design
content:

1. **Canonical is authoritative.** `spec.layout` is the author's intent. Every
   other density is a pure projection of it.
2. **An override is remembered fiddling.** When a household moves a block while
   viewing a density, an override is recorded for that density. Entering that
   density prefers the override; entering an unseen one computes from
   canonical. `withOverride` returns a *new* document and never touches the
   canonical.
3. **Overrides never travel.** `toShareable` omits `local` entirely.

```ts
const {layout, source} = layoutFor(doc, 'dense', contextFor(doc, registry));
// source is 'override' or 'computed'
```

Because an override is written when the user moves something, "has this density
been seen?" and "is there an override?" are the same question — which is why
Canvas needs no separate visited-resolutions bookkeeping.

## The lessons this design is built on

The design is a direct response to a well-documented failure in a mature
desktop environment, whose "my desktop got scrambled" bug class ran from 2015
to a 2022 fix, with 18 duplicates on one report and 26 duplicates and 82
subscribers on a related one. Four rules came out of studying it, and all four
are implemented:

**1. Never store pixels. Never store a bare index. Always store the frame of
reference.** That environment's desktop widgets stored absolute
device-independent pixel rectangles, and its file icons stored `(stripe,
position)` indices with *no record of the column count*, so changing resolution
— or icon size, or even panel height — re-wrapped every icon into a different
cell. The eventual fix put the grid dimensions inside the record. Canvas's
`authoredDensity` is that header, learned in advance, and a layout without it
is rejected rather than guessed at.

**2. Reflow must be pure.** That environment layered on 100ms coalescing
timers, sequencing guards, a relayout lock because size and available-area
updates "are updated not atomically", and suppression of all saving until
startup completed. Every one of those is compensation for impurity. Canvas's
reflow needs none of that machinery because it depends on nothing outside its
arguments.

**3. Property-test reflow, not just examples.** Round-trip identity and
idempotence are the two properties whose absence lets layouts drift a little on
every change until they are ruined.

**4. Never key persistent layout on anything volatile.** That environment
persisted a mapping from display connector names to screen ids; connector names
change across display servers, docks and driver versions, and the stored table
drifted from reality until widgets rebound to the wrong screen. The fix deleted
the concept and recomputed from an authoritative list every time. Canvas has
the same trap available — display hostnames, addresses, browser profile paths —
and the rule is: a canvas belongs to a canvas id, and a display *references*
it, never the reverse.

A fifth observation shaped the layout tree: that environment's *panels* never
scrambled, because they stored only an ordered applet list. An ordered list has
nothing to scramble. Canvas's `Rows` and `Tabs` kinds are reflow-safe for the
same reason, for free.

## The properties, as tested

From `npm run test:canvas` (50 tests, all passing):

```
✔ property: every block sits inside the target density column count
✔ property: reflow never adds, drops, renames or reorders elements
✔ property: a reflowed layout records the density it was reflowed to
✔ property: chaining densities agrees with going there directly
✔ an unrecognised layout kind passes through reflow unchanged
✔ a Grid layout without authoredDensity is rejected, never guessed at
✔ reflow to an unknown density is rejected
✔ a size not offered at the target density snaps to a declared one
```

The property tests sweep 120 fixed seeds through a hand-rolled deterministic
PRNG (mulberry32) rather than taking a property-testing dependency. The project
has no runtime dependencies, and a seeded generator plus a fixed seed sweep is
enough to make failures reproducible — which is the property that actually
matters. Generators live in `src/canvas/testing.ts` and are test support, not
product code.

Nested trees are generated too, with a forced minimum depth so that a container
inside a container is routinely exercised rather than merely possible, and with
a configurable chance of injecting an unknown layout kind so the "unknown
nested kind does not stop its siblings reflowing" property is swept rather than
covered only by hand-written examples.

## Planned

- Density overrides and the editor's planned orientation overrides must
  converge on **one** mechanism when the editor is wired up, not two.
- Whether an unseen density seeds from canonical or from the nearest known
  density is undecided. Today it seeds from canonical.
- Whether a top bar's height scales with density is undecided.
