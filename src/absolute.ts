// LayoutSans — absolute.ts
// Absolute positioning solver. Places a node at exact coordinates relative to
// its containing box. Supports top/right/bottom/left with width/height.

import type { AbsoluteNode, BoxRecord } from './types.js'
import { getPaddingBox, type SolverContext } from './utils.js'

export interface AbsoluteResult {
  records: BoxRecord[]
  width: number
  height: number
}

export function solveAbsolute(
  node: AbsoluteNode,
  nodeId: string,
  containerX: number,
  containerY: number,
  containerWidth: number,
  containerHeight: number,
  ctx: SolverContext,
): AbsoluteResult {
  const padding = getPaddingBox(node)

  // Resolve position from TRBL props
  let x: number
  let y: number
  let w: number
  let h: number

  // Width: explicit > (left + right stretch) > 0
  if (node.width !== undefined) {
    w = node.width
  } else if (node.left !== undefined && node.right !== undefined) {
    w = containerWidth - node.left - node.right
  } else {
    w = containerWidth // fallback: fill container
  }

  // Height: explicit > (top + bottom stretch) > 0
  if (node.height !== undefined) {
    h = node.height
  } else if (node.top !== undefined && node.bottom !== undefined) {
    h = containerHeight - node.top - node.bottom
  } else {
    h = containerHeight // fallback
  }

  // X position
  if (node.left !== undefined) {
    x = containerX + node.left
  } else if (node.right !== undefined) {
    x = containerX + containerWidth - node.right - w
  } else {
    x = containerX
  }

  // Y position
  if (node.top !== undefined) {
    y = containerY + node.top
  } else if (node.bottom !== undefined) {
    y = containerY + containerHeight - node.bottom - h
  } else {
    y = containerY
  }

  const records: BoxRecord[] = []

  // Recurse into children
  const children = node.children ?? []
  const innerW = w - padding.left - padding.right
  const innerH = h - padding.top - padding.bottom

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const childId = `${nodeId}.${i}`
    records.push(...ctx.solveNode(child, childId, x + padding.left, y + padding.top, innerW, innerH))
  }

  return { records, width: w, height: h }
}
