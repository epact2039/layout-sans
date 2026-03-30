import type { PreparedText } from '@chenglou/pretext';
/** Final output record for a single node. Flat array of these from engine.compute(). */
export interface BoxRecord {
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
interface BaseNode {
    /** Optional stable id. Auto-assigned as tree path ('0', '0.1', '0.1.2') if omitted. */
    id?: string;
    /** Fixed width in px. Required for root. Optional for children (can be flex-grown). */
    width?: number;
    /** Fixed height in px. Required for root unless content-sized. Optional for children. */
    height?: number;
    /** Minimum width constraint in px. */
    minWidth?: number;
    /** Maximum width constraint in px. */
    maxWidth?: number;
    /** Minimum height constraint in px. */
    minHeight?: number;
    /** Maximum height constraint in px. */
    maxHeight?: number;
    /** Uniform padding inside this box, in px. */
    padding?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    /** Outer margin, in px. */
    margin?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    /** Flex child: proportion of remaining space to grow into. */
    flex?: number;
    /** Flex child: weight of space to give up when container overflows. Default 1. */
    flexShrink?: number;
    /** Flex child: base size before grow/shrink is applied. */
    flexBasis?: number;
}
/** A flex container. Children are laid out in a row or column. */
export interface FlexNode extends BaseNode {
    type: 'flex';
    /** Main axis direction. Default: 'row'. */
    direction?: 'row' | 'column';
    /** Gap between children in px. */
    gap?: number;
    /** Row gap (overrides gap for cross-axis direction). */
    rowGap?: number;
    /** Column gap (overrides gap for main-axis direction). */
    columnGap?: number;
    /** How children are distributed along the main axis. */
    justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
    /** How children are aligned along the cross axis. */
    alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
    /** Self-alignment override (applied on the child, not parent). */
    alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'auto';
    /** Whether children wrap onto new lines. */
    wrap?: boolean;
    children?: Node[];
}
/** A plain box with no children. Size comes from width/height or flex growth. */
export interface BoxNode extends BaseNode {
    type: 'box';
}
/** A text node measured via Pretext. */
export interface TextNode extends BaseNode {
    type: 'text';
    /** The string to measure and lay out. */
    content: string;
    /**
     * A PreparedText handle from `@chenglou/pretext` (result of prepare()).
     * Provide this OR content+font — if both are given, preparedText wins.
     */
    preparedText?: PreparedText;
    /** Font string as passed to Pretext's prepare(), e.g. '16px Inter'. */
    font?: string;
    /** Line height in px. Default: fontSize * 1.4 (estimated from font string). */
    lineHeight?: number;
}
/** An absolutely positioned box. Coordinates relative to nearest non-static ancestor. */
export interface AbsoluteNode extends BaseNode {
    type: 'absolute';
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    children?: Node[];
}
/** A basic grid container (1D: rows OR columns for MVP). */
export interface GridNode extends BaseNode {
    type: 'grid';
    /** Number of equal-width columns. */
    columns?: number;
    /** Number of equal-height rows. */
    rows?: number;
    /** Gap between cells. */
    gap?: number;
    rowGap?: number;
    columnGap?: number;
    children?: Node[];
}
/** A magazine-style multi-column text flow container. */
export interface MagazineNode extends BaseNode {
    type: 'magazine';
    /** Number of columns to flow text across. */
    columnCount: number;
    /** Gap between columns in px. Default 16. */
    columnGap?: number;
    /** Content to flow. Can be plain text or TextNodes. */
    children?: TextNode[];
    /** Convenience: single string content (creates one implicit TextNode). */
    content?: string;
    /** Font for text measurement. */
    font?: string;
    /** Line height in px. */
    lineHeight?: number;
}
export type Node = FlexNode | BoxNode | TextNode | AbsoluteNode | GridNode | MagazineNode;
export interface ResolvedNode {
    id: string;
    node: Node;
    resolvedWidth: number;
    resolvedHeight: number;
    children: ResolvedNode[];
    x: number;
    y: number;
}
export interface LayoutOptions {
    /** Root width in px. Overrides node.width if provided. */
    width?: number;
    /** Root height in px. Overrides node.height if provided. */
    height?: number;
}
export {};
