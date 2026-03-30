import type { AbsoluteNode, BoxRecord } from './types.js';
import { type SolverContext } from './utils.js';
export interface AbsoluteResult {
    records: BoxRecord[];
    width: number;
    height: number;
    /** Resolved absolute x position of this container — exposed for engine.ts Bug #1 fix */
    x: number;
    /** Resolved absolute y position of this container */
    y: number;
}
export declare function solveAbsolute(node: AbsoluteNode, nodeId: string, containerX: number, containerY: number, containerWidth: number, containerHeight: number, ctx: SolverContext): AbsoluteResult;
