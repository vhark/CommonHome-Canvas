# 07 — Design principles

Five principles govern Canvas. Each is stated as a constraint, with the
evidence that made it binding rather than decorative.

---

## 1. Touch-first, never hover-dependent

**Requirements DES-04 and DES-05. Binding on all UI work.**

> No control, affordance or piece of information may be reachable only by
> hover. Hover may refine an already-visible control. It may never be the only
> way to reveal one.

### The evidence

This is not taste. A real device reported:

```
pointer coarse  : true
hover capable   : false
max touch points: 5
```

`hover capable: false` is the browser stating plainly that
`@media (hover: hover)` will never match. Any CSS or JavaScript that gates
visibility on `:hover` produces a control that **cannot be revealed at all** on
that device. Not awkward — impossible.

The intended display fleet is tablets, touchscreens and a television. The
tablets and touchscreens have no hovering pointer at all, which is what makes
this binding. The television's remote is an airmouse with a keyboard on the
back, so it does have a pointer — but designing for the weakest input is what
makes the others work.

An earlier draft of this constraint claimed the television imposed a stricter
directional-focus requirement and would need a full keyboard-navigation model
for the canvas. That was wrong on the available evidence: the remote enumerates
as both a mouse and a keyboard. The mistake is recorded because its cost would
have been real — a whole focus model built for a device nobody owns.

### The 48×48 rule applies to resize handles

**DES-05** requires interactive targets to meet a 48 × 48 CSS pixel minimum on
every surface, **including resize and drag affordances**, not only buttons.

Measured on real hardware, on a 16-pixel corner grip:

```
dragged the box              : true
resized via corner grip      : true
grip hits                    : 2
grip misses (dragged instead): 1
page scroll during gesture   : 0px
```

A **33% miss rate**. The prediction beforehand was that it would be unusable;
the evidence is more useful than that. It *is* hittable, but a third of
attempts land on the box and drag it instead. One wrong drag in three while
trying to resize is the kind of friction that makes people stop rearranging
their screen.

16 pixels is deliberate in that probe — it is the size a mouse cursor expects
and the size the engines ship by default. The finding is that the 48-pixel
minimum must be enforced on the resize affordance specifically.

The named-size picker described in [03](03-blocks-and-sizing.md) helps here
directly: **a picker is a list of tap targets, not a 16-pixel corner.** The
sizing model and the touch constraint solve each other.

### What this rules out

- **Hover-reveal disclosure, wholesale.** A design study of a well-known
  ambient dashboard found it hides nearly every affordance behind hover — 80
  CSS rules across 41 stylesheets following the `opacity: 0` →
  `:hover { opacity: 1 }` pattern, covering dropdowns, edit controls, chevrons
  and adjusters. At rest their screen shows only content; controls do not
  visually exist. That is a genuinely elegant way to achieve calm *on a
  laptop*, and it is precisely the wrong pattern here. It was tempting, too:
  the ambient work already borrowed the scrim, type scale and opacity ladder,
  and taking the disclosure model along with them would have been the natural
  next step.
- **Tooltips as the sole carrier of meaning.** A tooltip that only appears on
  hover is invisible on every primary display. Tooltips may supplement; they
  may not be the only place a fact lives.
- **Hover-only drag and resize handles.** Handles that materialise on hover
  cannot be found by a finger.
- **Desktop-sized targets.**

### What replaces it

In rough order of preference:

1. **Show less, permanently.** The strongest answer, and the one the ambient
   screen already takes: the quote, the weather and one focal line are simply
   always there. Nothing to reveal because nothing is hidden.
2. **Explicit modes.** Editing affordances appear in Edit mode and are absent
   otherwise. A mode is a touch-reachable, discoverable substitute for hover.
3. **Time-based and conditional disclosure.** The ambient screen's health line
   works this way — absent unless something is actually wrong, rather than dim
   until pointed at.
4. **Direct manipulation.** Tap the thing itself rather than a control that
   appears near it.

### Testing obligation

The test matrix must include a coarse-pointer, no-hover configuration. It does:
`webkit-phone-landscape` and `webkit-phone-portrait` at the real device's
832 × 384 and 384 × 832, DPR 3. See [06](06-development.md).

---

## 2. Calm by default — no flash, no noise, no urgency

A household display sits in a room where people live. It must not compete for
attention.

The binding rules:

- **No default sound.** Placing a sound block places a *control*; it does not
  start audio. Browser autoplay policy enforces the same thing from the other
  side — an `AudioContext` starts suspended and needs a user gesture — so the
  calm requirement and the platform constraint agree.
- **No flashing, strobing or urgency escalation.** A block cannot self-promote
  into loud or bright behaviour. Any safety override requires explicit
  administrator policy.
- **Nothing moves quickly.** In the ambient prototype, content swaps fade over
  0.5 s and photos crossfade over 2 s. Nothing slides or scales. Nothing on an
  ambient screen should move quickly enough to pull the eye from across a room.
- **No partial paints.** A new photo is decoded into an `Image` before it is
  swapped in, so the crossfade only ever runs on a complete picture.
- **Reduced motion is honoured absolutely.**

  ```css
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
  ```

- **Hierarchy from size, position and opacity — never from hue.** The ambient
  screen uses one text colour at four alpha levels. Coloured text over an
  arbitrary photograph is both unreadable and restless.
- **Empty space is the design.** The ambient composition's centre column holds
  the whole reading stack and everything else is pushed to the edge bands. The
  emptiness is not a gap waiting to be filled — it is what separates an ambient
  screen from a dashboard.

Night-state luminance, presence wake and dim policies are **planned**, not
implemented. Where hardware brightness or power control is concerned, the rule
is to report capability honestly rather than claim it: browser dimming is not
hardware brightness, and no browser-only promise of physical device control
should be made.

---

## 3. Deterministic first

Canvas's core must run without an LLM and without a platform dependency. Agents
are optional clients of deterministic software, never a requirement for
rendering, validation, scheduling or persistence.

Within the model layer this shows up as concrete properties:

- **Reflow is pure.** No clock, no randomness, no module state, no I/O. A
  comparable desktop environment needed coalescing timers, sequencing guards, a
  relayout lock and startup-suppression logic, every one of them compensation
  for a relayout that was not pure. Canvas needs none of that machinery.
- **Tie-breaks are stable across runs and machines.** Reflow sorts by desired
  row, then desired column, then **element name** — never array index, which
  would silently change meaning if a document were re-serialised in a different
  order. Size snapping breaks ties toward the smaller footprint and then on
  declaration order.
- **Determinism beats optimality.** A rule that always produces the same
  arrangement is one a family can learn, and one a property test can pin down.
  A cleverer rule that occasionally surprises is worse.
- **The quote of the day is date-derived, not random**, so every display in the
  house shows the same one and a restart does not change it.
- **Errors are structured values, not silent corrections.** Every fallible
  function returns `Result<T>` with a code, a message and a JSON path. A silent
  correction is indistinguishable, from the author's seat, from the editor
  losing their work.
- **Unknown content round-trips.** Validation refuses only what is
  uninterpretable, never what is merely unrecognised. See
  [02](02-canvas-document-format.md).

---

## 4. Attribution is a first-class feature

Credits are modelled, bound to the data they describe, and rendered next to it.
They are not fine print and not a footnote.

Two reasons, both stated in the source.

**Obligation.** The forecast provider's terms require crediting the forecast.
The photo provider requires naming the photographer and the source, hotlinking
the image with its tracking identifier intact, and pinging a download endpoint
on each use so the photographer is credited with that use. All three are
implemented. See [05](05-ambient-screen.md).

**Doctrine.** A household should always be able to see where a number came
from. A display that states the weather without saying who forecast it is
asking to be trusted without showing its work.

```ts
export type Credit = {
  of: 'weather' | 'calendar' | 'presence' | 'photo';
  source: string;
  author?: string;
  authorUrl?: string;
  sourceUrl?: string;
};
```

The `of` field is what makes this first-class: each credit *belongs* to
something, and is rendered beside it, so the relationship is visible rather
than implied.

Consequences that follow:

- **On a television nothing is clickable, and the credit still renders in
  full.** The links travel with the model for any surface that can use them.
  Dropping a credit because a TV cannot be clicked would not satisfy the
  requirement.
- **Never credit nobody.** An incomplete photo record yields no credit at all
  rather than an empty label, and credit text for a null credit is an empty
  string, never the literal `"null"`. Both are tested.
- **Attribution applies to words too.** Every quote in the built-in library
  names its author, and the set deliberately avoids well-known
  misattributions. Where a quote is traditional or its author genuinely
  unknown, it says so rather than borrowing a famous name.
- **Attribution scales with size, and that is an open question.** A 1×1 weather
  block has no room for a data credit and must not pretend otherwise. Whether
  the obligation is satisfied once per screen or per block is a licence
  question, not a layout preference, and it is unresolved.

---

## 5. Accessibility and honest degradation

- **48 × 48 CSS pixel minimum** on every interactive target, including resize
  and drag affordances. Measured on real hardware, not asserted.
- **Visible focus, predictable keyboard order, non-colour status labels, 200%
  zoom, reduced motion and forced colors** across editor and renderer. Reduced
  motion is honoured today; the rest applies to an editor that does not exist
  yet.
- **`@axe-core/playwright` is present** in the toolchain for automated
  accessibility checks.
- **Never blank, but never silently wrong.** The ambient screen keeps its last
  good snapshot on a failure and discloses its age once it is meaningfully old:
  `Showing last known good · 7 min old`. "Never blank" must not become "quietly
  stale".
- **Degrade per source.** One failing provider must not blank a household
  screen. Weather, calendar, presence and photo each fail independently, and
  the failures are named in a `degraded` array rather than swallowed.
- **Never show a machine identifier to a family.** Weather condition slugs are
  mapped to English explicitly, and an unrecognised future slug still degrades
  to readable text rather than leaking a developer string.
- **Diagnostics are absent, not dim, when nothing is wrong.** A television
  cannot be hovered, so a health line that is always present at low opacity is
  just permanent clutter.

---

## Security posture, stated as a design principle

Because it shapes the architecture rather than sitting beside it:

- **Source credentials never reach a browser.** Not in URLs, not in documents,
  not in logs, not in bundles, not in previews. The adapter process holds them
  and returns shaped projections. See [01](01-architecture.md).
- **Display-facing endpoints are read-only by construction**, not by
  convention. The snapshot endpoint issues GETs and exposes no way to call a
  service, so a compromised display cannot actuate anything in the house.
- **Allowlists, not patterns.** Entities are named individually. Hosts are
  named individually. Share is a positive allowlist of what to emit, not a
  denylist of what to strip — because a denylist leaks the first time somebody
  adds a field.
- **Field-level shaping.** Calendar descriptions and locations are
  household-private and do not leave the server, even though the calendar API
  returns them.
- **Arbitrary member-authored HTML, CSS and JavaScript is out of scope**, and
  the word "widget" is reserved for that untrusted category so it never gets
  confused with a trusted Block.

Privacy blackout, revocation, display identity and offline authorisation policy
are **planned**. None of them exist yet.
