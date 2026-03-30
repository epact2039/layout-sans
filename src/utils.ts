// LayoutSans — utils.ts
// Shared helpers: size resolution, clamping, padding extraction, solver context.

import type { Node, BoxRecord } from './types.js'

// ─── Padding helper ───────────────────────────────────────────────────────────

export interface PaddingBox {
  top: number
  right: number
  bottom: number
  left: number
}

export function getPaddingBox(node: Node): PaddingBox {
  const base = (node as { padding?: number }).padding ?? 0
  return {
    top: (node as { paddingTop?: number }).paddingTop ?? base,
    right: (node as { paddingRight?: number }).paddingRight ?? base,
    bottom: (node as { paddingBottom?: number }).paddingBottom ?? base,
    left: (node as { paddingLeft?: number }).paddingLeft ?? base,
  }
}

// ─── Size resolution ──────────────────────────────────────────────────────────

/** Read width or height from a node, returning NaN if not fixed. */
export function resolveNodeSize(
  node: Node,
  axis: 'width' | 'height',
  _containerSize: number,
): number {
  const val = (node as unknown as Record<string, unknown>)[axis]
  return typeof val === 'number' ? val : NaN
}

/** Clamp a value between optional min/max. */
export function clampSize(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min
  if (max !== undefined && value > max) return max
  return value
}

// ─── Solver context ───────────────────────────────────────────────────────────

/**
 * The engine passes a SolverContext into each solver so they can recursively
 * lay out child nodes without creating circular imports.
 */
export interface SolverContext {
  /**
   * Recursively solve a child node at the given position and size.
   * Returns the flat list of BoxRecords produced by that subtree.
   */
  solveNode(
    node: Node,
    nodeId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): BoxRecord[]

  /**
   * Measure a node to get its intrinsic size without fully solving it.
   * Used by flex cross-axis content-sizing.
   */
  measureNode(
    node: Node,
    nodeId: string,
    availableWidth: number,
    availableHeight: number,
  ): { width: number; height: number }
}
