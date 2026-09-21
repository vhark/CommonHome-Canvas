# 03 — Blocks and sizing

## A placeable element is a Block

Canvas calls the thing you place on a screen a **Block**. Clock, weather,
photo, quote, agenda — all Blocks.

"Widget" is deliberately reserved, and is not a synonym. In Canvas vocabulary
a widget is **pasted third-party HTML and JavaScript**: the untrusted category,
which deserves a name of its own so nobody confuses the two. The source says so
directly:

```ts
/* A placeable element is a Block. "Widget" is reserved for third-party embed
 * code and must not leak into this vocabulary. */
export type Block = {
  type: string;
  namedSize: string;
  [key: string]: unknown;
};
```

No widget support exists today. The name is being kept clear in advance.

## Declared named footprints, not free resize

A block type declares a **bounded set of named sizes**. A block instance names
one of them. There is no free resize anywhere in this API.

The model is a mobile home-screen launcher rather than a free canvas. A
weather block might offer "Now", "Today" and "Full forecast"; you pick the one
that fits the space and the amount of information you want, and the block jumps
between legal footprints rather than stretching.

### Why this is better than arbitrary resize

**Free resize makes the author responsible for legibility.** Drag a weather
block to a 2×1 and it is now the author's problem that the forecast no longer
fits. Every size then has to degrade gracefully, which in practice means one
layout stretched until it looks wrong.

**Named sizes make legibility the block's responsibility.** Each size is
separately designed. A 1×1 weather block is not a squashed 4×3 — it is a
different composition showing different information: an icon and a temperature,
full stop.

Three consequences follow, and all three are implemented:

1. **The resize affordance is a picker, not a drag.** `declaredSizes()` returns
   exactly the names a type offers at a given density, and that set is what the
   picker lists. This also helps enormously on touch: a picker is a list of tap
   targets, not a 16-pixel corner grip. See
   [07 — Design principles](07-design-principles.md) for the measured evidence
   that a 16px grip is not good enough.
2. **An unsupported size is simply not offered.** A block can never be placed
   at a size it was not designed for, which kills the whole class of "it looks
   broken at this size" bugs before it exists.
3. **An undeclared size is rejected, not corrected.** `resolveCells` returns a
   structured `undeclared_size` error naming what the type *does* declare. A
   silent correction is indistinguishable, from the author's seat, from the
   editor losing their work.

## Declaring a block type

```ts
export type NamedSize = {
  name: string;
  cells: {[level: string]: Cells};   // Cells = {w, h}
};

export type BlockTypeSpec = {
  type: string;
  sizes: NamedSize[];
};
```

A real declaration, from the test catalogue in `src/canvas/testing.ts`:

```ts
{
  type: 'forecast',
  sizes: [
    {name: 'compact', cells: {standard: {w: 3, h: 2}, dense: {w: 6, h: 4}}},
    {name: 'full',    cells: {standard: {w: 6, h: 3}, dense: {w: 12, h: 6}}},
    {name: 'tiny',    cells: {comfortable: {w: 2, h: 2}, standard: {w: 4, h: 4}, dense: {w: 8, h: 8}}},
  ],
}
```

Note what `compact` and `full` do **not** have: a `comfortable` entry. A
density may be omitted, and omission means *this type declines to be offered at
that density*. A full forecast has no legible form in six columns, so it simply
does not appear in the picker there. Declining to offer is simpler than
refusing a placement, and it is sufficient.

## Footprints are stated per density, not derived

Each size states its cells at each density explicitly rather than being scaled
by arithmetic. There are two reasons.

**Derived units drift.** A desktop environment derived its base grid unit from
font metrics to achieve density independence, found it unstable enough that
current source hardcodes the value, and its own documentation still describes
the font-derived behaviour. Three sources disagreeing is the cost of a derived
quantity. An explicit number per level cannot drift when somebody changes a
font.

**Halving is not always an integer.** A size that is 3 cells wide at Standard
would be 1.5 at Comfortable. Stating what it *is* at Comfortable answers that
by construction instead of inviting anyone to invent a fraction.

## Validation rules

`validateBlockType` and `buildRegistry` enforce the following, each with a
distinct error code:

| Code | Condition |
|---|---|
| `invalid_block_type` | `type` missing or empty |
| `no_declared_sizes` | `sizes` is not a non-empty array |
| `invalid_size_name` | a size has no name |
| `duplicate_size_name` | a type declares the same size name twice |
| `duplicate_block_type` | a registry is built with the same type twice |
| `invalid_size_cells` | `w` or `h` is not a positive whole number |
| `size_exceeds_density` | a footprint is wider than its own grid has columns |
| `size_offered_nowhere` | a size declares no density at all |

`size_exceeds_density` is worth calling out. A footprint wider than its own
grid can never be placed in bounds, so it is a *declaration* error caught at
registry build time rather than a placement error discovered later by a user.

## Querying the registry

```ts
// The picker's contents: the sizes this type offers, at this density.
declaredSizes(registry, 'forecast', 'comfortable')  // -> ['tiny']
declaredSizes(registry, 'forecast')                 // -> ['compact', 'full', 'tiny']

isDeclaredSize(registry, 'forecast', 'full')        // -> true

resolveCells(registry, 'forecast', 'full', 'dense') // -> {ok: true, value: {w: 12, h: 6}}
resolveCells(registry, 'forecast', 'full', 'comfortable')
// -> {ok: false, error: {code: 'size_not_offered_at_density', ...}}
```

The declared set being queryable is what moves the question "is this legible at
this size?" from the author to the block author, where it can actually be
answered.

## Snapping: when arithmetic lands between declared sizes

Named sizes declare their cells per density, so the usual case is a lookup and
nothing fractional can arise. The fractional case appears only when a type does
not offer its current size at the target density. Then the arithmetic result is
treated as a *desired* footprint and `nearestDeclaredSize` lands on one the type
actually declares.

The tie-break rules are fixed, documented in the source, and property-tested:

```
distance = (|Δwidth|, |Δheight|, area)   compared lexicographically
```

- **Width first**, because the column count is the bounded axis and a wrong
  width is what pushes neighbours out of the grid.
- **Then height.**
- **Ties break toward the smaller size** (area as the third key). A block that
  shrinks can only free space; one that grows can displace a neighbour. A
  stable rule matters more here than an optimal one.
- **Remaining ties break on declaration order**, which is stable across runs
  and machines because it comes from the type's own declaration rather than
  from iteration over a hash.

If a type offers nothing at all at the target density, `nearestDeclaredSize`
returns `no_size_at_density` rather than inventing something.

When reflow snaps a block, the projection records it:

```json
{"element": "el-b0", "col": 0, "row": 2, "w": 2, "h": 2, "snappedSize": "tiny"}
```

`snappedSize` appears only on the projection. It is never written back to the
element — content is not reflow's to rewrite.

## Unknown types and missing context

Reflow degrades rather than dropping:

| Situation | Footprint used |
|---|---|
| No `ReflowContext` supplied | one cell (correct degenerate answer for a caller that only cares about ordering) |
| Element name not found in `elements` | one cell |
| Block type not in the registry | one cell |
| Size not declared at source density either | one cell |

An unknown block keeps a single-cell slot rather than being dropped. An unknown
block must survive, placeholder and all.

## The starter block set

This is **planned design direction**, not an implemented catalogue. No
first-party blocks exist yet; the types used in the tests are fixtures. The
intended initial set, with intended sizes:

| Block | Sizes | Notes |
|---|---|---|
| Photo | 1×1, 2×2, 4×3, full-bleed | stills and GIF; full-bleed is the ambient background |
| Quote | 2×1, 4×1, 4×2 | built-in library; household additions later |
| Clock | 1×1, 2×1, 4×2 | 4×2 is the large ambient clock |
| Weather | 1×1, 4×1, 4×3 | 4×3 is the full forecast |
| Sticky note | 1×1, 2×2 | free text |
| Checklist | 2×2, 4×3 | |
| Whiteboard | 4×3, full | drawing surface |
| Calendar | 4×1 (up next), 4×3 (agenda) | |

## Open design questions

Recorded here because they are genuinely unresolved, not because they are
nearly done:

- **Does a block get to refuse a resize, or only to offer sizes?** Offering is
  simpler and probably sufficient; that is what is implemented.
- **Attribution at small sizes.** A 1×1 weather block has no room for a data
  credit and must not pretend otherwise. Whether the obligation is satisfied
  once per screen or per block is a licence question, not a layout preference.
  See [05](05-ambient-screen.md) for how the ambient prototype handles
  attribution today.
