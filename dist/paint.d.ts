import type { BoxRecord, TextLineData, SelectionRange } from './types.js';
/**
 * Paint the selection highlight rects for the current SelectionRange.
 *
 * Must be called AFTER painting the background and box fills, and BEFORE
 * painting text glyphs, so glyphs appear above the highlight.
 *
 * @param ctx               The canvas 2D rendering context.
 * @param sel               The current selection range (from SelectionState.get()).
 * @param recordMap         Map of nodeId → BoxRecord (from engine.getAllRecords()).
 * @param textLineMap       Map of nodeId → TextLineData (from engine.textLineMap).
 * @param orderedTextNodeIds  Document-order array of text/heading node ids.
 * @param scrollY           Current vertical scroll offset (world-space pixels).
 * @param viewportH         Canvas viewport height in CSS pixels (for culling).
 * @param selectionColor    Optional override for the highlight fill color.
 */
export declare function paintSelection(ctx: CanvasRenderingContext2D, sel: SelectionRange, recordMap: ReadonlyMap<string, BoxRecord>, textLineMap: ReadonlyMap<string, TextLineData>, orderedTextNodeIds: readonly string[], scrollY: number, viewportH: number, selectionColor?: string): void;
/** A resolved pixel-space rectangle for one search match. */
export interface SearchMatchRect {
    nodeId: string;
    charStart: number;
    charEnd: number;
    /** Pixel rectangle in world space (scrollY not yet applied). */
    rect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
/**
 * Paint search match highlights for all visible matches.
 *
 * Active match uses orange; all other matches use yellow.
 * Both colors use alpha so text glyphs remain readable.
 *
 * @param ctx             The canvas 2D rendering context.
 * @param matches         All search matches with their pixel rects.
 * @param activeIndex     Index of the currently focused match.
 * @param scrollY         Current vertical scroll offset.
 * @param viewportH       Canvas viewport height in CSS pixels (for culling).
 * @param inactiveColor   Override for non-active match color.
 * @param activeColor     Override for active match color.
 */
export declare function paintSearchHighlights(ctx: CanvasRenderingContext2D, matches: SearchMatchRect[], activeIndex: number, scrollY: number, viewportH: number, inactiveColor?: string, activeColor?: string): void;
/**
 * Paint a 2px focus ring around a focused link's bounding box.
 *
 * Called by the RAF loop when a Shadow Semantic Tree `<a>` element holds
 * keyboard focus and fires the 'focus' event (PRD §7.2).
 *
 * @param ctx         The canvas 2D rendering context.
 * @param record      The BoxRecord for the focused link node.
 * @param scrollY     Current vertical scroll offset.
 * @param accentColor System accent color for the ring (default: Windows blue).
 */
export declare function paintFocusRing(ctx: CanvasRenderingContext2D, record: BoxRecord, scrollY: number, accentColor?: string): void;
/**
 * Convert a character offset range within a text node to a pixel rectangle.
 *
 * Used by the search engine to convert match positions into screen coordinates.
 * Zero measureText() calls — all geometry comes from TextLineData.
 *
 * @param nodeId      The text node's id.
 * @param charStart   Grapheme-counted start offset (inclusive).
 * @param charEnd     Grapheme-counted end offset (exclusive).
 * @param tld         TextLineData for the node.
 * @param record      BoxRecord for the node.
 * @returns           Pixel rect in world space, or null if offsets are invalid.
 */
export declare function charRangeToRect(nodeId: string, charStart: number, charEnd: number, tld: TextLineData, record: BoxRecord): {
    x: number;
    y: number;
    width: number;
    height: number;
} | null;
