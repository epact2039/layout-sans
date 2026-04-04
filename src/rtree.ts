// LayoutSans — rtree.ts
// Static Sorted Packed R-Tree (SSP-RTree) with OMT/STR packing.
//
// Architecture constraints (PRD §3.2):
//   • Backed by a single flat Float32Array — zero GC overhead in hot path.
//   • Each node occupies exactly 5 floats: [minX, minY, maxX, maxY, data].
//     - Leaf:     data = original record index (for nodeIds[] lookup).
//     - Internal: data = first child's item index in the flat array.
//   • Branching factor B = 16 → O(log₁₆ n) query depth.
//   • Construction: O(n log n) STR sort → < 15 ms at 100 k items on M1/V8.
//   • queryPoint / queryRect: stack-based DFS, no allocation per query.
//   • getRecord: O(1) HashMap lookup.
//
// Zero external dependencies.

import type { BoxRecord } from './types.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ── Internal constants ────────────────────────────────────────────────────────

/** Floats per tree node. [minX, minY, maxX, maxY, data] */
const STRIDE = 5

/**
 * Max entries per internal node (branching factor).
 * 16 gives a tree depth of ≤ 5 for 100 k items and keeps the inner loop of
 * queryPoint tight enough to avoid branch misprediction overhead.
 */
const B = 16

// ── SpatialIndex ──────────────────────────────────────────────────────────────

export class SpatialIndex {
  /**
   * Packed flat tree.
   *
   * Memory layout (contiguous):
   *   [level-0 leaves 0..n-1] [level-1 nodes n..] [level-2 nodes ..] ... [root]
   *
   * levelBounds[L]     = first item index of level L.
   * levelBounds[L + 1] = first item index of level L+1  (= exclusive end of L).
   * levelBounds[numLevels] is the sentinel (= total item count).
   */
  private readonly treeData: Float32Array

  /**
   * levelBounds[i] is the item index (not byte offset) where level i starts.
   * Level 0 = leaves, level numLevels-1 = root (single node).
   * Last element is a sentinel equal to total item count.
   */
  private readonly levelBounds: Int32Array

  /**
   * nodeId for each leaf, in STR-sorted order.
   * Indexed by leaf item index (0 … n-1), so queryPoint/queryRect can return
   * the nodeId with a single array read — no secondary lookup needed.
   */
  private readonly sortedNodeIds: ReadonlyArray<string>

  /** O(1) record lookup keyed by nodeId. Built once, never mutated. */
  private readonly byId: Map<string, BoxRecord>

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(records: BoxRecord[]) {
    const n = records.length

    // O(1) record access is always available, even for the empty case.
    this.byId = new Map(records.map(r => [r.nodeId, r]))

    if (n === 0) {
      this.treeData       = new Float32Array(0)
      this.levelBounds    = new Int32Array([0])
      this.sortedNodeIds  = []
      return
    }

    // ── 1. STR (Sort-Tile-Recursive) packing — O(n log n) ───────────────────
    //
    // Pass 1: global sort by centerY  → items tile into horizontal rows.
    // Pass 2: within each vertical strip, sort by centerX  → items tile into
    //         columns. The strip width is chosen so that each strip produces
    //         roughly √(n/B) leaf nodes, giving a near-square packing.
    //
    // Reference: OMT packing as described in PRD §3.2.

    // Work with a plain number[] during sorting — V8 optimises this better
    // than Uint32Array.prototype.sort with a custom comparator.
    const idx: number[] = new Array(n)
    for (let i = 0; i < n; i++) idx[i] = i

    idx.sort((a, b) => {
      const ra = records[a]!, rb = records[b]!
      return (ra.y + ra.height * 0.5) - (rb.y + rb.height * 0.5)
    })

    // Number of leaf nodes (each holds up to B items).
    const numLeafNodes = Math.ceil(n / B)
    // Number of vertical strips — √(numLeafNodes) keeps strips roughly square.
    const numStrips    = Math.ceil(Math.sqrt(numLeafNodes))
    // Items per strip (last strip may be smaller).
    const stripSize    = Math.ceil(n / numStrips)

    for (let s = 0; s < numStrips; s++) {
      const lo = s * stripSize
      const hi = Math.min(lo + stripSize, n)
      // Extract, sort by centerX, write back — avoids a custom range-sort helper.
      const strip = idx.slice(lo, hi)
      strip.sort((a, b) => {
        const ra = records[a]!, rb = records[b]!
        return (ra.x + ra.width * 0.5) - (rb.x + rb.width * 0.5)
      })
      for (let i = lo; i < hi; i++) idx[i] = strip[i - lo]!
    }

    // ── 2. Compute level bounds ──────────────────────────────────────────────
    //
    // levelBounds is built bottom-up: we count how many nodes exist at each
    // tree level (leaves → root) and accumulate their starting item indices.

    const levelBoundsArr: number[] = [0]
    let levelSize = n
    let totalItems = 0

    while (true) {
      totalItems += levelSize
      levelBoundsArr.push(totalItems)
      if (levelSize === 1) break              // reached the root
      levelSize = Math.ceil(levelSize / B)
    }

    const numLevels = levelBoundsArr.length - 1   // leaf level + internal levels

    // ── 3. Allocate the flat typed array ─────────────────────────────────────
    //
    // Float32Array is sufficient: item indices ≤ totalItems ≤ ~106 k at 100 k
    // records, which is well within the exact-integer range of float32 (2²⁴).

    const data = new Float32Array(totalItems * STRIDE)

    // ── 4. Fill leaf level (level 0) ────────────────────────────────────────

    const nodeIds: string[] = new Array(n)

    for (let i = 0; i < n; i++) {
      const origIdx = idx[i]!
      const r       = records[origIdx]!
      const off     = i * STRIDE
      data[off]     = r.x
      data[off + 1] = r.y
      data[off + 2] = r.x + r.width
      data[off + 3] = r.y + r.height
      data[off + 4] = origIdx   // informational; queries use sortedNodeIds[i]
      nodeIds[i]    = r.nodeId
    }

    // ── 5. Build internal levels bottom-up ───────────────────────────────────
    //
    // For each level L (0 = leaves), group its items into blocks of B and
    // compute a tight bounding box per block — that block becomes one node at
    // level L+1. Store the first child's item index in data[parentOff + 4].

    for (let lvl = 0; lvl < numLevels - 1; lvl++) {
      const childStart  = levelBoundsArr[lvl]!
      const childEnd    = levelBoundsArr[lvl + 1]!
      const parentStart = childEnd                  // parents follow children

      let pi = parentStart   // parent item index (incremented per block)

      for (let ci = childStart; ci < childEnd; ci += B) {
        const blockEnd = Math.min(ci + B, childEnd)

        let minX = Infinity, minY = Infinity
        let maxX = -Infinity, maxY = -Infinity

        for (let c = ci; c < blockEnd; c++) {
          const o = c * STRIDE
          if (data[o]!     < minX) minX = data[o]!
          if (data[o + 1]! < minY) minY = data[o + 1]!
          if (data[o + 2]! > maxX) maxX = data[o + 2]!
          if (data[o + 3]! > maxY) maxY = data[o + 3]!
        }

        const po = pi * STRIDE
        data[po]     = minX
        data[po + 1] = minY
        data[po + 2] = maxX
        data[po + 3] = maxY
        data[po + 4] = ci   // first child's item index
        pi++
      }
    }

    this.treeData      = data
    this.levelBounds   = new Int32Array(levelBoundsArr)
    this.sortedNodeIds = nodeIds
  }

  // ── Public query API ─────────────────────────────────────────────────────────

  /**
   * Point hit-test.
   *
   * Returns the nodeIds of up to `maxResults` records whose bounding box
   * contains the point (x, y). Default maxResults = 1 for the cursor hot path.
   *
   * Complexity: O(log₁₆ n) comparisons in the best case (non-overlapping layout);
   * O(k · log n) where k is the number of hits in pathological overlap cases.
   */
  queryPoint(x: number, y: number, maxResults = 1): string[] {
    if (this.treeData.length === 0) return []
    const results: string[] = []
    this.traverse(
      (minX, minY, maxX, maxY) => x >= minX && x <= maxX && y >= minY && y <= maxY,
      results,
      maxResults,
    )
    return results
  }

  /**
   * Rectangular range query.
   *
   * Returns all nodeIds whose bounding box overlaps the given bbox.
   * Two bboxes "overlap" if they share any area, including touching edges.
   */
  queryRect(bbox: BBox): string[] {
    if (this.treeData.length === 0) return []
    const { minX, minY, maxX, maxY } = bbox
    const results: string[] = []
    this.traverse(
      (nMinX, nMinY, nMaxX, nMaxY) =>
        minX <= nMaxX && maxX >= nMinX && minY <= nMaxY && maxY >= nMinY,
      results,
      Infinity,
    )
    return results
  }

  /**
   * O(1) record lookup by nodeId.
   *
   * Returns null if nodeId was not in the records array passed to the constructor.
   */
  getRecord(nodeId: string): BoxRecord | null {
    return this.byId.get(nodeId) ?? null
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Generic stack-based DFS traversal shared by queryPoint and queryRect.
   *
   * `test(minX, minY, maxX, maxY)` returns true if a node's bbox passes the
   * spatial predicate (point containment OR rect overlap). The same predicate
   * is applied at every level — inner nodes prune entire subtrees; leaf nodes
   * produce results.
   *
   * The stack stores interleaved [itemIndex, level] pairs to avoid object
   * allocation. Pre-sizing to 128 entries covers trees up to depth 64 × B/2
   * without reallocation.
   */
  private traverse(
    test: (minX: number, minY: number, maxX: number, maxY: number) => boolean,
    results: string[],
    maxResults: number,
  ): void {
    const { treeData: data, levelBounds, sortedNodeIds } = this
    const numLevels = levelBounds.length - 1

    // Stack: pairs of [itemIndex, level]. Pre-allocate to avoid resize on
    // shallow trees (the common case for typical document layouts).
    const stack: number[] = new Array(128)
    let sp = 0   // stack pointer (next free slot)

    // Push root — always the single node at levelBounds[numLevels - 1].
    stack[sp++] = levelBounds[numLevels - 1]!
    stack[sp++] = numLevels - 1

    while (sp > 0) {
      const level   = stack[--sp]!
      const itemIdx = stack[--sp]!
      const off     = itemIdx * STRIDE

      // Spatial predicate on this node's bounding box.
      if (!test(data[off]!, data[off + 1]!, data[off + 2]!, data[off + 3]!)) continue

      if (level === 0) {
        // ── Leaf ────────────────────────────────────────────────────────────
        // sortedNodeIds is indexed by leaf item index, which equals itemIdx
        // for all leaves (they occupy items 0 … n-1).
        results.push(sortedNodeIds[itemIdx]!)
        if (results.length >= maxResults) return
      } else {
        // ── Internal node ───────────────────────────────────────────────────
        // data[off + 4] holds the first child's item index.
        // Children of a level-L node are at level L-1, whose item range is
        // [levelBounds[L-1], levelBounds[L]).  The end of our block is thus
        // min(firstChild + B, levelBounds[level]).
        const firstChild = data[off + 4]! | 0   // truncate to int (stored as float32)
        const childEnd   = Math.min(firstChild + B, levelBounds[level]!)
        const childLevel = level - 1

        for (let c = firstChild; c < childEnd; c++) {
          stack[sp++] = c
          stack[sp++] = childLevel
        }
      }
    }
  }
}