import type { Node, BoxRecord } from './types.js';
export interface PaddingBox {
    top: number;
    right: number;
    bottom: number;
    left: number;
}
export declare function getPaddingBox(node: Node): PaddingBox;
/** Read width or height from a node, returning NaN if not fixed. */
export declare function resolveNodeSize(node: Node, axis: 'width' | 'height', _containerSize: number): number;
/** Clamp a value between optional min/max. */
export declare function clampSize(value: number, min?: number, max?: number): number;
/**
 * The engine passes a SolverContext into each solver so they can recursively
 * lay out child nodes without creating circular imports.
 */
export interface SolverContext {
    /**
     * Recursively solve a child node at the given position and size.
     * Returns the flat list of BoxRecords produced by that subtree.
     */
    solveNode(node: Node, nodeId: string, x: number, y: number, width: number, height: number): BoxRecord[];
    /**
     * Measure a node to get its intrinsic size without fully solving it.
     * Used by flex cross-axis content-sizing.
     */
    measureNode(node: Node, nodeId: string, availableWidth: number, availableHeight: number): {
        width: number;
        height: number;
    };
}
