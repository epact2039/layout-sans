# Changelog

## v0.2.0 — Interactive Text Engine

### New features

**Full interactive text stack — zero visible DOM layout**

v0.2 adds a complete OS Bridge on top of the v0.1 pure-canvas renderer.
All pixel painting (selection highlights, search highlights, focus rings) is
done exclusively via the Canvas 2D API. DOM node count is O(viewport) for
the accessibility layer and O(1) for the clipboard bridge, regardless of
whether the layout contains 1,000 or 1,000,000 nodes.

**Spatial Hit-Test Engine** (`src/rtree.ts`)

- Static packed R-Tree (SSP-RTree) built once from `BoxRecord[]` after `compute()`
- O(log n) point and rectangle queries — ~17 comparisons at 100,000 nodes vs O(n) linear scan
- Built off the critical path via `requestIdleCallback` / `setTimeout` fallback
- New API: `engine.buildIndex()` → `Promise<void>`; `engine.spatialIndex.queryPoint(x, y)`

**Canvas Text Selection** (`src/selection.ts`, `src/mouse.ts`, `src/paint.ts`)

- Click-drag selection across multiple `TextNode`s and across line wraps
- Sub-glyph precision using pre-computed Pretext `breakablePrefixWidths` — zero `measureText()` calls in the mouse hot path
- Double-click word expansion using Pretext segment `kind` boundaries
- Shift+Click to extend selection; Ctrl/Cmd+A to select all
- `paintSelection()` draws highlight rects via `ctx.fillRect` (no CSS `::selection` involved)
- Selection state exposed as `engine.selection` (`SelectionState` singleton)
- `engine.setSelection(startId, char, endId, char)` for programmatic highlighting

**OS Bridge — Desktop Clipboard** (`src/bridge.ts`)

- One `<textarea>` proxy caret (0×0 at rest, `opacity: 0`, always in DOM)
- Ctrl/Cmd+C populates the textarea and dispatches copy via `navigator.clipboard.writeText()` + `execCommand` fallback
- `engine.copySelectedText()` for programmatic copy
- `InteractionBridge.syncText()` for manual sync

**OS Bridge — Mobile Long-Press & Native Handles** (`src/bridge.ts`)

- 500ms long-press detector; cancelled by >8px drift or early touchend
- Word expansion using Pretext segment kinds (same algorithm as double-click)
- Proxy caret populated with hit TextNode's font, geometry, and text string — OS positions teardrop handles at correct screen coordinates
- `selectionchange` on the textarea maps char offsets back to `SelectionCursor`s, updating canvas selection on every handle drag

**Hyperlinks** (`src/types.ts`, `src/engine.ts`)

- New `LinkNode` type: `{ type: 'link', href, target, rel, children }`
- Hover cursor (`pointer`) via spatial index hit-test in `mousemove`
- Click navigation: `window.open` for `_blank`, `location.href` otherwise
- Canvas underline rendered via `ctx.fillRect` (not CSS)

**Headings** (`src/types.ts`)

- New `HeadingNode` type: `{ type: 'heading', level: 1–6, content, font, lineHeight }`
- Measured and laid out like `TextNode`; stored in `textLineMap`
- Mapped to `<h1>`–`<h6>` in the Shadow Semantic Tree

**Shadow Semantic Tree** (`src/shadow.ts`)

- Virtualized DOM pool: only nodes visible in the current viewport ±3 viewport heights are materialized
- Hard cap: 600 nodes maximum
- Node mapping: `text` → `<p>`, `heading` → `<h1>`–`<h6>`, `link` → `<a>`, `box+aria` → `<div role>`
- Elements positioned via `transform: translate(x, y)` only — no layout recalculation on scroll
- `aria-live="polite"` container for screen reader announcements
- Skip navigation `<a class="ls-skip">` for WCAG 2.4.1 compliance
- VoiceOver, NVDA, and JAWS compatible

**Focus Rings** (`src/focus.ts`)

- Tab key cycles through shadow `<a>` elements (links) in document order
- `focus` / `blur` events on shadow anchors fire a custom event → canvas draws a 2px `ctx.strokeRect` focus ring
- `bridge.focusController.activeFocusNodeId` exposes the focused record ID
- `paintFocusRing(ctx, record, scrollY, color)` for rendering

**Spatial Search** (`src/search.ts`)

- Ctrl+F intercepted in document keydown capture phase before the browser's native find dialog
- In-memory search: walks `BoxRecord[]` in document order, `String.indexOf()` per node, zero DOM involvement
- `charRangeToRect()` maps character offsets to pixel rects using pre-computed `TextLineData` — zero `measureText()` calls
- `paintSearchHighlights()` renders match rects via `ctx.fillRect`
- Built-in panel (opt-out via `searchUI: false`): query input, "N of M" count, prev/next buttons
- `goToMatch()` runs a 200ms cubic ease-out scroll animation via RAF
- Full API: `search()`, `nextMatch()`, `prevMatch()`, `goToMatch()`, `openPanel()`, `closePanel()`

**New exports from `index.ts`**

```ts
export { InteractionBridge }   from './bridge.js'
export { SpatialIndex }        from './rtree.js'
export { SelectionState }      from './selection.js'
export { ShadowSemanticTree }  from './shadow.js'
export { LayoutSearch }        from './search.js'
export { attachMouseHandlers } from './mouse.js'
export { paintSelection, paintSearchHighlights, paintFocusRing } from './paint.js'
export type { LinkNode, HeadingNode, TextLineData, SelectionCursor,
              SelectionRange, SearchMatch, InteractionOptions } from './types.js'
```

---

### Bug fixes

**Bug — canvas visually shifts on interaction** (`demo/interactive-text.html`, `src/bridge.ts`)

Two compounding issues caused the canvas content to appear shifted after any mouse interaction, misaligning subsequent selection hit-tests.

1. *Focus ring inset:* The canvas had no `outline: none`. On mousedown the browser gives the canvas focus and draws a focus ring. Since `.canvas-wrap` has `overflow: hidden`, the ring's outer portion is clipped and appears as an inset border — making the canvas content look shifted inward. `getBoundingClientRect()` is unaffected, so every hit-test is off by the ring width. Fix: `outline: none` added to `#demo` canvas.

2. *Implicit scroll container:* `overflow: hidden` makes `.canvas-wrap` an implicit scroll container. In `InteractionBridge.onCopy`, `this.canvas.focus()` was called without `{ preventScroll: true }`. On Ctrl+C, the proxy caret grabs focus and then `canvas.focus()` returns it — but without the flag some browsers internally call scroll-into-view on `.canvas-wrap`, adjusting its `scrollTop`. The canvas bitmap does not move with the scroll, so rendered content and the mouse coordinate system drift apart. Fix: `canvas.focus({ preventScroll: true })`.

**Bug — canvas selection misaligned on hard reload / cold cache** (`demo/interactive-text.html`)

On a hard reload with empty browser cache, `initEngine()` was called immediately before web fonts had finished downloading. Pretext reads glyph metrics via `ctx.measureText` at `compute()` time. With Inter and JetBrains Mono not yet available, `measureText` fell back to the system font and stored the wrong segment widths in `textLineMap`. When the web fonts later painted, the canvas glyphs were correct but the stored selection geometry was frozen at fallback-font values, causing selection rects and search highlights to appear at shifted positions. On a soft reload the fonts are cached so the issue was invisible.

Fix: deferred `initEngine()` to `document.fonts.ready.then(...)`. On a warm cache this resolves on the next microtask with no visible delay. On a cold cache a "Loading fonts…" placeholder is painted until ready.

**Bug — double-click word selection truncated to one grapheme** (`src/mouse.ts`)

The backward walk in `expandToWordBoundaries` was stopping one segment too early. The loop checked `kinds[startSi - 1]` before decrementing `startSi`, which meant it never walked backward past the first segment of a word. Words at the start of a line were reduced to a single grapheme.

Fix: check whether the cursor's *current* segment is itself a boundary kind before the backward walk begins, then walk `startSi - 1` correctly.

---

### New files

| File | Purpose |
|---|---|
| `src/rtree.ts` | Static packed R-Tree — O(log n) hit-testing |
| `src/selection.ts` | SelectionState, SelectionCursor, sub-glyph resolution |
| `src/bridge.ts` | InteractionBridge, Proxy Caret, mobile long-press |
| `src/shadow.ts` | ShadowSemanticTree, DOM pool, virtualized sync |
| `src/search.ts` | LayoutSearch, in-memory full-text search, panel UI |
| `src/focus.ts` | FocusController, focus ring painter |
| `src/mouse.ts` | attachMouseHandlers, word expansion |
| `src/paint.ts` | paintSelection, paintSearchHighlights, paintFocusRing |
| `demo/interactive-text.html` | Full v0.2 feature demo |

### Modified files

| File | Changes |
|---|---|
| `src/types.ts` | LinkNode, HeadingNode, BoxRecord.nodeType/.textContent/.href, TextLineData, SelectionCursor/Range, SearchMatch, InteractionOptions |
| `src/engine.ts` | buildIndex(), mount(), getAllRecords(), getTextLineData(), extractText(), setSelection(), clearSelection(), copySelectedText(), getOrderedTextNodeIds() |
| `src/measure.ts` | measureTextWithLines() returns TextLineData; font stored on TextLineData |
| `src/index.ts` | All new exports |

---

## v0.1.2 — Patch (bug fixes + performance)

### Bug fixes

**Bug #1 — Absolute container reported wrong x/y** (`absolute.ts`, `engine.ts`)

`solveAbsolute` was computing the correct resolved position but not returning it.
`engine.ts` was reading the first child's `x`/`y` as the container's own position.

Fix: `AbsoluteResult` now includes `x` and `y`. `engine.ts` uses `result.x` / `result.y` directly.

**Bug #2 — `push(...solveNode())` crashes at ~65k nodes** (all solvers)

Every solver used `records.push(...ctx.solveNode(...))`. V8's `Function.prototype.apply` passes spread args on the call stack with a hard limit of ~65,000–130,000 arguments. At 100k nodes this throws `RangeError: Maximum call stack size exceeded`.

Fix: All spread-into-push patterns replaced with explicit `for` loops. A `pushAll<T>()` helper added to `engine.ts`.

---

### Performance

**Perf #3 — `measureNode` for containers ran the full layout twice** (`engine.ts`, `flex.ts`, `grid.ts`)

When a flex container had `alignItems` other than `stretch`, the engine called `solveNode` on each cross-axis child just to read its height — allocating every descendant record and immediately discarding them. O(n^2) layout work for trees with many flex-column children.

Fix: Added `measureFlexSize()` and `measureGridSize()` — lightweight paths that run size-distribution only, no record allocation.

**Perf #4 — No fast-path for `direction: 'row'`** (`flex.ts`)

`solveFlexColumn` had an O(n) fast path for vertical fixed-size lists; no symmetric path for horizontal.

Fix: Added `solveFlexRow()` — same guard conditions, single O(n) loop, no intermediate allocations.

---

### Algorithm correctness

**Algo #6 — flex-shrink weight used `mainSize` instead of `flexBasis`** (`flex.ts`)

Per the CSS Flexbox spec the shrink factor weight must be `flexShrink x flexBasis`. Fix: shrink weight now resolves `flexBasis` first.

---

### Limit lifted

**Limit #7 — Magazine node could only spill across 2 columns** (`magazine.ts`)

The column-overflow logic used a hardcoded `part0` / `part1` split. Fix: replaced with a `while (remaining > 0)` loop so tall blocks spill across as many columns as needed.

---

## v0.1.0 — Initial release

- Flexbox layout (row/column, flex-grow, flex-shrink, gap, align, justify, wrap)
- Basic grid (uniform columns or rows)
- Magazine multi-column text flow
- Absolute positioning
- Pretext integration for text measurement
- Virtualization-ready flat output
- Column fast-path for fixed-size vertical lists
