import type { TextLineData, SelectionCursor, SelectionRange } from './types.js';
/**
 * Minimal structural interface that LayoutEngine satisfies.
 * Used by getSelectedText() to read TextLineData and document order.
 */
export interface TextLayoutSource {
    /** Per-node segment/line data built during compute(). */
    readonly textLineMap: ReadonlyMap<string, TextLineData>;
    /**
     * Node ids of all text/heading nodes in tree-traversal (document) order.
     * Used to enumerate the selection range across multiple nodes.
     */
    getOrderedTextNodeIds(): readonly string[];
}
/**
 * Singleton selection store owned by LayoutEngine.
 *
 * The canvas RAF loop reads from this object to paint highlight rects.
 * The Proxy Caret reads from it to populate textarea.value on change.
 *
 * onChange listeners are called synchronously inside set() / clear() so the
 * Proxy Caret can be updated before the browser's next event tick.
 */
export declare class SelectionState {
    private range;
    private readonly listeners;
    /** Return the current SelectionRange, or null if nothing is selected. */
    get(): SelectionRange | null;
    /** Replace the current selection. Notifies all onChange listeners. */
    set(range: SelectionRange): void;
    /** Clear the selection. Notifies all onChange listeners. */
    clear(): void;
    /** True when there is no active selection. */
    isEmpty(): boolean;
    /**
     * Subscribe to selection changes (set / clear).
     * Returns an unsubscribe function — call it to remove the listener.
     *
     * @example
     * const off = sel.onChange(() => proxyCaret.syncText())
     * // later:
     * off()
     */
    onChange(fn: () => void): () => void;
    private notify;
}
/**
 * Resolve a canvas-space pixel coordinate to a SelectionCursor.
 *
 * @param nodeId    The node id reported by SpatialIndex.queryPoint().
 * @param localX    Hit X relative to record.x (i.e. canvas hitX − record.x).
 * @param localY    Hit Y relative to record.y (i.e. canvas hitY − record.y).
 * @param tld       TextLineData for the hit node (from LayoutEngine.textLineMap).
 * @returns         SelectionCursor with O(log k) grapheme resolution.
 *
 * Algorithm (PRD §3.3):
 *
 *   1. lineIndex = clamp(floor(localY / lineHeight), 0, lines.length − 1)
 *   2. clamp localX to [0, line.width]
 *   3. Walk segments line.start.segmentIndex … line.end.segmentIndex,
 *      accumulating accX using pre-measured widths. No measureText() called.
 *   4. For the hit segment:
 *        a. If breakablePrefixWidths[si] is non-null: binary search the array
 *           to find the largest grapheme index k where the cumulative prefix
 *           width ≤ (localX − accX) + base, where base corrects for a
 *           segment whose first line starts mid-segment (graphemeIndex > 0).
 *           O(log graphemes_in_segment) ≈ O(log 15) ≈ 4 comparisons.
 *        b. Otherwise (single-grapheme or non-breakable segment): snap to the
 *           grapheme boundary closer to localX.
 *   5. Return SelectionCursor { nodeId, lineIndex, segmentIndex, graphemeIndex,
 *      pixelX }.
 */
export declare function resolvePixelToCursor(nodeId: string, localX: number, localY: number, tld: TextLineData): SelectionCursor;
/**
 * Width contributed by segment `si` on a line, accounting for partial segments
 * (startGi > 0 when a long word was broken mid-segment onto this line, or
 *  endGi > 0 when the segment is truncated at the line's end cursor).
 *
 * Falls back to prepared.widths[si] when breakablePrefixWidths[si] is null
 * (single-grapheme or non-breakable segments are never split mid-grapheme).
 */
export declare function segmentWidthOnLine(prepared: import('@chenglou/pretext').PreparedTextWithSegments, si: number, startGi: number, // inclusive
endGi: number): number;
/**
 * Normalise a SelectionRange so that `start` is always document-earlier than
 * `end`, returning [start, end, isReversed].
 *
 * Document order is determined by the `orderedIds` array (the engine's
 * getOrderedTextNodeIds() result). Within the same node, line/segment/grapheme
 * indices determine order.
 */
export declare function normalizeSelection(range: SelectionRange, orderedIds: readonly string[]): [start: SelectionCursor, end: SelectionCursor, reversed: boolean];
/**
 * Extract the plain-text string covered by the current selection.
 *
 * Walks the in-memory TextLineData map — no DOM reads, no measureText() calls.
 * This is called once on mouseup / Ctrl+C, not in the mousemove hot path.
 *
 * @param range       The selection range to extract (use state.get() if needed).
 * @param source      A TextLayoutSource (LayoutEngine satisfies this structurally).
 */
export declare function getSelectedText(range: SelectionRange, source: TextLayoutSource): string;
/**
 * Convert a grapheme-counted character offset into a SelectionCursor.
 *
 * Used by LayoutEngine.setSelection() and the mobile long-press Proxy Caret
 * sync path (PRD §6.3, Step 5).
 *
 * The `charOffset` is counted in Pretext grapheme units — matching the same
 * model as SelectionCursor.graphemeIndex. Walk segments in line order until
 * the cumulative count reaches the target.
 */
export declare function charOffsetToCursor(prepared: import('@chenglou/pretext').PreparedTextWithSegments, charOffset: number, tld: TextLineData): SelectionCursor;
/**
 * Convert a (lineIndex, segmentIndex, graphemeIndex) triple into a
 * SelectionCursor with a pre-computed pixelX.
 *
 * Called by charOffsetToCursor and the word-expansion logic in mouse.ts.
 * Pre-computes pixelX by walking segment widths from the line start to `si`,
 * then querying breakablePrefixWidths — zero measureText() calls.
 */
export declare function segmentIndexToCursor(tld: TextLineData, lineIndex: number, si: number, gi: number, prepared?: import('@chenglou/pretext').PreparedTextWithSegments): SelectionCursor;
