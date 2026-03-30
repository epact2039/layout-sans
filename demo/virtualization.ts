// LayoutSans demo — virtualization.ts
// 100,000 variable-height items laid out in a flex column.
// Demonstrates the flat BoxRecord[] output that a virtual scroller can use
// without ever touching the DOM.

import { createLayout } from '../src/index.js'
import type { Node } from '../src/index.js'

const ITEM_COUNT = 100_000

console.log(`Building layout tree with ${ITEM_COUNT.toLocaleString()} items…`)
const t0 = performance.now()

// Build a flex column with 100k variable-height boxes
const children: Node[] = []
for (let i = 0; i < ITEM_COUNT; i++) {
  // Vary heights between 40px and 200px to simulate real content
  children.push({
    type: 'box',
    width: 800,
    height: 40 + (i % 7) * 24,
  })
}

const root: Node = {
  type: 'flex',
  direction: 'column',
  width: 800,
  gap: 8,
  children,
}

const t1 = performance.now()
console.log(`Tree built in ${(t1 - t0).toFixed(1)}ms`)

const t2 = performance.now()
const boxes = createLayout(root).compute()
const t3 = performance.now()

console.log(`Layout computed in ${(t3 - t2).toFixed(2)}ms`)
console.log(`Total records: ${boxes.length.toLocaleString()}`)
console.log(`Total scroll height: ${boxes[0]?.height?.toLocaleString() ?? 0}px`)

// Show first 5 records
console.log('\nFirst 5 records:')
console.table(boxes.slice(0, 5))

// Show how you'd use this with a virtual scroller:
const viewportTop = 10_000
const viewportBottom = 11_000

const visible = boxes.filter(
  b => b.nodeId !== '0' && b.y + b.height > viewportTop && b.y < viewportBottom
)
console.log(`\nItems visible in viewport [${viewportTop}–${viewportBottom}px]: ${visible.length}`)
