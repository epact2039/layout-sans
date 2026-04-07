# LayoutSans

**CSS Flex/Grid layout without the browser. No DOM. No WASM.**

[![npm](https://img.shields.io/npm/v/layout-sans)](https://www.npmjs.com/package/layout-sans)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bundle size](https://img.shields.io/badge/gzipped-%3C17kB-green)](https://bundlephobia.com/package/layout-sans)

**v0.2** adds a full interactive text stack on top of the pure-canvas renderer: text selection, clipboard copy, Ctrl+F search, hyperlinks, and screen-reader accessibility — with zero visible DOM layout and O(viewport) DOM node count regardless of total items.
---

<p align="center">
  <img src="https://github.com/BaselAshraf81/layout-sans/raw/main/.github/assets/hero.gif" alt="LayoutSans Demo">
</p>

🚀 **[Live Demo](https://baselashraf81.github.io/layout-sans/demo/interactive-text.html)** — 100k-item benchmark + interactive text selection, search, and links

A pure TypeScript 2D layout engine. Give it a tree of boxes with flex/grid rules; get back exact pixel positions for every box. Works in Node, Bun, Deno, Cloudflare Workers, browser — anything that runs JS.



---

## Why

- **The browser is a constraint, not a requirement.** `getBoundingClientRect` forces synchronous reflows. For server-rendered layouts, virtual lists, canvas renderers, and PDF engines, the DOM is overhead you don't need.
- **Yoga is great, but it ships WASM.** That is 300+ kB before your first layout call, requires async initialization, and does not run everywhere.
- **LayoutSans is the missing layer after [Pretext](https://github.com/chenglou/pretext).** Pretext tells you *how big* text is. LayoutSans tells you *where everything goes*. Together they replace browser layout with pure math.

---

## Install

```sh
npm install layout-sans @chenglou/pretext
```

---

## Comparison

| | **LayoutSans** | DOM layout | Yoga WASM |
|---|:---:|:---:|:---:|
| 100 boxes | **0.27 ms** | 8.0 ms | 0.80 ms |
| 10,000 boxes | **4.82 ms** | 800 ms | 8.0 ms |
| 100,000 var-height | **46 ms** | crashes | 85 ms |
| buildIndex() at 100k | **< 15 ms** | — | — |
| Hit-test query (R-Tree) | **< 0.5 ms** | — | — |
| Sub-glyph cursor resolve | **< 0.1 ms** | — | — |
| Bundle size | **~17 kB gz** | browser only | 300+ kB gz |
| Node / Bun / Deno | ✅ | ❌ | WASM only |
| Cloudflare Workers | ✅ | ❌ | ❌ |
| Async init required | none | ❌ | ✅ |
| Zero dependencies | ✅ | — | ❌ |

---

## Quick start

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

## v0.2 interactive text

```ts
import { createLayout, InteractionBridge, attachMouseHandlers,
         paintSelection, paintSearchHighlights, paintFocusRing } from 'layout-sans'
import * as pretext from '@chenglou/pretext'

// 1. Wait for web fonts — glyph widths are read at compute() time.
await document.fonts.ready

// 2. Build engine + spatial index
const engine = createLayout(root).usePretext(pretext)
const boxes  = engine.compute()
await engine.buildIndex()

// 3. Mount bridge (clipboard, search, shadow a11y tree)
const bridge = new InteractionBridge(canvas, engine, {
  searchUI: true,
  onScrollTo:        (y) => { scrollY = y; repaint() },
  requestRepaint:    repaint,
  onSelectionChange: (text) => console.log('selected:', text),
})

// 4. Attach mouse handlers (selection drag, link click, double-click word-select)
const detach = attachMouseHandlers({ canvas, engine, getScrollY: () => scrollY, requestRepaint: repaint })

// 5. RAF loop — paint canvas, then sync bridge
function loop() {
  paintCanvasFrame()
  const sel = engine.selection.get()
  if (sel) paintSelection(ctx, sel, recordMap, engine.textLineMap,
                          engine.getOrderedTextNodeIds(), scrollY, CH, '#6c7aff55')
  if (bridge.search.isOpen)
    paintSearchHighlights(ctx, bridge.search.matches, bridge.search.activeIndex,
                          scrollY, CH, 'rgba(255,220,0,.4)', 'rgba(255,160,0,.7)')
  bridge.sync(scrollY)   // always AFTER painting
  requestAnimationFrame(loop)
}
```

---

## v0.2 requirements

### 1. Wait for web fonts before `engine.compute()`

`engine.compute()` reads real glyph widths via `ctx.measureText`. If the fonts are still downloading, widths are computed against the system fallback font and stored incorrectly in `textLineMap`. Selection rects and search highlights will land at shifted positions when the real font paints.

```js
await document.fonts.ready     // module context
document.fonts.ready.then(initEngine)  // non-async context
```

### 2. `outline: none` on the canvas element

When the canvas has `tabindex="0"` and a parent has `overflow: hidden`, the browser's focus ring appears as an inset border, misaligning `getBoundingClientRect()` and every subsequent hit-test.

```css
canvas { outline: none; }
```

### 3. `preventScroll: true` on `.focus()` calls inside the canvas-wrap

`overflow: hidden` creates an implicit scroll container. Any `.focus()` call without this flag can silently scroll the container, drifting the canvas coordinate system.

### 4. Canvas DPR setup

```js
const dpr = Math.min(window.devicePixelRatio || 1, 2)
canvas.width  = containerWidth  * dpr
canvas.height = containerHeight * dpr
canvas.style.width  = containerWidth  + 'px'
canvas.style.height = containerHeight + 'px'
ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
```

### 5. `bridge.sync()` after painting, never before

Calling `sync()` before painting can trigger a layout recalculation that shifts the canvas position before `getBoundingClientRect()` is read.

---

## API reference

### Core

#### `createLayout(root, options?)`

```ts
const engine = createLayout(root, { width?: number, height?: number })
engine.usePretext(pretextModule)  // chainable; call before compute()
const boxes = engine.compute()    // BoxRecord[]
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
  textContent?: string
  href?:        string
  target?:      string
}
```

---

### Interactive (v0.2+)

#### `engine.buildIndex()`

Builds the packed R-Tree spatial index. Call once after `compute()`. Returns a `Promise`. Safe to schedule via `requestIdleCallback`.

#### `new InteractionBridge(canvas, engine, options?)`

```ts
interface InteractionOptions {
  searchUI?:             boolean      // default true
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

Call all three **before** drawing text glyphs so highlights sit beneath them.

```ts
paintSelection(ctx, sel, recordMap, textLineMap, orderedIds, scrollY, viewportH, color)
paintSearchHighlights(ctx, matches, activeIndex, scrollY, viewportH, inactiveColor, activeColor)
paintFocusRing(ctx, record, scrollY, color)
```

#### `engine.selection`

```ts
engine.selection.get()
engine.selection.onChange(fn)          // returns unsubscribe fn
engine.setSelection(startId, startChar, endId, endChar)
engine.clearSelection()
await engine.copySelectedText()        // writes to OS clipboard
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

All text/heading node IDs in document order. Pass to `paintSelection` and use for select-all.

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

#### `BoxNode` · `TextNode` · `HeadingNode` · `LinkNode`

```ts
{ type: 'box', width?: number, height?: number, flex?: number }

{
  type: 'text'
  content: string
  font?: string        // CSS font string — must match the loaded face
  lineHeight?: number
  width?: number
}

{
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  content: string; font?: string; lineHeight?: number; width?: number
}

{
  type: 'link'
  href: string
  target?: '_blank' | '_self' | '_parent' | '_top'
  rel?: string         // auto-set to 'noopener noreferrer' when target='_blank'
  aria?: { label?: string }
  children?: Node[]
}
```

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
| `engine.compute()` | < 5 ms |
| `engine.buildIndex()` | < 15 ms (idle callback) |
| Mousemove hit-test (R-Tree) | < 0.5 ms |
| Sub-glyph char resolution | < 0.1 ms |
| Selection repaint | < 1 ms |
| `bridge.sync()` per frame | < 2 ms |
| DOM node count total | ≤ 700 |
| Canvas frame time | < 3 ms |

---

## Browser compatibility

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| Canvas 2D | all | all | all |
| `navigator.clipboard.writeText()` | 66+ | 63+ | 13.1+ |
| `requestIdleCallback` | 47+ | 55+ | setTimeout fallback |
| `document.fonts.ready` | 35+ | 41+ | 10+ |
| Shadow Semantic Tree / aria-live | all | all | all |

Minimum: Chrome 66, Firefox 63, Safari 13.1.

---


## Benchmarks

```sh
npm run bench
```

| Scenario | LayoutSans | vs DOM | vs Yoga WASM |
|---|---:|---:|---:|
| 100 flex boxes | 0.27 ms | 30× | 3× |
| 10,000 flex boxes | 4.82 ms | 166× | 2× |
| 100,000 var-height | 46 ms | ∞ | 2× |
| buildIndex() at 100k | 11 ms | — | — |
| queryPoint() p95 at 100k | < 0.5 ms | — | — |
| resolvePixelToCursor() p95 | < 0.1 ms | — | — |

---

## Roadmap

**v0.2 — current**
- Canvas text selection + OS clipboard (desktop & mobile)
- O(log n) spatial hit-testing via packed R-Tree
- Interactive hyperlinks (mouse + Tab + keyboard)
- Full-text search (Ctrl+F) with canvas highlighting
- Virtualized shadow semantic tree (VoiceOver, NVDA, JAWS)
- Mobile long-press with native teardrop selection handles
- O(viewport) DOM node count regardless of total item count

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
