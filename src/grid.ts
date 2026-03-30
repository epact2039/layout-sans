// LayoutSans — grid.ts
// Basic 1D grid layout. Divides available space into equal-size cells.
// For MVP: uniform columns OR uniform rows (not full CSS Grid template).

import type { GridNode, BoxRecord } from './types.js'
import { getPaddingBox, type SolverContext } from './utils.js'

export interface GridResult {
  records: BoxRecord[]
  width: number
  height: number
}

export function solveGrid(
  node: GridNode,
  nodeId: string,
  containerWidth: number,
  containerHeight: number,
  ctx: SolverContext,
): GridResult {
  const padding = getPaddingBox(node)
  const innerW = containerWidth - padding.left - padding.right
  const innerH = containerHeight - padding.top - padding.bottom

  const children = node.children ?? []
  const colGap = node.columnGap ?? node.gap ?? 0
  const rowGap = node.rowGap ?? node.gap ?? 0

  const records: BoxRecord[] = []

  // ── Column-based grid ─────────────────────────────────────────────────────
  if (node.columns !== undefined) {
    const cols = node.columns
    const cellW = (innerW - colGap * (cols - 1)) / cols
    const rows = Math.ceil(children.length / cols)

    let cellH: number
    if (node.height !== undefined) {
      cellH = (innerH - rowGap * (rows - 1)) / rows
    } else {
      // Content-sized rows: measure each row's tallest child
      cellH = 0
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col
          if (idx >= children.length) break
          const child = children[idx]!
          const measured = ctx.measureNode(child, `${nodeId}.${idx}`, cellW, Infinity)
          cellH = Math.max(cellH, measured.height)
        }
      }
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = padding.left + col * (cellW + colGap)
      const y = padding.top + row * (cellH + rowGap)
      const childId = `${nodeId}.${i}`
      records.push(...ctx.solveNode(child, childId, x, y, cellW, cellH))
    }

    const totalH = rows * cellH + (rows - 1) * rowGap + padding.top + padding.bottom
    return { records, width: containerWidth, height: node.height ?? totalH }
  }

  // ── Row-based grid ────────────────────────────────────────────────────────
  if (node.rows !== undefined) {
    const rows = node.rows
    const cellH = (innerH - rowGap * (rows - 1)) / rows
    const cols = Math.ceil(children.length / rows)
    const cellW = (innerW - colGap * (cols - 1)) / cols

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      const row = i % rows
      const col = Math.floor(i / rows)
      const x = padding.left + col * (cellW + colGap)
      const y = padding.top + row * (cellH + rowGap)
      const childId = `${nodeId}.${i}`
      records.push(...ctx.solveNode(child, childId, x, y, cellW, cellH))
    }

    return { records, width: containerWidth, height: containerHeight }
  }

  // ── Fallback: single column (equivalent to flex column, no grow) ──────────
  let y = padding.top
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const childId = `${nodeId}.${i}`
    const measured = ctx.measureNode(child, childId, innerW, Infinity)
    records.push(...ctx.solveNode(child, childId, padding.left, y, innerW, measured.height))
    y += measured.height + rowGap
  }

  const totalH = y - rowGap + padding.bottom
  return { records, width: containerWidth, height: totalH }
}
