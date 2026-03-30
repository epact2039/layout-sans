// LayoutSans — engine.ts
// The main layout orchestrator. Routes each node type to its solver, manages
// the recursion, and flattens the output into a BoxRecord[].

import type { Node, BoxRecord, LayoutOptions, FlexNode, GridNode, MagazineNode, AbsoluteNode, TextNode, BoxNode } from './types.js'
import { solveFlex, solveFlexColumn } from './flex.js'
import { solveGrid } from './grid.js'
import { solveMagazine } from './magazine.js'
import { solveAbsolute } from './absolute.js'
import { measureTextSync } from './measure.js'
import { getPaddingBox, type SolverContext } from './utils.js'

export class LayoutEngine {
  private root: Node
  private options: LayoutOptions
  private pretext: typeof import('@chenglou/pretext') | null = null

  constructor(root: Node, options: LayoutOptions = {}) {
    this.root = root
    this.options = options
  }

  /**
   * Inject a pre-loaded Pretext module for synchronous text measurement.
   * Call this before compute() if you want accurate text sizing.
   */
  usePretext(mod: typeof import('@chenglou/pretext')): this {
    this.pretext = mod
    return this
  }

  /**
   * Compute the layout. Returns a flat array of positioned BoxRecords.
   * Each record maps to one node in the input tree via nodeId.
   */
  compute(): BoxRecord[] {
    const rootW = this.options.width ?? this.root.width ?? 0
    const rootH = this.options.height ?? this.root.height ?? 0
    return this.ctx.solveNode(this.root, '0', 0, 0, rootW, rootH)
  }

  // ── Context (bound to this engine instance) ─────────────────────────────

  private ctx: SolverContext = {
    solveNode: (node: Node, nodeId: string, x: number, y: number, width: number, height: number): BoxRecord[] => {
      return this.solveNode(node, nodeId, x, y, width, height)
    },
    measureNode: (node: Node, nodeId: string, availableWidth: number, availableHeight: number): { width: number; height: number } => {
      return this.measureNode(node, nodeId, availableWidth, availableHeight)
    },
  }

  private solveNode(
    node: Node,
    nodeId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): BoxRecord[] {
    const id = node.id ?? nodeId

    switch (node.type) {
      case 'flex': {
        // Try the O(n) fast path first (fixed-size column = virtual list case)
        const fast = solveFlexColumn(node as FlexNode, nodeId, width, this.ctx)
        if (fast !== null) {
          const contH = node.height ?? fast.totalHeight
          const container: BoxRecord = { nodeId: id, x, y, width, height: contH }
          const children = fast.records
          // Offset children to container's absolute position in one pass
          for (let i = 0; i < children.length; i++) {
            const r = children[i]!
            children[i] = { nodeId: r.nodeId, x: r.x + x, y: r.y + y, width: r.width, height: r.height }
          }
          return [container, ...children]
        }
        const result = solveFlex(node as FlexNode, nodeId, width, height, this.ctx)
        const self: BoxRecord = { nodeId: id, x, y, width: result.width, height: result.height }
        return [self, ...result.records]
      }

      case 'grid': {
        const result = solveGrid(node as GridNode, nodeId, width, height, this.ctx)
        const self: BoxRecord = { nodeId: id, x, y, width: result.width, height: result.height }
        return [self, ...result.records]
      }

      case 'magazine': {
        const result = solveMagazine(node as MagazineNode, nodeId, width, height, this.ctx, this.pretext)
        const self: BoxRecord = { nodeId: id, x, y, width: result.width, height: result.height }
        return [self, ...result.records]
      }

      case 'absolute': {
        const result = solveAbsolute(node as AbsoluteNode, nodeId, x, y, width, height, this.ctx)
        const self: BoxRecord = { nodeId: id, x: result.records[0]?.x ?? x, y: result.records[0]?.y ?? y, width: result.width, height: result.height }
        return [self, ...result.records]
      }

      case 'text': {
        const measured = this.measureNode(node, nodeId, width, height)
        return [{ nodeId: id, x, y, width: measured.width, height: measured.height }]
      }

      case 'box':
      default: {
        // A box with no children just occupies its given space
        const boxW = (node as BoxNode).width ?? width
        const boxH = (node as BoxNode).height ?? height
        return [{ nodeId: id, x, y, width: boxW, height: boxH }]
      }
    }
  }

  private measureNode(
    node: Node,
    _nodeId: string,
    availableWidth: number,
    availableHeight: number,
  ): { width: number; height: number } {
    switch (node.type) {
      case 'text': {
        const w = node.width ?? availableWidth
        const result = measureTextSync(node as TextNode, w, this.pretext)
        return { width: result.width, height: result.height }
      }

      case 'box': {
        return {
          width: node.width ?? availableWidth,
          height: node.height ?? availableHeight,
        }
      }

      case 'flex':
      case 'grid':
      case 'magazine':
      case 'absolute': {
        // For measurement purposes, run the full solver and report its size
        const records = this.solveNode(node, 'measure', 0, 0, availableWidth, availableHeight)
        if (records.length === 0) return { width: availableWidth, height: availableHeight }
        const root = records[0]!
        return { width: root.width, height: root.height }
      }

      default:
        return { width: availableWidth, height: availableHeight }
    }
  }
}

/**
 * Create a LayoutEngine for a node tree.
 * Call .compute() to get the flat BoxRecord[].
 *
 * @example
 * const engine = createLayout(root)
 * const boxes = engine.compute()
 */
export function createLayout(root: Node, options?: LayoutOptions): LayoutEngine {
  return new LayoutEngine(root, options)
}
