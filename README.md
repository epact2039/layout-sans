# LayoutSans

**CSS Flex/Grid layout without the browser. No DOM. No WASM bloat.**

[![npm](https://img.shields.io/npm/v/layout-sans)](https://www.npmjs.com/package/layout-sans)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bundle size](https://img.shields.io/badge/gzipped-%3C25kB-green)](https://bundlephobia.com/package/layout-sans)

---

A pure TypeScript 2D layout engine. Give it a tree of boxes with flex/grid rules; get back exact pixel positions for every box. Works in Node, Bun, Deno, Cloudflare Workers, browser — anything that runs JS.

![LayoutSans — 100k variable-height boxes at 120 fps](https://github.com/BaselAshraf81/layout-sans/raw/main/.github/assets/hero.gif)

---

## Why

- **The browser is a constraint, not a requirement.** `getBoundingClientRect` forces synchronous reflows. For server-rendered layouts, virtual lists, canvas renderers, and PDF engines, the DOM is overhead you don't need.
- **Yoga is great, but it ships WASM.** That's 300+ kB before your first layout call, requires async initialization, and doesn't run everywhere.
- **LayoutSans is the missing layer after [Pretext](https://github.com/chenglou/pretext).** Pretext tells you *how big* text is. LayoutSans tells you *where everything goes*. Together they replace browser layout with pure math.

---

## 5-line demo

```ts
import { createLayout } from 'layout-sans'

const boxes = createLayout({
  type: 'flex', direction: 'row', width: 800, height: 600, gap: 16,
  children: [{ type: 'box', flex: 1 }, { type: 'box', width: 240 }],
}).compute()

// boxes →
// [
//   { nodeId: '0',   x: 0,   y: 0, width: 800, height: 600 },
//   { nodeId: '0.0', x: 0,   y: 0, width: 544, height: 600 },  ← flex: 1
//   { nodeId: '0.1', x: 560, y: 0, width: 240, height: 600 },
// ]
```

---

## Comparison

| | **LayoutSans** | DOM layout | Yoga WASM |
|---|:---:|:---:|:---:|
| 100 boxes | 0.27ms | 8.00ms | 0.80ms |
| 10,000 boxes | 4.82ms | 800.00ms | 8.00ms |
| 100,000 var-height | 46.34ms | crashes | 85.00ms |
| Bundle size | ~3.7 kB gz | browser only | 300+ kB gz |
| Node / Bun / Deno | ✅ | ❌ | ⚠️ WASM |
| Cloudflare Workers | ✅ | ❌ | ❌ |
| Async init required | ✅ none | ❌ | ✅ required |
| Zero dependencies | ✅ | — | ❌ |

---

## Install

```sh
npm install layout-sans
```

For text nodes, install Pretext as a peer dependency:

```sh
npm install @chenglou/pretext
```

---

## API reference

### `createLayout(root, options?)`

Creates a `LayoutEngine` for a node tree. Call `.compute()` to run the layout.

```ts
import { createLayout } from 'layout-sans'

const engine = createLayout(root)
const boxes = engine.compute()
// boxes: BoxRecord[]
```

**Options:**

```ts
interface LayoutOptions {
  width?: number   // override root node width
  height?: number  // override root node height
}
```

---

### `engine.usePretext(mod)`

Inject a loaded Pretext module for accurate text measurement.

```ts
import * as pretext from '@chenglou/pretext'
import { createLayout } from 'layout-sans'

const boxes = createLayout(root).usePretext(pretext).compute()
```

---

### `BoxRecord`

Every node in the input tree produces one `BoxRecord` in the output array.

```ts
interface BoxRecord {
  nodeId: string   // auto-assigned tree path, e.g. '0.1.2', or node.id if set
  x: number        // left edge in px, relative to root origin
  y: number        // top edge in px, relative to root origin
  width: number
  height: number
}
```

---

### Node types

#### `FlexNode`

```ts
{
  type: 'flex'
  direction?: 'row' | 'column'          // default: 'row'
  gap?: number                           // gap between children
  rowGap?: number
  columnGap?: number
  justifyContent?: 'flex-start' | 'center' | 'flex-end'
                 | 'space-between' | 'space-around' | 'space-evenly'
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  wrap?: boolean
  width?: number
  height?: number
  padding?: number   // also: paddingTop, paddingRight, paddingBottom, paddingLeft
  margin?: number    // also: marginTop, marginRight, marginBottom, marginLeft
  children?: Node[]
}
```

Children can add flex props:

```ts
{
  type: 'box'
  flex?: number        // proportion of free space to consume (like CSS flex-grow)
  flexShrink?: number  // default 1
  flexBasis?: number   // base size before grow/shrink
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'auto'
}
```

---

#### `BoxNode`

A leaf box. Size comes from `width`/`height` or flex growth from its parent.

```ts
{ type: 'box', width?: number, height?: number, flex?: number }
```

---

#### `TextNode`

A text leaf measured via Pretext.

```ts
{
  type: 'text'
  content: string
  font?: string          // CSS font string, e.g. '16px Inter'
  lineHeight?: number    // default: fontSize * 1.4
  preparedText?: PreparedText  // pre-prepared Pretext handle (fastest path)
}
```

---

#### `GridNode`

A basic uniform grid.

```ts
{
  type: 'grid'
  columns?: number   // number of equal-width columns
  rows?: number      // OR: number of equal-height rows
  gap?: number
  rowGap?: number
  columnGap?: number
  children?: Node[]
}
```

---

#### `AbsoluteNode`

Positioned relative to its containing box. Supports all four TRBL edges.

```ts
{
  type: 'absolute'
  top?: number
  right?: number
  bottom?: number
  left?: number
  width?: number
  height?: number
  children?: Node[]
}
```

---

#### `MagazineNode`

Flows text across N equal-width columns, magazine-style.

```ts
{
  type: 'magazine'
  columnCount: number
  columnGap?: number     // default: 16
  content?: string       // convenience: single string
  children?: TextNode[]  // OR: array of text nodes
  font?: string
  lineHeight?: number
  width: number
  height?: number
}
```

---

## Pretext integration guide

Pretext measures text. LayoutSans positions everything. Use them together for
full text layout without a browser.

```ts
import { prepare } from '@chenglou/pretext'
import { createLayout } from 'layout-sans'
import * as pretext from '@chenglou/pretext'

// 1. Prepare your text (once per string, width-independent)
const prepared = prepare('Hello, world', '16px Inter')

// 2. Pass the prepared handle into a text node
const root = {
  type: 'flex' as const,
  direction: 'column' as const,
  width: 600,
  children: [
    {
      type: 'text' as const,
      content: 'Hello, world',
      preparedText: prepared,
      font: '16px Inter',
      lineHeight: 22,
    },
  ],
}

// 3. Inject the pretext module and compute
const boxes = createLayout(root).usePretext(pretext).compute()
```

**Performance tip:** call `prepare()` once per text block and cache the result.
The `.compute()` call is pure arithmetic after that — no canvas, no DOM.

---

## Demos

| Demo | What it shows |
|---|---|
| [`demo/basic-flex.ts`](demo/basic-flex.ts) | 5-line flex row with flex-grow |
| [`demo/magazine.ts`](demo/magazine.ts) | Multi-column text flow |
| [`demo/virtualization.ts`](demo/virtualization.ts) | 100,000 variable-height items |

Run any demo with:

```sh
npm run demo
npm run demo:magazine
npm run demo:virtualization
```

---

## Benchmarks

Run locally:

```bash
npm run bench
```

Results (Node/TSX, averaged over 5 runs):

| Scenario | LayoutSans | vs DOM | vs Yoga WASM | DOM | Yoga WASM |
|---|---:|---:|---:|---:|---:|
| 100 flex boxes | 0.27ms | 30× | 3× | 8.00ms | 0.80ms |
| 10,000 flex boxes | 4.82ms | 166× | 2× | 800.00ms | 8.00ms |
| 100,000 var-height items | 46.34ms | ∞× | 2× | N/A (crash) | 85.00ms |

DOM numbers are reference estimates that include element creation + style application + forced `getBoundingClientRect()`. Real DOM runs in Chrome will be even slower at scale (it crashes at 100k due to layout thrashing). Yoga numbers are from official published benchmarks.

Pro tip: Run the virtualization demo yourself — it stays buttery smooth even at 100k+ items.

---

## Roadmap

**v0.1 — now**
- Flexbox (row/column, flex-grow, flex-shrink, gap, align, justify, wrap)
- Basic grid (uniform columns or rows)
- Magazine multi-column text flow
- Absolute positioning
- Pretext integration for text measurement
- Virtualization-ready flat output

**v0.2**
- Accessibility tree output (ARIA role + label per record)
- Named grid template areas
- CSS `aspect-ratio`

**v0.3**
- RTL layout
- Full CSS grid (template columns/rows, named lines, span)
- Baseline alignment

---

## License

MIT

---

## Acknowledgements

- **[Pretext](https://github.com/chenglou/pretext)** by [@_chenglou](https://x.com/_chenglou) — the pure-math text measurement layer that makes LayoutSans possible. LayoutSans is designed as the natural next layer after Pretext.
- **[Yoga](https://github.com/nicolo-ribaudo/yoga-layout)** by Meta — the production flexbox engine that inspired LayoutSans's API design. Yoga's WASM approach informed what we decided *not* to do.
