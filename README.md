# LayoutSans

**CSS Flex/Grid layout without the browser. No DOM. No WASM bloat.**

[![npm](https://img.shields.io/npm/v/layout-sans)](https://www.npmjs.com/package/layout-sans)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bundle size](https://img.shields.io/badge/gzipped-%3C17kB-green)](https://bundlephobia.com/package/layout-sans)

---

🚀 **[View the Live Interactive Demo](https://baselashraf81.github.io/layout-sans/demo/interactive-text.html)**

A pure TypeScript 2D layout engine. Give it a tree of boxes with flex/grid rules; get back exact pixel positions for every box. Works in Node, Bun, Deno, Cloudflare Workers, browser — anything that runs JS.

**v0.2** adds a full interactive text stack on top of the pure-canvas renderer: text selection, clipboard copy, Ctrl+F search, hyperlinks, and screen-reader accessibility — with zero visible DOM layout and O(viewport) DOM node count regardless of total items.

---

## Why

- **The browser is a constraint, not a requirement.** `getBoundingClientRect` forces synchronous reflows. For server-rendered layouts, virtual lists, canvas renderers, and PDF engines, the DOM is overhead you don't need.
- **Yoga is great, but it ships WASM.** That is 300+ kB before your first layout call, requires async initialization, and does not run everywhere.
- **LayoutSans is the missing layer after [Pretext](https://github.com/chenglou/pretext).** Pretext tells you *how big* text is. LayoutSans tells you *where everything goes*. Together they replace browser layout with pure math.

---

## Install

```sh
npm install layout-sans
npm install @chenglou/pretext   # peer dep for text nodes and v0.2 interaction
```

---

## Comparison

| | **LayoutSans** | DOM layout | Yoga WASM |
|---|:---:|:---:|:---:|
| 100 boxes | 0.27ms | 8.00ms | 0.80ms |
| 10,000 boxes | 4.82ms | 800.00ms | 8.00ms |
| 100,000 var-height | 46.34ms | crashes | 85.00ms |
| Bundle size | ~17 kB gz | browser only | 300+ kB gz |
| Node / Bun / Deno | yes (layout core) | no | WASM |
| Cloudflare Workers | yes | no | no |
| Async init required | none | no | yes |
| Zero dependencies | yes | — | no |

---

## 5-line demo (v0.1 — layout only)

```ts
import { createLayout } from 'layout-sans'

const boxes = createLayout({
  type: 'flex', direction: 'row', width: 800, height: 600, gap: 16,
  children: [{ type: 'box', flex: 1 }, { type: 'box', width: 240 }],
}).compute()

// [
//   { nodeId: '0',   x: 0,   y: 0, width: 800, height: 600 },
//   { nodeId: '0.0', x: 0,   y: 0, width: 544, height: 600 },
//   { nodeId: '0.1', x: 560, y: 0, width: 240, height: 600 },
// ]
```

---

## v0.2 interactive text — quick start

```ts
import { createLayout, InteractionBridge, attachMouseHandlers,
         paintSelection, paintSearchHighlights, paintFocusRing } from 'layout-sans'
import * as pretext from '@chenglou/pretext'

// 1. WAIT FOR FONTS before computing — see the "Font loading" section below.
await document.fonts.ready

// 2. Build engine + spatial index
const engine = createLayout(root).usePretext(pretext)
const boxes  = engine.compute()
await engine.buildIndex()

// 3. Mount bridge (clipboard, search, shadow a11y tree)
const bridge = new InteractionBridge(canvas, engine, {
  searchUI: true,
  onScrollTo:        (y) => { scrollY = y; scheduleRepaint() },
  requestRepaint:    scheduleRepaint,
  onSelectionChange: (text) => console.log('selection:', text),
})

// 4. Attach mouse handlers (selection drag, link click, dblclick word-select)
const detach = attachMouseHandlers({
  canvas,
  engine,
  getScrollY:        () => scrollY,
  getContentOffsetX: () => contentOffsetX,  // pass if content is centred
  requestRepaint:    scheduleRepaint,
})

// 5. RAF loop — paint canvas first, then sync bridge
function loop() {
  // --- clear + paint your frame here ---
  const sel = engine.selection.get()
  if (sel) paintSelection(ctx, sel, recordMap, engine.textLineMap,
                          engine.getOrderedTextNodeIds(), scrollY, CH, '#6c7aff55')
  if (bridge.search.isOpen)
    paintSearchHighlights(ctx, bridge.search.matches, bridge.search.activeIndex,
                          scrollY, CH, 'rgba(255,220,0,.4)', 'rgba(255,160,0,.7)')
  // paint text glyphs here ...
  const fid = bridge.focusController.activeFocusNodeId
  if (fid) paintFocusRing(ctx, recordMap.get(fid), scrollY, '#6c7aff')

  bridge.sync(scrollY)   // AFTER painting, never before
  requestAnimationFrame(loop)
}
```

---

## v0.2 requirements

These are hard requirements. Each one will silently break selection accuracy or canvas stability if skipped.

### 1. Wait for web fonts before `engine.compute()`

```js
// Module script — top-level await
await document.fonts.ready
const engine = createLayout(root).usePretext(pretext)
const boxes  = engine.compute()

// Non-async context
document.fonts.ready.then(() => {
  const engine = createLayout(root).usePretext(pretext)
  initAndMount(engine)
})
```

`engine.compute()` calls Pretext which reads real glyph widths via `ctx.measureText`. If the web fonts in your `TextNode.font` strings have not finished downloading, `measureText` silently falls back to the system font and stores those wrong widths in `textLineMap`. When the real font paints later the visual glyphs diverge from the stored geometry, causing selection rects and search highlights to land at shifted positions. `document.fonts.ready` costs nothing on a warm cache.

### 2. `outline: none` on the canvas element

```css
canvas {
  outline: none;
}
```

When the canvas has `tabindex="0"` and gets focus on mousedown, the browser draws a focus ring. If the canvas-wrap parent has `overflow: hidden`, the ring is clipped on the outside and appears as an inset border — visually the content looks shifted inward. `getBoundingClientRect()` is unaffected so every subsequent hit-test is off by the ring width.

### 3. `preventScroll: true` on any `.focus()` call inside the canvas-wrap

`overflow: hidden` makes a containing block an implicit scroll container. Browsers can programmatically scroll it via focus-driven `scrollIntoView`. The `InteractionBridge` proxy caret does this internally; any `.focus()` calls in your own code for elements inside the same container should also pass `{ preventScroll: true }`.

### 4. Canvas DPR setup must match the bridge's coordinate model

```js
const dpr = Math.min(window.devicePixelRatio || 1, 2)
canvas.width  = containerWidth  * dpr
canvas.height = containerHeight * dpr
canvas.style.width  = containerWidth  + 'px'
canvas.style.height = containerHeight + 'px'
ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
```

All `BoxRecord` coordinates are in CSS pixels. The bridge reads `canvas.getBoundingClientRect()` to convert mouse events to world space. The above setup keeps CSS pixels and canvas drawing coordinates aligned.

### 5. Call `bridge.sync()` after painting, never before

```js
// CORRECT
paintCanvasFrame(ctx, boxes, scrollY)
bridge.sync(scrollY)

// WRONG — sync before paint can cause a layout recalculation that shifts
// the canvas position before getBoundingClientRect() is read
bridge.sync(scrollY)
paintCanvasFrame(ctx, boxes, scrollY)
```

---

## API reference

### Core (v0.1+)

#### `createLayout(root, options?)`

```ts
const engine = createLayout(root, { width?: number, height?: number })
const boxes  = engine.compute()   // BoxRecord[]
engine.usePretext(pretextModule)  // chainable, call before compute()
```

#### `BoxRecord`

```ts
interface BoxRecord {
  nodeId:       string
  x:            number
  y:            number
  width:        number
  height:       number
  nodeType:     string    // 'text' | 'heading' | 'link' | 'box' | ...
  textContent?: string    // text / heading nodes
  href?:        string    // link nodes
  target?:      string
}
```

---

### Interactive (v0.2+)

#### `engine.buildIndex()`

Build the packed R-Tree spatial index. Call once after `compute()`. Returns a `Promise`. Safe to call from `requestIdleCallback`.

#### `new InteractionBridge(canvas, engine, options?)`

```ts
interface InteractionOptions {
  searchUI?:             boolean                         // default true
  selectionColor?:       string
  searchHighlightColor?: string
  searchActiveColor?:    string
  onLinkClick?:          (href: string, target: string) => boolean
  onSelectionChange?:    (text: string) => void
  onScrollTo?:           (y: number) => void
  requestRepaint?:       () => void
}

bridge.sync(scrollY)   // call every frame after painting
bridge.rebuild()       // call after engine.compute() is re-run
bridge.destroy()       // call on unmount
```

#### `attachMouseHandlers(opts)`

```ts
const detach = attachMouseHandlers({
  canvas,
  engine,
  getScrollY:         () => number,
  getContentOffsetX?: () => number,   // default 0
  requestRepaint:     () => void,
  onLinkClick?:       (href, target) => boolean,
})
detach()  // removes all listeners
```

#### Paint helpers

```ts
paintSelection(ctx, sel, recordMap, textLineMap, orderedIds, scrollY, viewportH, color)
paintSearchHighlights(ctx, matches, activeIndex, scrollY, viewportH, inactiveColor, activeColor)
paintFocusRing(ctx, record, scrollY, color)
```

Call all three **before** drawing text glyphs so highlights sit beneath the glyphs.

#### `engine.selection`

```ts
engine.selection.get()                        // SelectionRange | null
engine.selection.onChange(fn)                 // returns unsubscribe fn
engine.setSelection(startId, startChar, endId, endChar)
engine.clearSelection()
await engine.copySelectedText()               // writes to OS clipboard
```

#### `bridge.search`

```ts
bridge.search.openPanel()
bridge.search.search(query, { caseSensitive?, wholeWord? })
bridge.search.nextMatch() / prevMatch() / goToMatch(index)
bridge.search.closePanel()
bridge.search.isOpen       // boolean
bridge.search.matches      // SearchMatch[]
bridge.search.activeIndex  // number
```

#### `engine.getOrderedTextNodeIds()`

All text/heading node IDs in document order. Pass to `paintSelection` and use for select-all operations.

#### `engine.extractText()`

Full plain text of the layout tree in document order.

---

### Node types

#### `FlexNode`

```ts
{
  type: 'flex'
  direction?: 'row' | 'column'
  gap?: number; rowGap?: number; columnGap?: number
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly'
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  wrap?: boolean
  width?: number; height?: number
  padding?: number; paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number
  margin?: number; marginTop?: number; marginRight?: number; marginBottom?: number; marginLeft?: number
  children?: Node[]
}
```

Flex children may add: `flex`, `flexShrink`, `flexBasis`, `alignSelf`.

#### `BoxNode`

```ts
{ type: 'box', width?: number, height?: number, flex?: number }
```

#### `TextNode`

```ts
{
  type: 'text'
  content: string
  font?: string        // CSS font string — must match the face loaded in the browser
  lineHeight?: number
  width?: number
  preparedText?: PreparedText
}
```

#### `HeadingNode` (v0.2+)

```ts
{
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  content: string
  font?: string
  lineHeight?: number
  width?: number
}
```

Mapped to `<h1>`–`<h6>` in the Shadow Semantic Tree.

#### `LinkNode` (v0.2+)

```ts
{
  type: 'link'
  href: string
  target?: '_blank' | '_self' | '_parent' | '_top'
  rel?: string    // auto-set to 'noopener noreferrer' when target='_blank'
  aria?: { label?: string }
  children?: Node[]
}
```

Clickable via mouse. Tab-navigable via the Shadow Semantic Tree. Rendered as `<a>`.

#### `GridNode`

```ts
{
  type: 'grid'
  columns?: number; rows?: number
  gap?: number; rowGap?: number; columnGap?: number
  children?: Node[]
}
```

#### `AbsoluteNode`

```ts
{
  type: 'absolute'
  top?: number; right?: number; bottom?: number; left?: number
  width?: number; height?: number
  children?: Node[]
}
```

#### `MagazineNode`

```ts
{
  type: 'magazine'
  columnCount: number
  columnGap?: number
  content?: string
  children?: TextNode[]
  font?: string; lineHeight?: number
  width: number; height?: number
}
```

---

## Performance budget (v0.2, 100,000 items, Chrome 120, M1 MacBook Pro)

| Metric | Budget |
|---|---|
| `engine.compute()` | < 5ms |
| `engine.buildIndex()` | < 15ms (idle callback) |
| Mousemove hit-test (R-Tree) | < 0.5ms |
| Sub-glyph char resolution | < 0.1ms |
| Selection repaint | < 1ms |
| `bridge.sync()` per frame | < 2ms |
| DOM node count total | ≤ 700 |
| Canvas frame time | < 3ms |

---

## Browser compatibility

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| Canvas 2D | all | all | all |
| `navigator.clipboard.writeText()` | 66+ | 63+ | 13.1+ |
| `requestIdleCallback` | 47+ | 55+ | fallback: setTimeout |
| `document.fonts.ready` | 35+ | 41+ | 10+ |
| Shadow Semantic Tree / aria-live | all | all | all |

Minimum: Chrome 66, Firefox 63, Safari 13.1.

---

## Demos

| Demo | What it shows |
|---|---|
| [`demo/interactive-text.html`](demo/interactive-text.html) | Full v0.2: selection, copy, links, search, a11y |
| [`demo/hero.html`](demo/hero.html) | 100k-item canvas benchmark |
| [`demo/basic-flex.ts`](demo/basic-flex.ts) | 5-line flex row |
| [`demo/magazine.ts`](demo/magazine.ts) | Multi-column text flow |
| [`demo/virtualization.ts`](demo/virtualization.ts) | 100,000 variable-height items |

```sh
npm run build
npm run demo:hero
```

---

## Benchmarks

```sh
npm run bench
```

| Scenario | LayoutSans | vs DOM | vs Yoga WASM |
|---|---:|---:|---:|
| 100 flex boxes | 0.27ms | 30x | 3x |
| 10,000 flex boxes | 4.82ms | 166x | 2x |
| 100,000 var-height | 46.34ms | inf | 2x |

---

## Roadmap

**v0.2 — now**
- Pure-canvas text selection with native OS clipboard integration
- O(log n) spatial hit-testing via packed R-Tree
- Interactive hyperlinks (mouse + Tab + keyboard)
- Full-text search (Ctrl+F) with canvas highlighting
- Virtualized shadow semantic tree for screen readers (VoiceOver, NVDA, JAWS)
- Mobile long-press with native teardrop selection handles
- O(viewport) DOM node count — constant at any item count

**v0.3**
- Named grid template areas
- CSS `aspect-ratio`
- Enhanced ARIA role/label per record

**v0.4**
- RTL layout
- Full CSS grid (template columns/rows, named lines, span)
- Baseline alignment

---

## Support

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V01X2WY5)

---

## License

MIT

---

## Acknowledgements

- **[Pretext](https://github.com/chenglou/pretext)** by [@_chenglou](https://x.com/_chenglou) — the pure-math text measurement layer that makes LayoutSans possible.
- **[Yoga](https://github.com/nicolo-ribaudo/yoga-layout)** by Meta — the production flexbox engine that inspired LayoutSans's API design.
