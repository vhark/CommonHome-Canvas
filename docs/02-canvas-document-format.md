# 02 — The Canvas document format

A Canvas document is plain JSON. It is meant to be readable, diffable and
hand-editable, and to survive being opened by software older or newer than the
software that wrote it.

The schema lives in `src/canvas/types.ts`; load, validate and save live in
`src/canvas/document.ts`. Both are implemented and tested today.

## A complete minimal document

```json
{
  "apiVersion": "canvas.commonhome/v1alpha1",
  "kind": "Canvas",
  "metadata": {
    "uid": "kitchen-wall"
  },
  "spec": {
    "elements": {
      "el-a0": {"type": "clock", "namedSize": "medium"},
      "el-b0": {"type": "forecast", "namedSize": "compact"}
    },
    "layout": {
      "kind": "Grid",
      "authoredDensity": "standard",
      "items": [
        {"element": "el-a0", "col": 0, "row": 0},
        {"element": "el-b0", "col": 4, "row": 0}
      ]
    }
  }
}
```

That is the whole required surface. `local` is optional and absent unless the
household has moved something.

## The envelope

```json
{
  "apiVersion": "canvas.commonhome/v1alpha1",
  "kind": "Canvas"
}
```

Both constants are exported as `API_VERSION` and `KIND`. `validateDocument`
rejects anything else with `unsupported_api_version` or `unsupported_kind`.

The envelope is a string plus a kind rather than an integer schema version, and
the reason is recorded in the source. A widely deployed commercial dashboard
product froze its integer `schemaVersion` at 42 with the source comment "DO NOT
increment this number", because a monotonic integer cannot be branched and they
needed a second, parallel schema; escaping it required moving to a whole new
resource envelope.

That is the general portability lesson Canvas takes from a decade of a mature
dashboard system's schema evolution: a single monotonic integer is a one-way
door. An `apiVersion` string can branch. Starting with a branchable identifier
costs nothing now.

`v1alpha1` is honest about maturity. Expect it to change.

## `metadata`

```json
"metadata": {"uid": "kitchen-wall"}
```

`uid` is required and must be a non-empty string. It is the *portable*
identifier — it survives a document being shared between households. Any
instance-local numeric key is deliberately kept elsewhere and never travels in
the document. The record carries an index signature, so additional metadata
fields written by a newer build are preserved.

## `spec.elements` — what a block *is*

```json
"elements": {
  "el-a0": {"type": "clock", "namedSize": "medium"}
}
```

A map from a stable name to a `Block`. Two fields are required on every
element, even when the reading build recognises neither:

| Field | Required | Meaning |
|---|---|---|
| `type` | yes, non-empty string | The block type, e.g. `clock`, `forecast` |
| `namedSize` | yes, non-empty string | One of the sizes that type declares |

They are required precisely so that an *unknown* block can still be rendered as
a labelled placeholder in a correctly sized slot rather than vanishing. A block
you cannot draw is still a block whose space you must reserve.

Anything else on the element is carried through untouched. `Block` has an index
signature for exactly this reason.

## `spec.layout` — where a block *sits*

Content and layout are separate, and the separation is load-bearing:

- `elements` holds what a block **is**, keyed by a stable name.
- `layout` holds where it **sits** and references elements by that name.

Because of that split, density reflow rewrites layout alone and can never
disturb block content, and a per-density override is simply an alternate layout
over identical elements rather than a bolted-on position cache. Named element
keys also avoid the id-collision problem that numeric per-document panel ids
create when two documents are merged.

Layout is a tagged, pluggable tree. Every node declares a `kind`.

### `Grid`

```json
{
  "kind": "Grid",
  "authoredDensity": "standard",
  "items": [
    {"element": "el-a0", "col": 0, "row": 0}
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | `"Grid"` |
| `authoredDensity` | yes | One of `comfortable`, `standard`, `dense` |
| `items[].element` | yes | Non-empty element name |
| `items[].col`, `items[].row` | yes | Whole, non-negative numbers |
| `derivedFrom` | no | In-memory only; see below |

`authoredDensity` is the non-negotiable field. A layout that lacks it is
rejected with `missing_authored_density` rather than guessed at. The source
explains why at length: a desktop environment once stored icon positions as
bare `(stripe, position)` indices with no record of the column count, so every
resolution change re-wrapped every icon. That bug took from 2015 to 2022 to
fix, with 18 duplicate reports. **A layout without its frame of reference is
uninterpretable**, and Canvas refuses to guess.

Items carry an index signature too; `w`, `h` and `snappedSize` appear on a
reflowed projection (see [04](04-grid-density.md)) and any other field a newer
build writes is preserved.

### `AutoGrid`

The layout places its own items, in order, so items carry no coordinates.

```json
{
  "kind": "AutoGrid",
  "authoredDensity": "standard",
  "maxColumnCount": 3,
  "columnWidthMode": "wide",
  "rowHeightMode": "standard",
  "items": [{"element": "el-a0"}]
}
```

| Field | Required | Validated against |
|---|---|---|
| `authoredDensity` | yes | the three density levels |
| `items[].element` | yes | non-empty string |
| `maxColumnCount` | no | whole non-negative number |
| `columnWidthMode` | no | `narrow` / `standard` / `wide` |
| `rowHeightMode` | no | `short` / `standard` / `tall` |

`maxColumnCount` needs `authoredDensity` for the same reason a Grid's
coordinates do: `maxColumnCount: 3` is meaningless without knowing which grid
those columns were counted in.

The width and height modes are **named, not numeric**, and that is the point.
A stored `columnWidth: 7` means only what its reader assumes; `wide` still
means something in ten years and is the same instruction at every density. This
is the same conclusion a mature dashboard product reached after roughly a
decade of users typing raw integers into a 24-column grid. Canvas starts where
they ended up.

### `Rows` and `Tabs`

```json
{
  "kind": "Rows",
  "children": [
    {"id": "row-top", "layout": {"kind": "Grid", "authoredDensity": "standard", "items": []}},
    {"id": "row-main", "layout": {"kind": "Grid", "authoredDensity": "standard", "items": []}}
  ]
}
```

Rows and Tabs differ only in presentation; as records they are the same thing —
an ordered list of nested layouts. They therefore share the `children` key
rather than each naming its own, so traversal, validation and the ordering
guarantee are implemented once.

The ordering guarantee is these kinds' entire value: **an ordered list has
nothing to scramble.** That is why a desktop environment's panels, which stored
only an applet order, never suffered the reflow bugs its coordinate-storing
desktop did. A top bar, in Canvas terms, is a `Rows` layout with one row — not
a special-cased chrome component.

`children[].id` is required and must be a non-empty string. It gives the
eventual UI a key that survives reordering, and it makes order stability
assertable against something other than array position.

### Unknown kinds

A layout node whose `kind` this build has never heard of is carried opaquely:

```json
{
  "kind": "Carousel",
  "intervalSeconds": 30,
  "slides": [{"title": "slide-0", "layout": {"kind": "Grid", "authoredDensity": "standard", "items": []}}]
}
```

`validateLayout` returns it unchanged. `tryReflow` returns a clone of it
unchanged. Nothing inside it is interpreted — not even a `Grid` nested within
it, because an unknown container's internals are not this build's to touch.

A `Rows` or `Tabs` node with no `children` array at all is also treated as
opaque, on the same principle: the tag alone does not promise this build's
shape. Once there *is* a `children` array, it is validated in full and
recursively, because at that point the document is claiming a shape this build
will act on.

## `local` — household state that does not travel

```json
"local": {
  "densityOverrides": {
    "comfortable": {"kind": "Grid", "authoredDensity": "comfortable", "items": []}
  }
}
```

An override records one household's fiddling, on one screen, at one density. It
is preferred when re-entering that density and never modifies the canonical
layout other densities reflow from.

Overrides live *inside* the document rather than in a side store for a specific
reason: the export path must be able to strip them reliably, and a side store
cannot be stripped by a document-shaped operation. They sit in a single
clearly delimited section so that Share is an **allowlist** — emit
`apiVersion`, `kind`, `metadata`, `spec` — rather than a growing list of fields
somebody has to remember to remove.

```ts
export function toShareable(doc: CanvasDocument): CanvasDocument {
  const {local: _local, ...rest} = structuredClone(stripDerived(doc));
  return rest as CanvasDocument;
}
```

So: **a shared or exported template carries the canonical layout only.**
Shipping an override would make a template render differently for the recipient
than it did for the author, which is precisely what makes shared templates
untrustworthy. A recipient gets the author's intent, reflowed for their own
display — and that only works because reflow is a pure function of the
canonical layout.

`local` must be *absent* rather than empty when there is nothing in it, or a
document that has never been fiddled with would not round-trip byte-stably
against a hand-written file. `withoutOverride` prunes empty maps and then the
empty `local` itself.

## `derivedFrom` is in-memory only

A reflowed layout is a *projection*. It remembers the canonical it came from:

```ts
derivedFrom?: GridLayout;
```

Reflow always re-derives from the canonical, never from a projection. Scaling
to a coarser density is lossy — column 3 at Standard is 1.5 at Comfortable — so
chaining projections would degrade a layout a little on every density change.
Re-deriving is what makes idempotence hold instead of drifting.

`saveDocument` strips `derivedFrom` before serialising, at every depth,
including inside nested containers and inside `local.densityOverrides`:

> `derivedFrom` is an in-memory aid for reflow and must never reach the file:
> persisting a projection's origin alongside it invites a later reader to treat
> the projection as canonical.

If you see `derivedFrom` in a file on disk, something wrote JSON without going
through `saveDocument`.

## Round-tripping unknown content

The governing rule in `document.ts`:

> Nothing is dropped. A document written by a newer build — an unknown block
> type, an unknown field on a known block, an unknown layout kind — must come
> back out of `saveDocument` exactly as it went in.

Validation therefore refuses only what is **uninterpretable**, never what is
merely **unrecognised**. Concretely:

| Situation | Behaviour |
|---|---|
| Unknown block `type` | preserved; renders as a labelled placeholder (renderer is planned) |
| Unknown field on a known block | preserved |
| Unknown layout `kind` | preserved, and reflowed through unchanged |
| Unknown field on a known layout | preserved |
| Unknown field in `metadata` or `local` | preserved |
| Missing `metadata.uid` | rejected: `missing_uid` |
| Missing `type` or `namedSize` on an element | rejected: `missing_element_type` / `missing_named_size` |
| `Grid` or `AutoGrid` without `authoredDensity` | rejected: `missing_authored_density` |
| `apiVersion` or `kind` mismatch | rejected |
| Non-JSON input | rejected: `invalid_json` |

Dropping unknown content is how a shared template becomes untrustworthy, and it
is the one decision that determines whether old documents survive new versions.
The comparable mature system solves this by substituting a placeholder plugin
that preserves the unknown panel's position, id, title and untouched JSON, so
the document round-trips. Canvas takes the same position and enforces it at the
schema level through index signatures plus a validator that only refuses the
uninterpretable.

## Errors

Every fallible function returns a `Result`, never a thrown error and never a
silent correction:

```ts
export type CanvasError = {code: string; message: string; path?: string};
export type Result<T> = {ok: true; value: T} | {ok: false; error: CanvasError};
```

`path` is a JSON path into the offending document, e.g.
`spec.layout.items[3].element`. A silent correction is indistinguishable, from
the author's seat, from the editor losing their work — so Canvas reports rather
than repairs.

## Public API

Everything a caller outside `src/canvas/` needs is re-exported from
`src/canvas/index.ts`:

| Function | Purpose |
|---|---|
| `loadDocument(text)` | Parse and validate JSON into a `CanvasDocument` |
| `validateDocument(value)` | Validate an already-parsed value |
| `validateLayout(value, path)` | Validate a layout subtree |
| `saveDocument(doc)` | Serialise, stripping `derivedFrom` |
| `toShareable(doc)` | Canonical only; `local` omitted |
| `layoutFor(doc, density, ctx?)` | The layout to render, plus whether it came from an override or was computed |
| `withOverride(doc, density, layout)` | Return a new document with an override recorded |
| `withoutOverride(doc, density)` | Return a new document with that override removed |
| `contextFor(doc, registry?)` | Build a `ReflowContext` from a document |

`layoutFor` is the one place the canonical/override priority is decided:

```ts
const override = doc.local?.densityOverrides?.[density];
if (override !== undefined) {
  return {layout: structuredClone(override), source: 'override'};
}
return {layout: reflow(doc.spec.layout, density, ctx), source: 'computed'};
```

Entering a density with a remembered arrangement restores it; entering an
unseen one computes from canonical.

## Known limitation

Reflow recursion is currently **unbounded**. That is harmless while documents
come only from a local editor, but a bounded depth returning a structured error
is required before a document is accepted from anywhere else. This is recorded
as carried work, not as a solved problem.

## Planned

- Templatizing household references on share, so a shared document arrives as a
  form to complete rather than a layout with dead references. Today
  `toShareable` omits `local` and nothing more.
- A `resourceVersion`-style field in `metadata` for optimistic concurrency.
- Two independent migration axes — document schema and per-block-type schema —
  so a new block revision does not force a document migration.

None of these are implemented.
