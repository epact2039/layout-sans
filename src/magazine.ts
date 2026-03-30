// LayoutSans — magazine.ts
// Multi-column magazine layout: flows text content across N equal-width columns.
// Each column gets an equal share of the container width. Text flows top-to-bottom
// in column 1, then overflows into column 2, etc.

import type { MagazineNode, TextNode, BoxRecord } from './types.js'
import { getPaddingBox, type SolverContext } from './utils.js'
import { estimateFontSize, measureTextSync } from './measure.js'

export interface MagazineResult {
  records: BoxRecord[]
  width: number
  height: number
}

export function solveMagazine(
  node: MagazineNode,
  nodeId: string,
  containerWidth: number,
  containerHeight: number,
  ctx: SolverContext,
  pretext: typeof import('@chenglou/pretext') | null,
): MagazineResult {
  const padding = getPaddingBox(node)
  const innerW = containerWidth - padding.left - padding.right
  const innerH = containerHeight !== Infinity ? containerHeight - padding.top - padding.bottom : Infinity

  const cols = node.columnCount
  const colGap = node.columnGap ?? 16
  const colW = (innerW - colGap * (cols - 1)) / cols

  const records: BoxRecord[] = []

  // ── Collect text nodes ────────────────────────────────────────────────────
  let textNodes: TextNode[]
  if (node.content && !node.children?.length) {
    // Single string convenience prop — build TextNode without optional keys set to undefined
    const baseNode: TextNode = { type: 'text', content: node.content, width: colW }
    if (node.font !== undefined) baseNode.font = node.font
    if (node.lineHeight !== undefined) baseNode.lineHeight = node.lineHeight
    textNodes = [baseNode]
  } else {
    textNodes = node.children ?? []
  }

  const lineHeight = node.lineHeight ?? estimateFontSize(node.font ?? '16px sans-serif') * 1.4

  // ── Measure total height needed for all content at colW ───────────────────
  let totalContentHeight = 0
  const measuredNodes: Array<{ node: TextNode; height: number }> = []

  for (const textNode of textNodes) {
    const measured = measureTextSync(
      { ...textNode, width: colW },
      colW,
      pretext,
    )
    measuredNodes.push({ node: textNode, height: measured.height })
    totalContentHeight += measured.height
  }

  // ── Balance content across columns ────────────────────────────────────────
  // Target: equal height per column. We greedily fill each column.
  const targetColH = innerH !== Infinity ? innerH : totalContentHeight / cols

  let colIndex = 0
  let colY = padding.top
  const colX = (c: number) => padding.left + c * (colW + colGap)

  let maxColH = 0

  for (let ni = 0; ni < measuredNodes.length; ni++) {
    const { node: textNode, height } = measuredNodes[ni]!
    const childId = `${nodeId}.${ni}`

    // Check if this node overflows current column
    if (colIndex < cols - 1 && colY - padding.top + height > targetColH) {
      const remainingInCol = targetColH - (colY - padding.top)

      if (remainingInCol < lineHeight) {
        // Advance to next column immediately
        maxColH = Math.max(maxColH, colY - padding.top)
        colIndex++
        colY = padding.top
      } else {
        // Split text node across columns
        // Portion 1: fills remainder of this column
        const linesInFirst = Math.floor(remainingInFirst(remainingInCol, lineHeight))
        const h1 = linesInFirst * lineHeight

        records.push({
          nodeId: `${childId}.part0`,
          x: colX(colIndex),
          y: colY,
          width: colW,
          height: h1,
        })

        maxColH = Math.max(maxColH, colY - padding.top + h1)
        colIndex++
        colY = padding.top

        // Portion 2: rest goes into next column (simplified: place remainder)
        const h2 = height - h1
        if (h2 > 0 && colIndex < cols) {
          records.push({
            nodeId: `${childId}.part1`,
            x: colX(colIndex),
            y: colY,
            width: colW,
            height: h2,
          })
          colY += h2
          maxColH = Math.max(maxColH, colY - padding.top)
        }
        continue
      }
    }

    // Normal placement: entire node fits in current column
    records.push(...ctx.solveNode(
      { ...textNode, width: colW, height: height },
      childId,
      colX(colIndex),
      colY,
      colW,
      height,
    ))
    colY += height
    maxColH = Math.max(maxColH, colY - padding.top)
  }

  const computedHeight = innerH !== Infinity ? containerHeight : maxColH + padding.top + padding.bottom

  return { records, width: containerWidth, height: computedHeight }
}

function remainingInFirst(available: number, lineHeight: number): number {
  return Math.floor(available / lineHeight)
}
