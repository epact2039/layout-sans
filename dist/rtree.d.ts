import type { BoxRecord } from './types.js';
export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
export declare class SpatialIndex {
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
    private readonly treeData;
    /**
     * levelBounds[i] is the item index (not byte offset) where level i starts.
     * Level 0 = leaves, level numLevels-1 = root (single node).
     * Last element is a sentinel equal to total item count.
     */
    private readonly levelBounds;
    /**
     * nodeId for each leaf, in STR-sorted order.
     * Indexed by leaf item index (0 … n-1), so queryPoint/queryRect can return
     * the nodeId with a single array read — no secondary lookup needed.
     */
    private readonly sortedNodeIds;
    /** O(1) record lookup keyed by nodeId. Built once, never mutated. */
    private readonly byId;
    constructor(records: BoxRecord[]);
    /**
     * Point hit-test.
     *
     * Returns the nodeIds of up to `maxResults` records whose bounding box
     * contains the point (x, y). Default maxResults = 1 for the cursor hot path.
     *
     * Complexity: O(log₁₆ n) comparisons in the best case (non-overlapping layout);
     * O(k · log n) where k is the number of hits in pathological overlap cases.
     */
    queryPoint(x: number, y: number, maxResults?: number): string[];
    /**
     * Rectangular range query.
     *
     * Returns all nodeIds whose bounding box overlaps the given bbox.
     * Two bboxes "overlap" if they share any area, including touching edges.
     */
    queryRect(bbox: BBox): string[];
    /**
     * O(1) record lookup by nodeId.
     *
     * Returns null if nodeId was not in the records array passed to the constructor.
     */
    getRecord(nodeId: string): BoxRecord | null;
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
    private traverse;
}
