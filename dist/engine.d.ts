import type { Node, BoxRecord, LayoutOptions } from './types.js';
export declare class LayoutEngine {
    private root;
    private options;
    private pretext;
    constructor(root: Node, options?: LayoutOptions);
    /**
     * Inject a pre-loaded Pretext module for synchronous text measurement.
     * Call this before compute() if you want accurate text sizing.
     */
    usePretext(mod: typeof import('@chenglou/pretext')): this;
    /**
     * Compute the layout. Returns a flat array of positioned BoxRecords.
     * Each record maps to one node in the input tree via nodeId.
     */
    compute(): BoxRecord[];
    private ctx;
    private solveNode;
    private measureNode;
}
/**
 * Create a LayoutEngine for a node tree.
 * Call .compute() to get the flat BoxRecord[].
 *
 * @example
 * const engine = createLayout(root)
 * const boxes = engine.compute()
 */
export declare function createLayout(root: Node, options?: LayoutOptions): LayoutEngine;
