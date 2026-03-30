// LayoutSans demo — magazine.ts
// Multi-column magazine layout: long text flows across 3 columns.

import { createLayout } from '../src/index.js'
import type { Node } from '../src/index.js'

const articleText =
  'Typography is the art and technique of arranging type to make written language legible, readable, and appealing when displayed. The arrangement of type involves selecting typefaces, point sizes, line lengths, line-spacing, and letter-spacing, and adjusting the space between pairs of letters. The term typography is also applied to the style, arrangement, and appearance of the letters, numbers, and symbols created by the process. Type design is a closely related craft, sometimes considered part of typography; most typographers do not design typefaces, and some type designers do not consider themselves typographers. Typography also may be used as a decorative device, unrelated to communication of information.'

const root: Node = {
  type: 'magazine',
  width: 900,
  height: 400,
  columnCount: 3,
  columnGap: 24,
  content: articleText,
  font: '16px Georgia',
  lineHeight: 24,
}

const boxes = createLayout(root).compute()

console.log(`Magazine layout — ${boxes.length} box records:`)
console.table(boxes)
