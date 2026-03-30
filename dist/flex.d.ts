import type { FlexNode, BoxRecord } from './types.js';
import { type SolverContext } from './utils.js';
export interface FlexResult {
    records: BoxRecord[];
    /** Computed container width (useful when container is content-sized). */
    width: number;
    /** Computed container height. */
    height: number;
}
export declare function solveFlex(node: FlexNode, nodeId: string, containerWidth: number, containerHeight: number, ctx: SolverContext): FlexResult;
export declare function solveFlexColumn(node: FlexNode, nodeId: string, containerWidth: number, ctx: SolverContext): {
    records: BoxRecord[];
    totalHeight: number;
} | null;
export declare function solveFlexRow(node: FlexNode, nodeId: string, containerHeight: number, ctx: SolverContext): {
    records: BoxRecord[];
    totalWidth: number;
} | null;
export declare function measureFlexSize(node: FlexNode, containerWidth: number, containerHeight: number, ctx: SolverContext): {
    width: number;
    height: number;
};
