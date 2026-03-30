// LayoutSans demo — basic-flex.ts
// The simplest possible usage: two boxes in a row, one flex-grows.

import { createLayout } from '../src/index.js'
import type { Node } from '../src/index.js'

const root: Node = {
  type: 'flex',
  direction: 'row',
  width: 800,
  height: 600,
  gap: 16,
  children: [
    { type: 'box', flex: 1 },
    { type: 'box', width: 240 },
  ],
}

const boxes = createLayout(root).compute()

console.log('Basic flex layout:')
console.table(boxes)

// Expected output:
// ┌─────────┬──────────┬───┬───┬───────┬────────┐
// │ nodeId  │        x │ y │ … │ width │ height │
// ├─────────┼──────────┼───┼───┼───────┼────────┤
// │ 0       │        0 │ 0 │   │   800 │    600 │
// │ 0.0     │        0 │ 0 │   │   544 │    600 │  ← flex: 1 gets 800 - 240 - 16 gap
// │ 0.1     │      560 │ 0 │   │   240 │    600 │
// └─────────┴──────────┴───┴───┴───────┴────────┘
