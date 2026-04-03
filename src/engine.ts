// LayoutSans — engine.ts (v0.2)
// The main layout orchestrator. Routes each node type to its solver, manages
// the recursion, and flattens the output into a BoxRecord[].
//
// v0.2 additions:
//   • textLineMap — per-node PreparedTextWithSegments + LayoutLine[] data,
//     populated during compute() for every text/heading node.
//   • buildIndex() — off-critical-path R-Tree construction.
//   • selection — singleton SelectionState owned by this engine.
//   • getAllRecords() / getTextLineData() / getOrderedTextNodeIds() — data
//     access API for the interaction and render layers.
//   • setSelection() / clearSelection() — programmatic selection control.
//   • Satisfies TextLayoutSource (structural interface from selection.ts).

import type {
  Node, BoxRecord, LayoutOptions,
  FlexNode, GridNode, MagazineNode, AbsoluteNode, TextNode, BoxNode, LinkNode, HeadingNode,
  TextLineData,
} from './types.js'
import { solveFlex, solveFlexColumn, solveFlexRow, measureFlexSize } from './flex.js'
import { solveGrid, measureGridSize } from './grid.js'
import { solveMagazine } from './magazine.js'
import { solveAbsolute } from './absolute.js'
import { measureTextSync, measureTextWithLinesSync } from './measure.js'
import { type SolverContext } from './utils.js'
import { SpatialIndex } from './rtree.js'
import { SelectionState, charOffsetToCursor } from './selection.js'

/** O(1)-stack push helper — never uses spread, safe at 100k+ records. */
function pushAll<T>(target: T[], source: T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]!)
}

export class LayoutEngine {
  private root: Node
  private options: LayoutOptions
  private pretext: typeof import('@chenglou/pretext') | null = null

  // ── v0.2 state ──────────────────────────────────────────────────────────────

  /**
   * Per-node segment/line data. Populated by compute() for every text/heading
   * node when Pretext is available. The selection engine reads this during
   * mousemove without calling measureText(). Satisfies TextLayoutSource.
   */
  readonly textLineMap: Map<string, TextLineData> = new Map()

  /**
   * Node ids of text/heading nodes in document (depth-first tree) order.
   * Populated during compute(). Used by normalizeSelection() and paintSelection().
   */
  private _orderedTextNodeIds: string[] = []

  /** Last compute() result — stored so buildIndex() can read it off the hot path. */
  private _lastRecords: BoxRecord[] = []

  /** Spatial R-Tree index. Null until buildIndex() resolves. */
  private _spatialIndex: SpatialIndex | null = null

  /** True once buildIndex() has completed successfully. */
  private _indexReady = false

  /**
   * Hit-tests queued while the index was still building.
   * Replayed immediately after buildIndex() resolves.
   */
  private _pendingHitTests: Array<{ x: number; y: number; resolve: (ids: string[]) => void }> = []

  /** Singleton selection state. Read by the canvas RAF loop and Proxy Caret. */
  readonly selection: SelectionState = new SelectionState()

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(root: Node, options: LayoutOptions = {}) {
    this.root = root
    this.options = options
  }

  /**
   * Inject a pre-loaded Pretext module for synchronous text measurement.
   * Must be called before compute() for selection support to work.
   */
  usePretext(mod: typeof import('@chenglou/pretext')): this {
    this.pretext = mod
    return this
  }

  // ── compute() ───────────────────────────────────────────────────────────────

  /**
   * Compute the layout. Returns a flat array of positioned BoxRecords.
   *
   * v0.2: Also populates `textLineMap` and `_orderedTextNodeIds` for every
   * text/heading node that has Pretext available. Invalidates the spatial index —
   * call buildIndex() after re-computing.
   */
  compute(): BoxRecord[] {
    this.textLineMap.clear()
    this._orderedTextNodeIds = []
    this._spatialIndex = null
    this._indexReady = false
    this._pendingHitTests = []

    const rootW = this.options.width ?? this.root.width ?? 0
    const rootH = this.options.height ?? this.root.height ?? 0
    this._lastRecords = this.ctx.solveNode(this.root, '0', 0, 0, rootW, rootH)
    return this._lastRecords
  }

  // ── buildIndex() ────────────────────────────────────────────────────────────

  /**
   * Build the Spatial R-Tree index from the last compute() result.
   *
   * Runs off the critical path via requestIdleCallback (fallback: setTimeout).
   * Returns a Promise that resolves when the index is ready. Hit-tests
   * that arrive before this resolves are queued and replayed automatically.
   */
  buildIndex(): Promise<void> {
    return new Promise<void>((resolve) => {
      const build = () => {
        this._spatialIndex = new SpatialIndex(this._lastRecords)
        this._indexReady = true

        // Replay any hit-tests that arrived during construction.
        const queued = this._pendingHitTests.splice(0)
        for (const item of queued) {
          item.resolve(this._spatialIndex.queryPoint(item.x, item.y))
        }

        resolve()
      }

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => build(), { timeout: 100 })
      } else {
        setTimeout(build, 0)
      }
    })
  }

  // ── Data access ─────────────────────────────────────────────────────────────

  /** All BoxRecords from the last compute(), in tree-traversal order. */
  getAllRecords(): BoxRecord[] {
    return this._lastRecords
  }

  /**
   * TextLineData for a specific text or heading node.
   * Returns null for non-text nodes or when Pretext was unavailable.
   */
  getTextLineData(nodeId: string): TextLineData | null {
    return this.textLineMap.get(nodeId) ?? null
  }

  /**
   * Node ids of all text/heading nodes in document order.
   * Satisfies the TextLayoutSource interface used by selection helpers.
   */
  getOrderedTextNodeIds(): readonly string[] {
    return this._orderedTextNodeIds
  }

  /** The spatial R-Tree index. Null until buildIndex() resolves. */
  get spatialIndex(): SpatialIndex | null {
    return this._spatialIndex
  }

  /**
   * Async hit-test. If the index isn't ready yet, queues the query
   * and resolves when buildIndex() completes.
   *
   * @param x  World X (canvas-space, scrollY already added by caller).
   * @param y  World Y (canvas-space, scrollY already added by caller).
   */
  queryPoint(x: number, y: number, maxResults = 1): Promise<string[]> {
    if (this._indexReady && this._spatialIndex) {
      return Promise.resolve(this._spatialIndex.queryPoint(x, y, maxResults))
    }
    return new Promise<string[]>((resolve) => {
      this._pendingHitTests.push({ x, y, resolve })
    })
  }

  // ── Selection API ────────────────────────────────────────────────────────────

  /**
   * Programmatically set the selection to a character range.
   * startChar / endChar are grapheme-counted offsets into the node's text.
   * No-op if the node ids are not found in textLineMap.
   */
  setSelection(
    startNodeId: string,
    startChar: number,
    endNodeId: string,
    endChar: number,
  ): void {
    const startTld = this.textLineMap.get(startNodeId)
    const endTld   = this.textLineMap.get(endNodeId)
    if (!startTld || !endTld) return

    const anchor = charOffsetToCursor(startTld.prepared, startChar, startTld)
    const focus  = charOffsetToCursor(endTld.prepared, endChar, endTld)
    this.selection.set({ anchor, focus })
  }

  /** Clear the active selection. */
  clearSelection(): void {
    this.selection.clear()
  }

  /**
   * Copy the currently selected text to the OS clipboard.
   * Returns false when nothing is selected or clipboard API is unavailable.
   */
  async copySelectedText(): Promise<boolean> {
    const range = this.selection.get()
    if (!range) return false

    const { getSelectedText } = await import('./selection.js')
    const text = getSelectedText(range, this)
    if (!text) return false

    try {
      // navigator.clipboard requires a secure context (HTTPS / localhost).
      // Cast via unknown to avoid lib-specific Clipboard API type gaps.
      await (navigator as unknown as { clipboard: { writeText(s: string): Promise<void> } })
        .clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /**
   * Extract the plain text of the entire layout tree in document order.
   * Each visual line is separated by a newline.
   */
  extractText(): string {
    const parts: string[] = []
    for (const id of this._orderedTextNodeIds) {
      const tld = this.textLineMap.get(id)
      if (tld) {
        for (const line of tld.lines) parts.push(line.text)
      }
    }
    return parts.join('\n')
  }

  // ── Context (bound to this engine instance) ─────────────────────────────────

  private ctx: SolverContext = {
    solveNode: (node: Node, nodeId: string, x: number, y: number, width: number, height: number): BoxRecord[] => {
      return this.solveNode(node, nodeId, x, y, width, height)
    },
    measureNode: (node: Node, nodeId: string, availableWidth: number, availableHeight: number): { width: number; height: number } => {
      return this.measureNode(node, nodeId, availableWidth, availableHeight)
    },
  }

  // ── solveNode ───────────────────────────────────────────────────────────────

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
        const result = solveAbsolute(node as AbsoluteNode, nodeId, x, y, width, height, this.ctx)
        const out: BoxRecord[] = [{ nodeId: id, x: result.x, y: result.y, width: result.width, height: result.height, nodeType: 'absolute' }]
        pushAll(out, result.records)
        return out
      }

      case 'text': {
        return this.solveTextNode(node as TextNode, id, x, y, width)
      }

      case 'heading': {
        return this.solveHeadingNode(node as HeadingNode, id, x, y, width)
      }

      case 'link': {
        const ln = node as LinkNode
        const autoRel = ln.target === '_blank' && ln.rel === undefined
          ? 'noopener noreferrer'
          : ln.rel
        const linkChildren = ln.children ?? []
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
        const boxW = (node as BoxNode).width ?? width
        const boxH = (node as BoxNode).height ?? height
        return [{ nodeId: id, x, y, width: boxW, height: boxH, nodeType: 'box' }]
      }
    }
  }

  /**
   * Solve a text node, building TextLineData alongside the BoxRecord.
   *
   * Prefers measureTextWithLinesSync() — produces TextLineData with zero extra
   * measureText() calls at runtime. Falls back to measureTextSync() when
   * Pretext is unavailable (node becomes non-selectable).
   */
  private solveTextNode(node: TextNode, id: string, x: number, y: number, width: number): BoxRecord[] {
    const w = node.width ?? width

    if (this.pretext) {
      const result = measureTextWithLinesSync(node, w, this.pretext, id, x, y)
      if (result) {
        this.textLineMap.set(id, result.textLineData)
        this._orderedTextNodeIds.push(id)
        return [{ nodeId: id, x, y, width: result.width, height: result.height, nodeType: 'text', textContent: node.content }]
      }
    }

    const measured = measureTextSync(node, w, this.pretext)
    return [{ nodeId: id, x, y, width: measured.width, height: measured.height, nodeType: 'text', textContent: node.content }]
  }

  /**
   * Solve a heading node. Headings are measured identically to text nodes;
   * the level surfaces in the Shadow Semantic Tree (Phase 3).
   */
  private solveHeadingNode(node: HeadingNode, id: string, x: number, y: number, width: number): BoxRecord[] {
    const w = node.width ?? width
    const syntheticText: TextNode = {
      type: 'text',
      content: node.content,
      ...(node.font       !== undefined && { font:       node.font }),
      ...(node.lineHeight !== undefined && { lineHeight: node.lineHeight }),
      ...(node.width      !== undefined && { width:      node.width }),
    }

    if (this.pretext) {
      const result = measureTextWithLinesSync(syntheticText, w, this.pretext, id, x, y)
      if (result) {
        this.textLineMap.set(id, result.textLineData)
        this._orderedTextNodeIds.push(id)
        return [{ nodeId: id, x, y, width: result.width, height: result.height, nodeType: 'heading', textContent: node.content }]
      }
    }

    const measured = measureTextSync(syntheticText, w, this.pretext)
    return [{ nodeId: id, x, y, width: measured.width, height: measured.height, nodeType: 'heading', textContent: node.content }]
  }

  // ── measureNode ─────────────────────────────────────────────────────────────

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
        const records = this.solveNode(node, 'measure', 0, 0, availableWidth, availableHeight)
        if (records.length === 0) return { width: availableWidth, height: availableHeight }
        return { width: records[0]!.width, height: records[0]!.height }
      }

      case 'flex':
      case 'grid':
      case 'magazine':
      case 'absolute': {
        if (node.type === 'flex') return measureFlexSize(node as FlexNode, availableWidth, availableHeight, this.ctx)
        if (node.type === 'grid') return measureGridSize(node as GridNode, availableWidth, availableHeight, this.ctx)
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
 *
 * @example
 * const engine = createLayout(root).usePretext(pretext)
 * const boxes = engine.compute()
 * await engine.buildIndex()
 */
export function createLayout(root: Node, options?: LayoutOptions): LayoutEngine {
  return new LayoutEngine(root, options)
}
