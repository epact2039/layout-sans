import type { MagazineNode, BoxRecord } from './types.js';
import { type SolverContext } from './utils.js';
export interface MagazineResult {
    records: BoxRecord[];
    width: number;
    height: number;
}
export declare function solveMagazine(node: MagazineNode, nodeId: string, containerWidth: number, containerHeight: number, ctx: SolverContext, pretext: typeof import('@chenglou/pretext') | null): MagazineResult;
