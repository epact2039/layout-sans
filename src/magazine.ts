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

    // ── Limit #7 fix: spill a tall node across as many columns as needed ────
    // Old code only created part0 + part1 — a block taller than two columns
    // would be truncated. The new code loops until all height is placed.
    let remaining = height
    let partIndex = 0

    while (remaining > 0) {
      const spaceInCol = targetColH - (colY - padding.top)

      if (remaining <= spaceInCol || colIndex >= cols - 1) {
        // Fits in the current column (or we're on the last column — place it all)
        const h = remaining
        if (partIndex === 0) {
          // Common case: node fits without splitting — use ctx.solveNode for
          // correct record type (text node sizing, child records, etc.)
          // Bug #2 fix: loop instead of spread
          const childRecords = ctx.solveNode(
            { ...textNode, width: colW, height: h },
            childId,
            colX(colIndex),
            colY,
            colW,
            h,
          )
          for (let ci = 0; ci < childRecords.length; ci++) records.push(childRecords[ci]!)
        } else {
          // This is a continuation slice — emit a plain sized record
          records.push({
            nodeId: `${childId}.part${partIndex}`,
            x: colX(colIndex),
            y: colY,
            width: colW,
            height: h,
          })
        }
        colY += h
        maxColH = Math.max(maxColH, colY - padding.top)
        remaining = 0
      } else {
        // Block overflows this column — fill it to the top then advance
        if (spaceInCol < lineHeight) {
          // Not even a single line fits — just advance the column
          maxColH = Math.max(maxColH, colY - padding.top)
          colIndex++
          colY = padding.top
        } else {
          // Fill this column with as many complete lines as fit
          const linesHere = Math.floor(spaceInCol / lineHeight)
          const h = linesHere * lineHeight

          records.push({
            nodeId: `${childId}.part${partIndex}`,
            x: colX(colIndex),
            y: colY,
            width: colW,
            height: h,
          })

          maxColH = Math.max(maxColH, colY - padding.top + h)
          remaining -= h
          partIndex++
          colIndex++
          colY = padding.top
        }
      }
    }
  }

  const computedHeight = innerH !== Infinity ? containerHeight : maxColH + padding.top + padding.bottom

  return { records, width: containerWidth, height: computedHeight }
}
