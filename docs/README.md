# CommonHome Canvas documentation

Canvas is an early prototype. These documents describe what exists in the
repository today and mark planned work as planned. See the top-level
[README](../README.md) for the status summary and the feature table.

## Index

| Document | Contents |
|---|---|
| [01 — Architecture](01-architecture.md) | The canonical model versus the spikes, the server-side adapter boundary, where the grid engine sits |
| [02 — Canvas document format](02-canvas-document-format.md) | The portable JSON schema: envelope, elements, layouts, density overrides, round-tripping rules |
| [03 — Blocks and sizing](03-blocks-and-sizing.md) | What a Block is, declared named footprints, why arbitrary resize is not offered |
| [04 — Grid density](04-grid-density.md) | Named density levels, harmonic column counts, deterministic reflow |
| [05 — Ambient screen](05-ambient-screen.md) | The working ambient display, its configuration, and its attribution obligations |
| [06 — Development](06-development.md) | Setup, the real npm scripts, the Playwright project matrix, testing philosophy |
| [07 — Design principles](07-design-principles.md) | Touch-first, calm, deterministic, attribution as a feature, accessibility |

## Reading order

If you are evaluating Canvas, read 01 then 02. If you intend to contribute to
the model layer, read 02, 03 and 04 in order — they describe one design, split
across three files by subject. If you want to run the thing that actually works
today, go straight to 05.
