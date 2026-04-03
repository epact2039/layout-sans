// LayoutSans — engine.ts
// The main layout orchestrator. Routes each node type to its solver, manages
// the recursion, and flattens the output into a BoxRecord[].

import type { Node, BoxRecord, LayoutOptions, FlexNode, GridNode, MagazineNode, AbsoluteNode, TextNode, BoxNode, LinkNode, HeadingNode } from './types.js'
import { solveFlex, solveFlexColumn, solveFlexRow, measureFlexSize } from './flex.js'
import { solveGrid, measureGridSize } from './grid.js'
import { solveMagazine } from './magazine.js'
import { solveAbsolute } from './absolute.js'
import { measureTextSync } from './measure.js'
import { getPaddingBox, type SolverContext } from './utils.js'

/** O(1)-stack push helper — never uses spread, safe at 100k+ records (Bug #2). */
function pushAll<T>(target: T[], source: T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]!)
}

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
        // Try the O(n) fast paths first (no 3-pass solver needed for simple cases)
        const fastCol = solveFlexColumn(node as FlexNode, nodeId, width, this.ctx)
        if (fastCol !== null) {
          const contH = node.height ?? fastCol.totalHeight
          const out: BoxRecord[] = [{ nodeId: id, x, y, width, height: contH, nodeType: 'flex' }]
          const children = fastCol.records
          for (let i = 0; i < children.length; i++) {
            const r = children[i]!
            out.push({ nodeId: r.nodeId, x: r.x + x, y: r.y + y, width: r.width, height: r.height, nodeType: r.nodeType })
          }
          return out
        }
        const fastRow = solveFlexRow(node as FlexNode, nodeId, height, this.ctx)
        if (fastRow !== null) {
          const contW = node.width ?? fastRow.totalWidth
          const out: BoxRecord[] = [{ nodeId: id, x, y, width: contW, height, nodeType: 'flex' }]
          const children = fastRow.records
          for (let i = 0; i < children.length; i++) {
            const r = children[i]!
            out.push({ nodeId: r.nodeId, x: r.x + x, y: r.y + y, width: r.width, height: r.height, nodeType: r.nodeType })
          }
          return out
        }
        const result = solveFlex(node as FlexNode, nodeId, width, height, this.ctx)
        const out: BoxRecord[] = [{ nodeId: id, x, y, width: result.width, height: result.height, nodeType: 'flex' }]
        pushAll(out, result.records)
        return out
      }

      case 'grid': {
        const result = solveGrid(node as GridNode, nodeId, width, height, this.ctx)
        const out: BoxRecord[] = [{ nodeId: id, x, y, width: result.width, height: result.height, nodeType: 'grid' }]
        pushAll(out, result.records)
        return out
      }

      case 'magazine': {
        const result = solveMagazine(node as MagazineNode, nodeId, width, height, this.ctx, this.pretext)
        const out: BoxRecord[] = [{ nodeId: id, x, y, width: result.width, height: result.height, nodeType: 'magazine' }]
        pushAll(out, result.records)
        return out
      }

      case 'absolute': {
        // Bug #1 fix: use result.x / result.y — not the first child's coords
        const result = solveAbsolute(node as AbsoluteNode, nodeId, x, y, width, height, this.ctx)
        const out: BoxRecord[] = [{ nodeId: id, x: result.x, y: result.y, width: result.width, height: result.height, nodeType: 'absolute' }]
        pushAll(out, result.records)
        return out
      }

      case 'text': {
        const measured = this.measureNode(node, nodeId, width, height)
        return [{ nodeId: id, x, y, width: measured.width, height: measured.height, nodeType: 'text', textContent: (node as TextNode).content }]
      }

      case 'heading': {
        const hn = node as HeadingNode
        const measured = this.measureNode(node, nodeId, width, height)
        return [{ nodeId: id, x, y, width: measured.width, height: measured.height, nodeType: 'heading', textContent: hn.content }]
      }

      case 'link': {
        // A link wraps children — solve them inside the link bounding box, then
        // emit the container record with href/target/rel followed by child records.
        const ln = node as LinkNode
        const autoRel = ln.target === '_blank' && ln.rel === undefined
          ? 'noopener noreferrer'
          : ln.rel
        const linkChildren = ln.children ?? []
        // Treat as an implicit flex column so children stack naturally.
        // exactOptionalPropertyTypes: build without undefined keys, then cast.
        // All fields are structurally valid FlexNode properties; the cast is safe.
        const syntheticFlex = {
          type: 'flex' as const,
          direction: 'column' as const,
          width: ln.width ?? width,
          height: ln.height ?? height,
          children: linkChildren,
          ...(ln.padding          !== undefined && { padding:       ln.padding }),
          ...(ln.paddingTop       !== undefined && { paddingTop:    ln.paddingTop }),
          ...(ln.paddingRight     !== undefined && { paddingRight:  ln.paddingRight }),
          ...(ln.paddingBottom    !== undefined && { paddingBottom: ln.paddingBottom }),
          ...(ln.paddingLeft      !== undefined && { paddingLeft:   ln.paddingLeft }),
        } as FlexNode
        const result = solveFlex(syntheticFlex, nodeId, width, height, this.ctx)
        const out: BoxRecord[] = [{
          nodeId: id, x, y,
          width: result.width, height: result.height,
          nodeType: 'link',
          href: ln.href,
          ...(ln.target  !== undefined && { target: ln.target }),
          ...(autoRel    !== undefined && { rel:    autoRel }),
        }]
        pushAll(out, result.records)
        return out
      }

      case 'box':
      default: {
        // A box with no children just occupies its given space
        const boxW = (node as BoxNode).width ?? width
        const boxH = (node as BoxNode).height ?? height
        return [{ nodeId: id, x, y, width: boxW, height: boxH, nodeType: 'box' }]
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

      case 'heading': {
        // Measure heading like text — font/lineHeight from the node.
        const hn = node as HeadingNode
        const syntheticText = {
          type: 'text' as const,
          content: hn.content,
          ...(hn.font       !== undefined && { font:       hn.font }),
          ...(hn.lineHeight !== undefined && { lineHeight: hn.lineHeight }),
          ...(hn.width      !== undefined && { width:      hn.width }),
        } as TextNode
        const w = hn.width ?? availableWidth
        const result = measureTextSync(syntheticText, w, this.pretext)
        return { width: result.width, height: result.height }
      }

      case 'link': {
        // A link's size is determined by its children — measure via full solve.
        const records = this.solveNode(node, 'measure', 0, 0, availableWidth, availableHeight)
        if (records.length === 0) return { width: availableWidth, height: availableHeight }
        return { width: records[0]!.width, height: records[0]!.height }
      }

      case 'flex':
      case 'grid':
      case 'magazine':
      case 'absolute': {
        // Perf #3 fix: use lightweight size-only paths instead of allocating all records
        if (node.type === 'flex') return measureFlexSize(node as FlexNode, availableWidth, availableHeight, this.ctx)
        if (node.type === 'grid') return measureGridSize(node as GridNode, availableWidth, availableHeight, this.ctx)
        // magazine / absolute: fall back to full solve but only read root size
        // (rare in practice — these are usually root-level, not measured by a parent)
        const records = this.solveNode(node, 'measure', 0, 0, availableWidth, availableHeight)
        if (records.length === 0) return { width: availableWidth, height: availableHeight }
        return { width: records[0]!.width, height: records[0]!.height }
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
