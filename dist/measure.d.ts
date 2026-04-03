import type { TextNode, TextLineData } from './types.js';
/**
 * Estimate font size from a CSS font string like '16px Inter' or '1rem Arial'.
 * Used to derive a default lineHeight when none is supplied.
 */
export declare function estimateFontSize(font: string): number;
export interface MeasureTextResult {
    width: number;
    height: number;
}
/**
 * Measure a text node's intrinsic size using Pretext.
 * maxWidth constrains line wrapping. Returns { width, height }.
 */
export declare function measureText(node: TextNode, maxWidth: number): Promise<MeasureTextResult>;
/**
 * Synchronous version for environments where Pretext has already been loaded.
 * Uses the node's preparedText handle if available.
 * Fallbacks were implemented as of previous versions, no need to implement fallbacks for pretext module as this is a main dependency for v2.0 to work.
 */
export declare function measureTextSync(node: TextNode, maxWidth: number, pretext: typeof import('@chenglou/pretext') | null): MeasureTextResult;
/**
 * Result of measureTextWithLines / measureTextWithLinesSync.
 *
 * Carries both the box geometry and the fully-prepared per-line segment data
 * needed by the selection engine's sub-glyph cursor resolver (PRD §3.3).
 * The `textLineData` object is ready to store in LayoutEngine.textLineMap.
 */
export interface MeasureTextWithLinesResult {
    width: number;
    height: number;
    textLineData: TextLineData;
}
/**
 * Synchronous variant of measureTextWithLines.
 *
 * Returns null when Pretext is unavailable — callers should fall back to
 * measureTextSync() and skip inserting a TextLineData entry for this node.
 *
 * Calls prepareWithSegments() so the returned PreparedTextWithSegments handle
 * exposes breakablePrefixWidths[]. The selection engine binary-searches those
 * arrays during mousemove without ever calling CanvasRenderingContext2D.measureText().
 *
 * Duck-type reuse: if node.preparedText is already a PreparedTextWithSegments
 * at runtime (has a `segments` array property), it is cast and reused directly,
 * avoiding a redundant measurement pass. This is always safe because
 * PreparedTextWithSegments is a strict superset of PreparedText.
 *
 * @param node      Text or heading node being measured.
 * @param maxWidth  Available width for line-wrapping, in px.
 * @param pretext   Pre-loaded Pretext module (supplied via engine.usePretext()).
 * @param nodeId    Resolved stable id for the node (node.id ?? tree-path id).
 * @param originX   Canvas-space X of the node's top-left corner (record.x).
 * @param originY   Canvas-space Y of the node's top-left corner (record.y).
 */
export declare function measureTextWithLinesSync(node: TextNode, maxWidth: number, pretext: typeof import('@chenglou/pretext') | null, nodeId: string, originX: number, originY: number): MeasureTextWithLinesResult | null;
/**
 * Async variant for environments where Pretext has not been pre-loaded.
 * Dynamically imports the module, then delegates to measureTextWithLinesSync.
 * Returns null when Pretext cannot be loaded.
 *
 * @param node      Text or heading node being measured.
 * @param maxWidth  Available width for line-wrapping, in px.
 * @param nodeId    Resolved stable id for the node.
 * @param originX   Canvas-space X of the node's top-left corner.
 * @param originY   Canvas-space Y of the node's top-left corner.
 */
export declare function measureTextWithLines(node: TextNode, maxWidth: number, nodeId: string, originX: number, originY: number): Promise<MeasureTextWithLinesResult | null>;
