import type { Node, BoxRecord, LayoutOptions, TextLineData } from './types.js';
import { SpatialIndex } from './rtree.js';
import { SelectionState } from './selection.js';
export declare class LayoutEngine {
    private root;
    private options;
    private pretext;
    /**
     * Per-node segment/line data. Populated by compute() for every text/heading
     * node when Pretext is available. The selection engine reads this during
     * mousemove without calling measureText(). Satisfies TextLayoutSource.
     */
    readonly textLineMap: Map<string, TextLineData>;
    /**
     * Node ids of text/heading nodes in document (depth-first tree) order.
     * Populated during compute(). Used by normalizeSelection() and paintSelection().
     */
    private _orderedTextNodeIds;
    /** Last compute() result — stored so buildIndex() can read it off the hot path. */
    private _lastRecords;
    /** Spatial R-Tree index. Null until buildIndex() resolves. */
    private _spatialIndex;
    /** True once buildIndex() has completed successfully. */
    private _indexReady;
    /**
     * Hit-tests queued while the index was still building.
     * Replayed immediately after buildIndex() resolves.
     */
    private _pendingHitTests;
    /** Singleton selection state. Read by the canvas RAF loop and Proxy Caret. */
    readonly selection: SelectionState;
    constructor(root: Node, options?: LayoutOptions);
    /**
     * Inject a pre-loaded Pretext module for synchronous text measurement.
     * Must be called before compute() for selection support to work.
     */
    usePretext(mod: typeof import('@chenglou/pretext')): this;
    /**
     * Compute the layout. Returns a flat array of positioned BoxRecords.
     *
     * v0.2: Also populates `textLineMap` and `_orderedTextNodeIds` for every
     * text/heading node that has Pretext available. Invalidates the spatial index —
     * call buildIndex() after re-computing.
     */
    compute(): BoxRecord[];
    /**
     * Build the Spatial R-Tree index from the last compute() result.
     *
     * Runs off the critical path via requestIdleCallback (fallback: setTimeout).
     * Returns a Promise that resolves when the index is ready. Hit-tests
     * that arrive before this resolves are queued and replayed automatically.
     */
    buildIndex(): Promise<void>;
    /** All BoxRecords from the last compute(), in tree-traversal order. */
    getAllRecords(): BoxRecord[];
    /**
     * TextLineData for a specific text or heading node.
     * Returns null for non-text nodes or when Pretext was unavailable.
     */
    getTextLineData(nodeId: string): TextLineData | null;
    /**
     * Node ids of all text/heading nodes in document order.
     * Satisfies the TextLayoutSource interface used by selection helpers.
     */
    getOrderedTextNodeIds(): readonly string[];
    /** The spatial R-Tree index. Null until buildIndex() resolves. */
    get spatialIndex(): SpatialIndex | null;
    /**
     * Async hit-test. If the index isn't ready yet, queues the query
     * and resolves when buildIndex() completes.
     *
     * @param x  World X (canvas-space, scrollY already added by caller).
     * @param y  World Y (canvas-space, scrollY already added by caller).
     */
    queryPoint(x: number, y: number, maxResults?: number): Promise<string[]>;
    /**
     * Programmatically set the selection to a character range.
     * startChar / endChar are grapheme-counted offsets into the node's text.
     * No-op if the node ids are not found in textLineMap.
     */
    setSelection(startNodeId: string, startChar: number, endNodeId: string, endChar: number): void;
    /** Clear the active selection. */
    clearSelection(): void;
    /**
     * Copy the currently selected text to the OS clipboard.
     * Returns false when nothing is selected or clipboard API is unavailable.
     */
    copySelectedText(): Promise<boolean>;
    /**
     * Extract the plain text of the entire layout tree in document order.
     * Each visual line is separated by a newline.
     */
    extractText(): string;
    private ctx;
    private solveNode;
    /**
     * Solve a text node, building TextLineData alongside the BoxRecord.
     *
     * Prefers measureTextWithLinesSync() — produces TextLineData with zero extra
     * measureText() calls at runtime. Falls back to measureTextSync() when
     * Pretext is unavailable (node becomes non-selectable).
     */
    private solveTextNode;
    /**
     * Solve a heading node. Headings are measured identically to text nodes;
     * the level surfaces in the Shadow Semantic Tree (Phase 3).
     */
    private solveHeadingNode;
    private measureNode;
}
/**
 * Create a LayoutEngine for a node tree.
 *
 * @example
 * const engine = createLayout(root).usePretext(pretext)
 * const boxes = engine.compute()
 * await engine.buildIndex()
 */
export declare function createLayout(root: Node, options?: LayoutOptions): LayoutEngine;
