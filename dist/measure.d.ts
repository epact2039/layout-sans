import type { TextNode } from './types.js';
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
 */
export declare function measureTextSync(node: TextNode, maxWidth: number, pretext: typeof import('@chenglou/pretext') | null): MeasureTextResult;
