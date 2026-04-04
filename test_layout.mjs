import { createLayout } from './dist/index.js'
import * as pretext from './node_modules/@chenglou/pretext/dist/layout.js'

const root = {
  type: 'flex',
  direction: 'column',
  width: 680,
  gap: 20,
  children: [
    { id: 'h1', type: 'heading', level: 1, content: 'Hello World', font: '700 32px Inter', lineHeight: 40, width: 680 },
    { id: 't1', type: 'text', content: 'First paragraph of text.', font: '15px Inter', lineHeight: 26, width: 680 },
    {
      id: 'row1', type: 'flex', direction: 'row', width: 680, gap: 16,
      children: [
        {
          id: 'lnk1', type: 'link', href: 'https://example.com',
          children: [
            { id: 'lt1', type: 'text', content: 'Link text here', font: '14px Inter', lineHeight: 22, width: 200 }
          ]
        }
      ]
    },
    { id: 't2', type: 'text', content: 'Second paragraph.', font: '15px Inter', lineHeight: 26, width: 680 },
  ]
}

const engine = createLayout(root).usePretext(pretext)
const boxes = engine.compute()

console.log('BoxRecord positions (should be strictly increasing y):')
for (const b of boxes) {
  console.log(`  ${b.nodeId.padEnd(8)} type=${b.nodeType.padEnd(8)} x=${String(Math.round(b.x)).padEnd(6)} y=${Math.round(b.y)}`)
}
