import type { GridNode, BoxRecord } from './types.js';
import { type SolverContext } from './utils.js';
export interface GridResult {
    records: BoxRecord[];
    width: number;
    height: number;
}
export declare function solveGrid(node: GridNode, nodeId: string, containerWidth: number, containerHeight: number, ctx: SolverContext): GridResult;
export declare function measureGridSize(node: GridNode, containerWidth: number, containerHeight: number, ctx: SolverContext): {
    width: number;
    height: number;
};
